import { useEffect, useRef, useState } from "react";
import type { Run, RunDetails } from "@vektor/shared";
import type { ApiClient } from "../lib/api";
import { BrowserPanel } from "./BrowserPanel";
import { ComputerPanel } from "./ComputerPanel";
import { mcpToolLabel } from "../lib/mcp";

function McpArtifact({ client, output }: { client: ApiClient; output: string }) {
  const [text, setText] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [deleted, setDeleted] = useState(false);
  let id: string | undefined;
  try {
    const value = JSON.parse(output) as { artifactId?: unknown };
    if (typeof value.artifactId === "string" && /^[a-f0-9-]{36}$/.test(value.artifactId))
      id = value.artifactId;
  } catch {
    /* A normal tool result has no artifact. */
  }
  if (!id || deleted) return null;
  const artifactId = id;
  return (
    <div className="my-2 text-xs">
      <button
        onClick={() => {
          void client
            .mcpArtifact(artifactId)
            .then((r) => setText(r.text))
            .catch((e) => setError(e.message));
        }}
      >
        View full MCP result
      </button>
      <button
        className="ml-3"
        onClick={() => {
          void client
            .removeMcpArtifact(artifactId)
            .then(() => {
              setText(null);
              setDeleted(true);
            })
            .catch((e) => setError(e.message));
        }}
      >
        Delete MCP artifact
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {text !== null ? (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all">{text}</pre>
      ) : null}
    </div>
  );
}

export function RunTimeline({
  client,
  channelId,
  version,
  onRetry,
}: {
  client: ApiClient;
  channelId: string;
  version: number;
  onRetry: (id: string) => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState("");
  const [details, setDetails] = useState<RunDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const cursorLoaded = useRef(false);
  useEffect(() => {
    let active = true;
    const update = async () => {
      try {
        const result = await client.listRuns(channelId);
        const id = selected || result.runs[0]?.id;
        const next = id ? await client.runDetails(id) : null;
        if (active) {
          setRuns((value) => [
            ...result.runs,
            ...value.filter((run) => !result.runs.some((item) => item.id === run.id)),
          ]);
          if (!cursorLoaded.current) {
            setBefore(result.nextBefore);
            cursorLoaded.current = true;
          }
          setDetails(next);
          setError(null);
        }
      } catch (error) {
        if (active)
          setError(error instanceof Error ? error.message : "Unable to load run history.");
      }
    };
    void update();
    const timer = setInterval(() => void update(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, channelId, selected, version]);
  const more = async () => {
    if (!before) return;
    try {
      const result = await client.listRuns(channelId, before);
      setRuns((value) => [
        ...value,
        ...result.runs.filter((run) => !value.some((item) => item.id === run.id)),
      ]);
      setBefore(result.nextBefore);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to load history.");
    }
  };
  return (
    <details className="run-timeline max-h-64 shrink-0 overflow-auto border-b border-white/10 px-6 py-2 text-xs">
      <summary className="cursor-pointer text-slate-400">Run timeline and tool calls</summary>
      {error ? (
        <p role="alert" className="mt-2 text-rose-300">
          {error}
        </p>
      ) : null}
      <div className="my-2 flex gap-2">
        <select
          aria-label="Inspect run"
          value={selected || runs[0]?.id || ""}
          onChange={(event) => {
            setSelected(event.target.value);
            setDetails(null);
          }}
          className="min-w-0 flex-1 rounded border border-white/10 bg-slate-950 p-1"
        >
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {new Date(run.startedAt).toLocaleTimeString()} · {run.status} · {run.runner} ·{" "}
              {run.terminalMode} · {run.id.slice(0, 8)}
            </option>
          ))}
        </select>
        {before ? (
          <button type="button" onClick={() => void more()}>
            Earlier runs
          </button>
        ) : null}
      </div>
      {details ? (
        <>
          <p className="mb-2 text-slate-400">
            {details.run.status} · {details.run.runner} · {details.run.model} ·{" "}
            {details.run.terminalMode}
            {details.run.error ? ` · ${details.run.error}` : ""}
          </p>
          {details.run.harness ? (
            <div className="mb-2 break-all text-xs text-slate-400">
              <p>
                {details.run.harness.interface} · agent {details.run.harness.agentVersion} ·{" "}
                {details.run.harness.state}
              </p>
              <p>
                Session {details.run.harness.sessionId ?? "starting"} · Turn{" "}
                {details.run.harness.turnId ?? "unavailable"} · Cursor {details.run.harness.cursor}
              </p>
              <p>
                {details.run.usage
                  ? "Harness-reported token usage; billing/cost is unavailable."
                  : "Token usage and billing metrics are unavailable for this agent turn."}
              </p>
              {details.run.status !== "running" ? (
                <button
                  className="mt-1"
                  onClick={() => {
                    void client
                      .removeRunnerCheckpoint(details.run.id)
                      .catch((cause) =>
                        setError(
                          cause instanceof Error ? cause.message : "Unable to delete checkpoint.",
                        ),
                      );
                  }}
                >
                  Delete saved agent session
                </button>
              ) : null}
            </div>
          ) : null}
          {details.run.status !== "running" ? (
            <button
              type="button"
              onClick={() => onRetry(details.run.id)}
              className="mb-2 text-emerald-300"
            >
              Retry this run
            </button>
          ) : null}
          {details.tools.map((tool) => (
            <details key={tool.id} className="mb-2 rounded border border-white/10 p-2">
              <summary className="cursor-pointer">
                {mcpToolLabel(tool.name, tool.input)} · {tool.status}
              </summary>
              <pre className="my-2 whitespace-pre-wrap break-all text-[11px]">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all text-[11px] text-slate-400">
                {tool.output || "Waiting for output…"}
              </pre>
              {tool.name.startsWith("vektor_mcp_") ? (
                <McpArtifact client={client} output={tool.output} />
              ) : null}
              {details.events
                .filter((e) => e.type === "tool.progress" && e.toolCallId === tool.id)
                .map((e) => (
                  <p key={e.seq} className="text-xs text-slate-400">
                    {e.type === "tool.progress" ? JSON.stringify(e.detail) : ""}
                  </p>
                ))}
            </details>
          ))}
          {details.tools.some((tool) => tool.name.startsWith("browser")) ||
          (details.run.status === "running" &&
            details.browser?.mode &&
            details.browser.mode !== "off") ? (
            <BrowserPanel
              key={details.run.id}
              client={client}
              runId={details.run.id}
              active={details.run.status === "running"}
            />
          ) : null}
          {details.tools.some((tool) => tool.name.startsWith("computer")) ||
          (details.run.status === "running" &&
            details.computer?.mode &&
            details.computer.mode !== "off") ? (
            <ComputerPanel
              key={`computer-${details.run.id}`}
              client={client}
              runId={details.run.id}
              active={details.run.status === "running"}
            />
          ) : null}
          <ol className="space-y-1 text-[10px] text-slate-500">
            {details.events.map((event) => (
              <li key={event.seq}>
                {event.seq} · {event.type}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="text-slate-500">No runs yet.</p>
      )}
    </details>
  );
}
