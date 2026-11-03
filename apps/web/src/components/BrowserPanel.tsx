import { useEffect, useState } from "react";
import {
  browserInputSchema,
  type BrowserArtifact,
  type BrowserState,
  type BrowserCapabilities,
} from "@vektor/shared";
import type { ApiClient } from "../lib/api";

export function BrowserPanel({
  client,
  runId,
  active,
}: {
  client: ApiClient;
  runId: string;
  active: boolean;
}) {
  const [state, setState] = useState<BrowserState | null>(null);
  const [artifacts, setArtifacts] = useState<BrowserArtifact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState("snapshot");
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const [privateInput, setPrivateInput] = useState(true);
  const [image, setImage] = useState<Blob | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [capabilities, setCapabilities] = useState<BrowserCapabilities | null>(null);
  useEffect(() => {
    let mounted = true;
    void client
      .browserCapabilities()
      .then((value) => {
        if (mounted) setCapabilities(value);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [client]);
  const load = async () => {
    const result = await client.browserState(runId);
    setState(result.session);
    setArtifacts(result.artifacts);
  };
  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      void client
        .browserState(runId)
        .then((result) => {
          if (mounted) {
            setState(result.session);
            setArtifacts(result.artifacts);
          }
        })
        .catch(() => {
          if (mounted) setError("Unable to load browser session.");
        });
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [client, runId]);
  useEffect(() => {
    if (!image) {
      setImageUrl("");
      return;
    }
    const url = URL.createObjectURL(image);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);
  const perform = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Browser action failed.");
    } finally {
      setBusy(false);
      setText("");
    }
  };
  const input = () =>
    perform(async () => {
      const command = browserInputSchema.parse({
        action,
        ...(["navigate", "new_tab", "download"].includes(action)
          ? { url: target }
          : ["fill", "click", "upload"].includes(action)
            ? { ref: target }
            : {}),
        ...(action === "fill"
          ? { text, privateInput }
          : action === "upload"
            ? { attachmentId: text }
            : action === "download"
              ? { filename: text }
              : {}),
      });
      await client.browserInput(runId, command);
    });
  return (
    <section
      aria-label="Managed browser"
      className="management-page my-3 space-y-2 rounded-lg border border-sky-400/20 p-3"
    >
      <p className="font-medium text-sky-300">
        Managed browser ·{" "}
        {state?.session === "default"
          ? "Default profile"
          : state?.session === "separate"
            ? "Separate session"
            : "Session"}{" "}
        ·{" "}
        {state?.display === "window"
          ? "Visible window"
          : state?.display === "headless"
            ? "Headless"
            : "Browser"}{" "}
        ·{" "}
        {state?.phase === "starting"
          ? "Starting browser…"
          : state?.active
            ? state.paused
              ? "Paused for takeover"
              : "Agent active"
            : state?.phase === "failed"
              ? "Launch failed"
              : "Session closed"}
      </p>
      {state?.display === "window" ? (
        <div className="space-y-2">
          <p className="text-[10px] text-slate-500">
            The Chromium window opens on the backend machine’s desktop. Pause here before
            interacting with it; manual takeover keeps page content private until the session
            closes.
          </p>
          {capabilities && !capabilities.visibleWindowAvailable ? (
            <p role="status" className="text-amber-200">
              {capabilities.reason}
            </p>
          ) : null}
          <button
            disabled={
              busy || !active || capabilities?.visibleWindowAvailable === false || !!state.error
            }
            onClick={() =>
              void perform(() => client.browserControl(runId, state.active ? "focus" : "open"))
            }
            className="text-sky-300 disabled:opacity-40"
          >
            {state.active ? "Focus browser window" : "Open browser window"}
          </button>
        </div>
      ) : null}
      {state?.error ? (
        <p role="alert" className="text-amber-200">
          {state.error}
        </p>
      ) : null}
      {state?.active ? (
        <>
          <p className="break-all text-slate-400">
            {state.url} · {state.actions}/50 actions · {state.tabs.length}/4 tabs
          </p>
          <div className="flex gap-3">
            <button
              disabled={busy || !active || (state.paused && state.sensitive)}
              onClick={() =>
                void perform(() => client.browserControl(runId, state.paused ? "resume" : "pause"))
              }
              className="text-sky-300"
            >
              {state.paused ? "Resume agent" : "Pause and take over"}
            </button>
            <button
              disabled={busy || !active}
              onClick={() => void perform(() => client.browserControl(runId, "close"))}
              className="text-rose-300"
            >
              {state.session === "default" ? "Disconnect session" : "Close and clear session"}
            </button>
          </div>
          <p className="text-[10px] text-slate-500">
            {state.display === "window"
              ? "After pausing, interact directly with the Chromium window or use the controls below."
              : "Takeover uses the managed session’s element references."}{" "}
            It never attaches to your personal browser. The run deadline still applies; an action
            already sent may finish. Network writes still require approval.
          </p>
          {state.paused ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void input();
              }}
              className="flex flex-wrap gap-2"
            >
              <select
                aria-label="Browser takeover action"
                value={action}
                onChange={(event) => {
                  setAction(event.target.value);
                  setText("");
                }}
                className="rounded bg-slate-950 p-1"
              >
                {[
                  "snapshot",
                  "navigate",
                  "new_tab",
                  "click",
                  "fill",
                  "upload",
                  "download",
                  "screenshot",
                ]
                  .filter(
                    (value) =>
                      state.mode === "interactive" ||
                      !["click", "fill", "upload", "download"].includes(value),
                  )
                  .map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
              </select>
              {!["snapshot", "screenshot"].includes(action) ? (
                <input
                  aria-label="Browser takeover target"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  placeholder={
                    ["navigate", "new_tab", "download"].includes(action)
                      ? "Exact allowed URL"
                      : "Element reference"
                  }
                  className="min-w-0 flex-1 rounded bg-slate-950 p-1"
                />
              ) : null}
              {["fill", "upload", "download"].includes(action) ? (
                <input
                  aria-label="Browser takeover value"
                  type={action === "fill" && privateInput ? "password" : "text"}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  autoComplete="off"
                  placeholder={
                    action === "fill"
                      ? "Value (not stored in the timeline)"
                      : action === "upload"
                        ? "Channel attachment ID"
                        : "Document filename"
                  }
                  className="min-w-0 flex-1 rounded bg-slate-950 p-1"
                />
              ) : null}
              {action === "fill" ? (
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={privateInput}
                    onChange={(event) => setPrivateInput(event.target.checked)}
                  />
                  Private input
                </label>
              ) : null}
              <button disabled={busy} className="text-emerald-300">
                Perform action
              </button>
            </form>
          ) : null}
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap text-[10px] text-slate-400">
            {state.snapshot}
          </pre>
          {state.sensitive ? (
            <p className="text-amber-200">
              Private input suppresses page previews and screenshots for the remainder of this
              session.{" "}
              {state.session === "default"
                ? "Disconnect to end takeover. Saved logins remain until you reset the default profile in Settings."
                : "Close it to clear private state."}
            </p>
          ) : null}
        </>
      ) : null}
      {artifacts.length ? (
        <>
          <div className="flex flex-wrap gap-2">
            {artifacts.map((file) => (
              <button
                key={file.id}
                onClick={() =>
                  void perform(async () => setImage(await client.browserArtifact(file.id)))
                }
                className="text-sky-300"
              >
                Screenshot {new Date(file.createdAt).toLocaleTimeString()}
              </button>
            ))}
          </div>
          <button
            onClick={() =>
              void perform(async () => {
                await client.deleteBrowserArtifacts(runId);
                setImage(null);
              })
            }
            className="text-slate-400"
          >
            Delete retained screenshots
          </button>
          <p className="text-[10px] text-slate-500">
            Screenshots are untrusted page content. Form fields are masked. Retention is bounded;
            deleting artifacts does not erase backup copies.
          </p>
        </>
      ) : null}
      {imageUrl ? (
        <img
          src={imageUrl}
          alt="Managed browser screenshot with form fields masked"
          className="max-h-80 rounded border border-white/10"
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-rose-300">
          {error}
        </p>
      ) : null}
    </section>
  );
}
