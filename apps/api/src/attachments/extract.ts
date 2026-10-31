import { extname } from "node:path";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { imageSize } from "image-size";

export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

const MAX_TEXT = 200_000;
const resolveModule = (name: string) =>
  pathToFileURL(createRequire(import.meta.url).resolve(name)).href;
const TEXT_EXTENSIONS = new Set(
  ".txt .md .csv .json .jsonl .js .jsx .ts .tsx .py .rb .go .rs .java .c .h .cpp .cs .css .scss .html .xml .yaml .yml .toml .ini .sql .sh .bash .ps1 .r .swift .kt .vue .svelte .log .tex .env.example".split(
    " ",
  ),
);
const IMAGE_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

// Document parsers run off the API thread with a bounded heap and execution deadline.
const DOCUMENT_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const buffer = Buffer.from(workerData.buffer);
  let text = '';
  if (workerData.extension === '.pdf') {
    const { getDocument } = await import(workerData.pdfModule);
    const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
    try {
      const document = await task.promise;
      if (document.numPages > 500) throw new Error('Documents are limited to 500 pages.');
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        text += content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\\n' : ' ') : '').join('') + '\\n';
        page.cleanup();
        if (text.length > workerData.maxText) throw new Error('Extracted text is too large. Split the document into smaller files.');
      }
    } finally { await task.destroy(); }
    if (!text.trim()) throw new Error('This PDF has no readable text layer. Scanned PDFs need OCR, which is not supported yet.');
  } else {
    const { default: mammoth } = await import(workerData.docxModule);
    text = (await mammoth.extractRawText({ buffer }, { externalFileAccess: false })).value;
    if (!text.trim()) throw new Error('This DOCX contains no readable text.');
  }
  if (text.length > workerData.maxText) throw new Error('Extracted text is too large. Split the document into smaller files.');
  parentPort.postMessage({ text });
})().catch(error => parentPort.postMessage({ error: error.message }));
`;

async function extractDocument(buffer: Buffer, extension: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(DOCUMENT_WORKER, {
      eval: true,
      workerData: {
        buffer,
        extension,
        maxText: MAX_TEXT,
        pdfModule: resolveModule("pdfjs-dist/legacy/build/pdf.mjs"),
        docxModule: resolveModule("mammoth"),
      },
      resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
    });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new AttachmentError("Document extraction timed out. Try a smaller document."));
    }, 15_000);
    worker.once("message", (result: { text?: string; error?: string }) => {
      clearTimeout(timeout);
      void worker.terminate();
      if (result.error || result.text === undefined)
        reject(new AttachmentError(result.error ?? "Document extraction failed."));
      else resolve(result.text);
    });
    worker.once("error", () => {
      clearTimeout(timeout);
      reject(new AttachmentError("Unable to extract this document within the processing limits."));
    });
    worker.once("exit", () => {
      clearTimeout(timeout);
      reject(new AttachmentError("Document extraction stopped before completion."));
    });
  });
}

export async function extractAttachment(
  filename: string,
  buffer: Buffer,
): Promise<{
  kind: "text" | "document" | "image";
  mime: string;
  extractedText: string;
  width?: number;
  height?: number;
}> {
  if (!buffer.length) throw new AttachmentError("Empty files cannot be attached.");
  const extension = extname(filename).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) {
    let size;
    try {
      size = imageSize(buffer);
    } catch {
      throw new AttachmentError("This image is invalid or unsupported.");
    }
    const expected = extension === ".jpeg" ? "jpg" : extension.slice(1);
    if (
      size.type !== expected ||
      !size.width ||
      !size.height ||
      size.width * size.height > 40_000_000
    ) {
      throw new AttachmentError(
        "Image contents must match its extension and be at most 40 megapixels.",
      );
    }
    return {
      kind: "image",
      mime: IMAGE_MIMES[size.type]!,
      extractedText: "",
      width: size.width,
      height: size.height,
    };
  }
  if (extension === ".pdf" || extension === ".docx") {
    if (extension === ".pdf" && !buffer.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw new AttachmentError("Invalid PDF file.");
    if (extension === ".docx" && !buffer.subarray(0, 2).equals(Buffer.from("PK")))
      throw new AttachmentError("Invalid DOCX file.");
    return {
      kind: "document",
      mime:
        extension === ".pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extractedText: await extractDocument(buffer, extension),
    };
  }
  if (
    !TEXT_EXTENSIONS.has(extension) &&
    !["Dockerfile", "Makefile", "LICENSE", "README"].includes(filename)
  ) {
    throw new AttachmentError(
      "Unsupported file type. Upload text/source code, PDF, DOCX, PNG, JPEG, WebP, or GIF.",
      415,
    );
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new AttachmentError("Text files must use UTF-8 encoding.");
  }
  if (text.includes("\0")) throw new AttachmentError("Binary files cannot be read as text.");
  if (text.length > MAX_TEXT)
    throw new AttachmentError(
      "Text files are limited to 200,000 characters. Split this file into smaller parts.",
    );
  return { kind: "text", mime: "text/plain", extractedText: text };
}
