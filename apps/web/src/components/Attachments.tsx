import { useEffect, useState } from "react";
import type { Attachment } from "@vektor/shared";
import type { ApiClient } from "../lib/api";

export function AttachmentPreview({
  file,
  client,
  onClose,
}: {
  file: Attachment;
  client: ApiClient;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    void client
      .attachmentContent(file.id)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((error) => {
        if (active) setError(error instanceof Error ? error.message : "Preview failed.");
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, file.id]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${file.filename}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6"
    >
      <div className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-xl border border-white/20 bg-slate-900 p-5 text-slate-100">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="break-all font-semibold">{file.filename}</h2>
          <button
            autoFocus
            type="button"
            onClick={onClose}
            className="rounded border border-white/20 px-3 py-1"
          >
            Close preview
          </button>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        {file.kind === "image" ? (
          url ? (
            <img src={url} alt={file.filename} className="max-h-[60vh] max-w-full object-contain" />
          ) : (
            <p>Loading image…</p>
          )
        ) : (
          <>
            <p className="mb-2 text-xs text-slate-400">
              Extracted text preview · first 4,000 characters
            </p>
            <pre className="whitespace-pre-wrap break-words text-sm">{file.textPreview}</pre>
          </>
        )}
        {url ? (
          <a
            href={url}
            download={file.filename}
            className="mt-4 inline-block text-sm text-emerald-300 underline"
          >
            Download original
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function MessageAttachments({ files, client }: { files: Attachment[]; client: ApiClient }) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        {files.map((file) => (
          <button
            key={file.id}
            type="button"
            onClick={() => setPreview(file)}
            className="rounded border border-current/20 px-2 py-1 text-xs"
          >
            {file.kind === "image" ? "Image: " : "File: "}
            {file.filename}
          </button>
        ))}
      </div>
      {preview ? (
        <AttachmentPreview file={preview} client={client} onClose={() => setPreview(null)} />
      ) : null}
    </>
  );
}
