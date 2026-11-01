import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeState } from "@vektor/shared";
import type { ApiClient } from "../lib/api";

export function RuntimeControls({
  client,
  onStoppedChange,
  onActiveRunsChange,
  onError,
}: {
  client: ApiClient;
  onStoppedChange: (stopped: boolean) => void;
  onActiveRunsChange?: (count: number) => void;
  onError: (error: unknown) => void;
}) {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const pendingApprovals = state?.approvals.map((approval) => approval.id).join(",") ?? "";
  useEffect(() => {
    if (menu.current && (pendingApprovals || state?.emergencyStopped || error))
      menu.current.open = true;
  }, [pendingApprovals, state?.emergencyStopped, error]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  const refresh = useCallback(async () => {
    const next = await client.runtime();
    setState(next);
    onStoppedChange(next.emergencyStopped);
    onActiveRunsChange?.(next.activeRuns.length);
  }, [client, onStoppedChange, onActiveRunsChange]);
  useEffect(() => {
    let active = true;
    const update = async () => {
      try {
        const next = await client.runtime();
        if (active) {
          setState(next);
          onStoppedChange(next.emergencyStopped);
          onActiveRunsChange?.(next.activeRuns.length);
          setError(null);
        }
      } catch (error) {
        if (active) {
          setError(error instanceof Error ? error.message : "Runtime request failed.");
          onError(error);
        }
      }
    };
    void update();
    const timer = setInterval(() => void update(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, onStoppedChange, onActiveRunsChange, onError]);
  const action = async (callback: () => Promise<void>) => {
    setWorking(true);
    setError(null);
    try {
      await callback();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Runtime request failed.");
      onError(error);
    } finally {
      setWorking(false);
    }
  };
  return (
    <div
      aria-label="Runtime controls"
      className="relative flex shrink-0 items-center gap-1 text-xs"
    >
      <button
        type="button"
        aria-label="Emergency stop"
        title={
          state?.emergencyStopped
            ? "Execution stopped · Open runtime details to resume"
            : "Emergency stop · Cancel active work and block new runs"
        }
        disabled={working || state?.emergencyStopped}
        onClick={() => void action(() => client.emergencyStop())}
        className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[10px] transition focus-visible:outline focus-visible:outline-rose-300 disabled:opacity-50 ${state?.emergencyStopped ? "bg-rose-400/10 text-rose-200" : "text-slate-500 hover:bg-rose-400/10 hover:text-rose-200"}`}
      >
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="3" y="3" width="10" height="10" rx="2" />
        </svg>
        <span className="hidden xl:inline">
          {state?.emergencyStopped ? "Stopped" : "Emergency stop"}
        </span>
      </button>
      <details
        ref={menu}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }
        }}
      >
        <summary
          aria-label="Runtime details"
          title="Runtime details and command approvals"
          className="flex h-7 cursor-pointer list-none items-center gap-1 rounded-md px-1 text-slate-500 outline-none hover:bg-white/5 hover:text-slate-200 focus-visible:ring-1 focus-visible:ring-emerald-400 [&::-webkit-details-marker]:hidden"
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="3" cy="8" r="1" />
            <circle cx="8" cy="8" r="1" />
            <circle cx="13" cy="8" r="1" />
          </svg>
          {state?.approvals.length ? (
            <span className="rounded bg-amber-300/10 px-1 text-amber-200">
              {state.approvals.length}
            </span>
          ) : null}
        </summary>
        <div className="absolute right-0 top-full z-50 mt-3 max-h-[calc(100dvh-5rem)] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-white/10 bg-slate-900 p-4 text-xs text-slate-300 shadow-xl">
          <h2 className="mb-3 font-medium text-slate-100">Runtime</h2>
          {error ? (
            <p role="alert" className="mb-2 text-rose-300">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            {state?.emergencyStopped ? (
              <span className="text-rose-300">Emergency stop active · New runs blocked</span>
            ) : null}
            <span className="text-slate-500">Execution: {state?.executionEnvironment ?? "…"}</span>
            {!state?.terminalSupported && state ? (
              <span className="text-amber-200">
                Terminal unavailable; use a POSIX/Docker backend.
              </span>
            ) : null}
            <div className="ml-auto flex gap-2">
              {state?.emergencyStopped ? (
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void action(() => client.resumeRuntime())}
                  className="rounded border border-emerald-400/30 px-3 py-1 text-emerald-200"
                >
                  Resume execution
                </button>
              ) : null}
            </div>
          </div>
          {state?.activeRuns.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-slate-300">
                Active runs across all channels
              </summary>
              <ul>
                {state.activeRuns.map((run) => (
                  <li key={run.id} className="mt-2 flex items-center gap-3">
                    <span className="truncate font-mono text-[10px]">
                      {run.id} · {run.model} · {run.terminalMode}
                    </span>
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => void action(() => client.cancelRun(run.id))}
                      className="ml-auto text-rose-200"
                    >
                      Cancel run
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {state?.approvals.map((approval) => (
            <section
              key={approval.id}
              aria-label="Command approval"
              className="mt-2 rounded border border-amber-300/30 bg-amber-300/5 p-3"
            >
              <p className="font-semibold text-amber-200">Approve full-access command?</p>
              <p className="mt-1 text-slate-300">
                Runs{" "}
                {state.executionEnvironment === "container"
                  ? "inside the backend container"
                  : "on the backend host"}{" "}
                with the backend account's permissions. It can read or modify files outside the
                workspace. Approval applies only to this command.
              </p>
              <pre className="my-2 max-h-32 overflow-auto whitespace-pre-wrap break-all text-[11px]">
                {approval.command}
              </pre>
              <p className="mb-2 font-mono text-[10px] text-slate-500">Run {approval.runId}</p>
              <div className="flex gap-3">
                <button
                  type="button"
                  disabled={working || state.emergencyStopped}
                  onClick={() => void action(() => client.decideApproval(approval.id, true))}
                  className="rounded bg-amber-200 px-3 py-1 text-slate-950"
                >
                  Approve command
                </button>
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void action(() => client.decideApproval(approval.id, false))}
                  className="rounded border border-white/20 px-3 py-1"
                >
                  Deny command
                </button>
              </div>
            </section>
          ))}
        </div>
      </details>
    </div>
  );
}
