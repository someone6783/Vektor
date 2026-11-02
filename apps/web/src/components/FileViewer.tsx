import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api";

export function FileViewer({
  client,
  path,
  file,
}: {
  client: ApiClient;
  path: string;
  file: string;
}) {
  const [mode, setMode] = useState<"diff" | "raw">("diff");
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    const request =
      mode === "diff"
        ? client
            .gitDiff(path, file)
            .then((value) => ({ text: value.diff, truncated: value.truncated }))
        : client
            .gitFile(path, file)
            .then((value) => ({ text: value.content, truncated: value.truncated }));
    void request
      .then((value) => {
        if (!cancelled) setResult(value);
      })
      .catch((failure: unknown) => {
        if (!cancelled)
          setError(failure instanceof Error ? failure.message : "Unable to load file.");
      });
    return () => {
      cancelled = true;
    };
  }, [client, path, file, mode, version]);
  return (
    <section className="file-viewer" aria-label={`File ${file}`}>
      <p className="file-viewer-path" title={`${path}/${file}`}>
        {file}
      </p>
      <div className="file-viewer-toolbar" role="group" aria-label="File view">
        <button type="button" aria-pressed={mode === "diff"} onClick={() => setMode("diff")}>
          Diff
        </button>
        <button type="button" aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>
          Raw
        </button>
        <button type="button" onClick={() => setVersion((value) => value + 1)}>
          Refresh
        </button>
      </div>
      <p className="text-xs text-slate-500">
        {mode === "diff"
          ? "Working tree compared with HEAD, including staged changes."
          : "Current working-tree file content."}
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-xs text-rose-300">
          {error}
        </p>
      ) : !result ? (
        <p role="status">Loading…</p>
      ) : (
        <>
          {result.truncated ? (
            <p role="status">Showing the first 256 KiB. Content is truncated.</p>
          ) : null}
          {mode === "diff" && !result.text ? (
            <p className="mt-3 text-xs">No changes compared with HEAD.</p>
          ) : (
            <pre
              className="file-viewer-content"
              aria-label={mode === "diff" ? "File diff" : "Raw file content"}
            >
              <code>
                {mode === "raw"
                  ? result.text
                  : result.text.split("\n").map((line, index, lines) => (
                      <span
                        key={index}
                        className={
                          line.startsWith("+")
                            ? "diff-added"
                            : line.startsWith("-")
                              ? "diff-removed"
                              : line.startsWith("@@")
                                ? "diff-hunk"
                                : undefined
                        }
                      >
                        {line}
                        {index < lines.length - 1 ? "\n" : ""}
                      </span>
                    ))}
              </code>
            </pre>
          )}
        </>
      )}
    </section>
  );
}
