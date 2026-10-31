import { useCallback, useEffect, useState } from "react";
import type { RuntimeState } from "@vektor/shared";
import type { ApiClient } from "../lib/api";

export function RuntimeControls({
  client,
  onStoppedChange,
  onError,
}: {
  client: ApiClient;
  onStoppedChange: (stopped: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const next = await client.runtime();
    setState(next);
    onStoppedChange(next.emergencyStopped);
  }, [client, onStoppedChange]);
  useEffect(() => {
    let active = true;
    const update = async () => {
      try {
        const next = await client.runtime();
        if (active) {
          setState(next);
          onStoppedChange(next.emergencyStopped);
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
  }, [client, onStoppedChange, onError]);
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
    <aside
      aria-label="Runtime controls"
      className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-white/10 bg-slate-900/70 px-4 py-2 text-xs"
    >
      {error ? (
        <p role="alert" className="mb-2 text-rose-300">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <span className={state?.emergencyStopped ? "text-rose-300" : "text-slate-400"}>
          {state?.emergencyStopped
            ? "Emergency stop active · New runs blocked"
            : `${state?.activeRuns.length ?? 0} active runs`}
        </span>
        <span className="text-slate-500">Execution: {state?.executionEnvironment ?? "…"}</span>
        {!state?.terminalSupported && state ? (
          <span className="text-amber-200">Terminal unavailable; use a POSIX/Docker backend.</span>
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
          <button
            type="button"
            disabled={working}
            onClick={() => void action(() => client.emergencyStop())}
            className="rounded border border-rose-400/40 bg-rose-400/10 px-3 py-1 font-semibold text-rose-200"
          >
            Emergency stop
          </button>
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
    </aside>
  );
}
