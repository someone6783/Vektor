import { useEffect, useMemo, useRef, useState } from "react";
import { runEventSchema, type RunEvent } from "@vektor/shared";
import { createSseParser } from "../lib/sse";

type StreamStatus = "idle" | "connecting" | "streaming" | "done" | "error";

const TOKEN_STORAGE_KEY = "vektor.accessToken";

const statusStyles: Record<StreamStatus, string> = {
  idle: "border-slate-600 text-slate-400",
  connecting: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  streaming: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  done: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  error: "border-rose-400/30 bg-rose-400/10 text-rose-300",
};

const statusLabels: Record<StreamStatus, string> = {
  idle: "Idle",
  connecting: "Connecting",
  streaming: "Streaming",
  done: "Complete",
  error: "Error",
};

function readStoredToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? import.meta.env.VITE_ACCESS_TOKEN ?? "";
  } catch {
    return import.meta.env.VITE_ACCESS_TOKEN ?? "";
  }
}

function describeEvent(event: RunEvent): string {
  switch (event.type) {
    case "run.started":
      return `runner: ${event.runner}`;
    case "reasoning.delta":
    case "message.delta":
      return JSON.stringify(event.text);
    case "tool.requested":
      return `${event.name} ${JSON.stringify(event.input)}`;
    case "tool.output":
      return event.output;
    case "approval.requested":
      return event.command;
    case "usage":
      return `${event.totalTokens} tokens`;
    case "run.completed":
      return event.messageId ?? "done";
    case "run.failed":
      return event.error;
    case "run.cancelled":
      return event.reason ?? "cancelled";
  }
}

export function StreamDemo() {
  const [token, setToken] = useState(readStoredToken);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    }
  }, [token]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const text = useMemo(
    () =>
      events
        .filter((event) => event.type === "message.delta")
        .map((event) => event.text)
        .join(""),
    [events],
  );

  const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
  const busy = status === "connecting" || status === "streaming";

  const connect = async (resume = false) => {
    if (!token.trim()) {
      setError("Paste the access token from the data directory first.");
      setStatus("error");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (!resume) {
      setEvents([]);
    }

    setError(null);
    setStatus("connecting");

    const resumeAfter = resume ? lastSeq : 0;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      Authorization: `Bearer ${token.trim()}`,
    };

    if (resumeAfter > 0) {
      headers["Last-Event-ID"] = String(resumeAfter);
    }

    try {
      const response = await fetch(
        `/api/dev/stream${resumeAfter > 0 ? `?after=${resumeAfter}` : ""}`,
        { headers, signal: controller.signal },
      );

      if (!response.ok) {
        let message = `Stream request failed with ${response.status}`;

        try {
          const body = (await response.json()) as { error?: { message?: string } };
          if (body.error?.message) {
            message = body.error.message;
          }
        } catch {
          // Keep the status-based message when the body is not JSON.
        }

        throw new Error(message);
      }

      if (!response.body) {
        throw new Error("Streaming is not supported by this browser.");
      }

      setStatus("streaming");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser((frame) => {
        try {
          const event = runEventSchema.parse(JSON.parse(frame.data) as unknown);
          setEvents((previous) => [...previous, event]);
        } catch {
          setError("Received an event that did not match the shared contract.");
        }
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parser.push(decoder.decode(value, { stream: true }));
      }

      parser.push(decoder.decode());

      if (!controller.signal.aborted) {
        setStatus("done");
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        return;
      }

      setError(caught instanceof Error ? caught.message : "Unknown stream error");
      setStatus("error");
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setStatus("idle");
  };

  const clear = () => {
    abortRef.current?.abort();
    setEvents([]);
    setError(null);
    setStatus("idle");
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-5 shadow-2xl shadow-black/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-slate-200">Event stream demo</h2>
          <p className="mt-1 text-xs text-slate-500">
            Proves ordered delivery and resume with <code className="font-mono">Last-Event-ID</code>
            .
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${statusStyles[status]}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {statusLabels[status]}
        </span>
      </div>

      <div className="mt-5">
        <label
          htmlFor="access-token"
          className="text-[11px] font-medium uppercase tracking-wide text-slate-500"
        >
          Access token
        </label>
        <input
          id="access-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Paste the token from /data/access-token"
          autoComplete="off"
          className="mt-2 w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 outline-none transition focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/10"
        />
        <p className="mt-1 text-[11px] text-slate-500">
          Stored in this browser only. The API requires it on every{" "}
          <code className="font-mono">/api/*</code> request.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void connect(false)}
          disabled={busy}
          className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Start stream
        </button>
        <button
          type="button"
          onClick={() => void connect(true)}
          disabled={busy || events.length === 0}
          className="rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Resume after {lastSeq}
        </button>
        <button
          type="button"
          onClick={stop}
          disabled={!busy}
          className="rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Stop
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={events.length === 0 && !error}
          className="rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear
        </button>
      </div>

      {error ? (
        <p className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-xs leading-5 text-rose-200">
          {error}
        </p>
      ) : null}

      <div className="mt-5 rounded-xl border border-white/10 bg-slate-950/80 p-4">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-500">
          <span>Assistant output</span>
          <span>
            {events.length} events · seq {lastSeq}
          </span>
        </div>
        <p className="mt-3 min-h-16 font-mono text-sm leading-6 text-emerald-200">
          {text || <span className="text-slate-600">No deltas yet.</span>}
        </p>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-500">
          <span>Latest frames</span>
          <span>seq / type / payload</span>
        </div>
        <ul className="mt-2 space-y-1">
          {events.length === 0 ? (
            <li className="rounded-lg border border-dashed border-white/10 px-3 py-3 text-xs text-slate-600">
              Start the stream to inspect the event contract.
            </li>
          ) : (
            events.slice(-7).map((event) => (
              <li
                key={`${event.runId}-${event.seq}`}
                className="grid grid-cols-[3rem_9rem_1fr] items-baseline gap-2 rounded-lg bg-white/[0.02] px-3 py-2 font-mono text-[11px]"
              >
                <span className="text-slate-500">{event.seq}</span>
                <span className="truncate text-emerald-300">{event.type}</span>
                <span className="truncate text-slate-400">{describeEvent(event)}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </section>
  );
}
