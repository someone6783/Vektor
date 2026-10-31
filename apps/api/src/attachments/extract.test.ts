import { describe, expect, it } from "vitest";
import { extractAttachment } from "./extract.js";
import { docxFixture, pdfFixture, PNG } from "./fixtures.test-utils.js";

describe("attachment extraction", () => {
  it("extracts PDF and DOCX text using the document workers", async () => {
    expect((await extractAttachment("report.pdf", pdfFixture())).extractedText).toContain(
      "PDF context sample",
    );
    expect((await extractAttachment("report.docx", await docxFixture())).extractedText).toContain(
      "DOCX context sample",
    );
  }, 20_000);

  it("rejects PDFs without a text layer and corrupt documents", async () => {
    await expect(extractAttachment("scan.pdf", pdfFixture(""))).rejects.toThrow("OCR");
    await expect(extractAttachment("broken.pdf", Buffer.from("not a PDF"))).rejects.toThrow(
      "Invalid PDF",
    );
    await expect(extractAttachment("broken.docx", Buffer.from("PKbroken"))).rejects.toThrow();
  }, 20_000);

  it("validates image signatures and UTF-8 text rather than trusting MIME", async () => {
    expect(await extractAttachment("pixel.png", PNG)).toMatchObject({
      kind: "image",
      mime: "image/png",
      width: 1,
      height: 1,
    });
    await expect(extractAttachment("pixel.jpg", PNG)).rejects.toThrow("match its extension");
    await expect(extractAttachment("payload.png", Buffer.from("not an image"))).rejects.toThrow();
    await expect(extractAttachment("binary.txt", Buffer.from([0xff, 0xfe]))).rejects.toThrow(
      "UTF-8",
    );
    await expect(extractAttachment("binary.txt", Buffer.from("\0"))).rejects.toThrow("Binary");
    await expect(extractAttachment("empty.txt", Buffer.alloc(0))).rejects.toThrow("Empty");
    await expect(extractAttachment("script.svg", Buffer.from("<svg/>"))).rejects.toThrow(
      "Unsupported",
    );
  });
});
