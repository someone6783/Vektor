import { useEffect, useRef, useState } from "react";
import type { GitStatus } from "@vektor/shared";
import type { ApiClient } from "../lib/api";

const STORAGE_KEY = "vektor.git.project-path";

const statusNames: Record<string, string> = {
  A: "added",
  C: "copied",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "type changed",
  U: "conflict",
  "?": "untracked",
};

function codeLabel(file: Pick<GitStatus["files"][number], "index" | "worktree" | "untracked">) {
  if (file.untracked) return "untracked";
  const code = (file.index + file.worktree).trim();
  return statusNames[code.slice(-1)] ?? code;
}

interface GitViewProps {
  client: ApiClient;
  onOpenFile?: (path: string, file: string) => void;
}

export function GitView({ client, onOpenFile }: GitViewProps) {
  const mounted = useRef(true);
  const [path, setPath] = useState(() => window.localStorage.getItem(STORAGE_KEY) ?? "");
  const [activePath, setActivePath] = useState<string | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [filePath, setFilePath] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = async (directory: string) => {
    setError(null);
    setNotice(null);
    if (!directory.trim()) {
      setStatus(null);
      setActivePath(null);
      return;
    }
    if (!(directory.startsWith("/") || /^[a-z]:[\\/]/i.test(directory))) {
      setError("Enter an absolute path to a project directory.");
      return;
    }
    setLoading(true);
    try {
      const result = await client.gitStatus(directory);
      if (!mounted.current) return;
      setStatus(result);
      setActivePath(directory);
      setSelected([]);
      window.localStorage.setItem(STORAGE_KEY, directory);
    } catch (failure) {
      if (mounted.current) {
        setError(failure instanceof Error ? failure.message : "Loading git status failed.");
        setStatus(null);
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  };

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) void load(stored);
    // Load the saved project once when the panel opens.
  }, []);

  const toggle = (path: string) =>
    setSelected((current) =>
      current.includes(path) ? current.filter((value) => value !== path) : [...current, path],
    );

  const commit = async () => {
    if (!activePath || selected.length === 0 || !message.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await client.gitCommit(activePath, message.trim(), selected);
      setMessage("");
      await load(activePath);
      if (mounted.current)
        setNotice(`Committed ${result.commit}${result.branch ? ` on ${result.branch}` : ""}.`);
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : "The commit failed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const push = async () => {
    if (!activePath) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await client.gitPush(activePath);
      await load(activePath);
      if (mounted.current)
        setNotice(
          result.upstream
            ? `Pushed ${result.branch ?? "HEAD"} to ${result.upstream}.`
            : `Pushed ${result.branch ?? "HEAD"}.`,
        );
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : "The push failed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const selectedCount = status
    ? status.files.filter((file) => selected.includes(file.path)).length
    : 0;

  return (
    <div className="git-view">
      <form
        className="context-section"
        onSubmit={(event) => {
          event.preventDefault();
          void load(path.trim());
        }}
      >
        <h3>Project</h3>
        <div className="flex items-center gap-2">
          <input
            aria-label="Project directory"
            className="min-w-0 flex-1 rounded border border-white/10 bg-slate-950 p-1 text-xs"
            placeholder="/home/you/project"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded border border-white/10 px-2 py-1 text-xs"
          >
            Load
          </button>
        </div>
      </form>

      {error ? (
        <p role="alert" className="context-section text-xs text-rose-300">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="context-section text-xs text-accent-300">
          {notice}
        </p>
      ) : null}

      {status && !status.repository ? (
        <p className="context-section text-xs leading-6 text-slate-500">
          This directory is not inside a git repository.
        </p>
      ) : null}

      {status?.repository ? (
        <>
          {onOpenFile ? (
            <form
              className="context-section"
              onSubmit={(event) => {
                event.preventDefault();
                if (activePath && filePath.trim()) onOpenFile(activePath, filePath.trim());
              }}
            >
              <h3>Open file</h3>
              <div className="flex items-center gap-2">
                <input
                  aria-label="Repository file path"
                  placeholder="src/app.ts"
                  value={filePath}
                  onChange={(event) => setFilePath(event.target.value)}
                  className="min-w-0 flex-1 rounded border border-white/10 bg-slate-950 p-1 text-xs"
                />
                <button
                  type="submit"
                  disabled={!filePath.trim()}
                  className="rounded border border-white/10 px-2 py-1 text-xs"
                >
                  Open
                </button>
              </div>
            </form>
          ) : null}
          <div className="context-section">
            <h3>Branch</h3>
            <p className="text-xs leading-6">
              <span className="font-semibold">{status.branch ?? "detached HEAD"}</span>
              {status.upstream ? (
                <span className="text-slate-500">
                  {" "}
                  · {status.upstream}
                  {status.ahead || status.behind
                    ? ` · ${status.ahead ? `${status.ahead} to push` : ""}${
                        status.ahead && status.behind ? ", " : ""
                      }${status.behind ? `${status.behind} to pull` : ""}`
                    : ""}
                </span>
              ) : (
                <span className="text-slate-500"> · no remote branch</span>
              )}
            </p>
            {status.lastCommit ? (
              <p className="text-xs text-slate-500">
                Last commit {status.lastCommit.hash} · {status.lastCommit.subject}
              </p>
            ) : null}
          </div>

          <div className="context-section">
            <h3>
              Changes{status.files.length ? ` (${status.files.length})` : ""}
              {status.filesTruncated ? " — first 500" : ""}
            </h3>
            {status.files.length === 0 ? (
              <p className="text-xs leading-6 text-slate-500">Working tree is clean.</p>
            ) : (
              <ul className="git-file-list" aria-label="Project changes">
                {status.files.map((file) => (
                  <li key={file.path} className="flex items-center gap-2 py-1 text-xs">
                    <input
                      type="checkbox"
                      aria-label={`Stage ${file.path}`}
                      checked={selected.includes(file.path)}
                      onChange={() => toggle(file.path)}
                    />
                    <span
                      aria-hidden="true"
                      className="git-status-code rounded px-1 text-[10px] font-semibold"
                      title={codeLabel(file)}
                    >
                      {(file.index + file.worktree).trim() || ""}
                    </span>
                    <button
                      type="button"
                      className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left"
                      title={`View ${file.path}`}
                      onClick={() => activePath && onOpenFile?.(activePath, file.path)}
                    >
                      {file.path}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {status.files.length ? (
              <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
                <button
                  type="button"
                  onClick={() => setSelected(status.files.map((file) => file.path))}
                >
                  Select all
                </button>
                <button type="button" onClick={() => setSelected([])}>
                  Clear
                </button>
              </div>
            ) : null}
          </div>

          <div className="context-section">
            <h3>Commit</h3>
            <textarea
              aria-label="Commit message"
              rows={2}
              className="w-full rounded border border-white/10 bg-slate-950 p-1 text-xs"
              placeholder="Describe the change…"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void commit();
                }
              }}
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                className="rounded border border-white/10 px-2 py-1 text-xs"
                disabled={busy || selectedCount === 0 || !message.trim()}
                onClick={() => void commit()}
              >
                {busy ? "Working…" : `Commit ${selectedCount || ""}`.trim()}
              </button>
            </div>
          </div>

          <div className="context-section">
            <h3>Push</h3>
            <button
              type="button"
              className="rounded border border-white/10 px-2 py-1 text-xs"
              disabled={busy}
              onClick={() => void push()}
            >
              Push to remote
            </button>
            {!status.upstream ? (
              <p className="mt-1 text-[11px] leading-5 text-slate-500">
                Pushing sets the first upstream for {status.branch ?? "this branch"} on origin.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
