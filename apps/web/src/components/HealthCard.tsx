import { useEffect, useState } from "react";
import { healthResponseSchema, type HealthResponse } from "@vektor/shared";
import { apiFetch } from "../lib/transport";

type HealthState =
  { kind: "loading" } | { kind: "ok"; data: HealthResponse } | { kind: "error"; message: string };

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 font-mono text-xs text-slate-200">{value}</dd>
    </div>
  );
}

export function HealthCard() {
  const [state, setState] = useState<HealthState>({ kind: "loading" });
  const [checkedAt, setCheckedAt] = useState<string>("");

  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;

    const check = async () => {
      controller?.abort();
      controller = new AbortController();

      try {
        const response = await apiFetch("/healthz", {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          throw new Error(`API returned ${response.status}`);
        }

        const data = healthResponseSchema.parse(await response.json());

        if (active) {
          setState({ kind: "ok", data });
          setCheckedAt(new Date().toLocaleTimeString());
        }
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }

        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    };

    void check();
    const timer = setInterval(() => void check(), 5_000);

    return () => {
      active = false;
      controller?.abort();
      clearInterval(timer);
    };
  }, []);

  const healthy = state.kind === "ok" && state.data.status === "ok";

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-slate-200">Backend health</h2>
          <p className="mt-1 text-xs text-slate-500">
            Polls <code className="font-mono text-slate-400">/healthz</code> every 5 seconds.
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
            state.kind === "loading"
              ? "border-slate-600 text-slate-400"
              : healthy
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                : "border-rose-400/30 bg-rose-400/10 text-rose-300"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              state.kind === "loading" ? "bg-slate-500" : healthy ? "bg-emerald-400" : "bg-rose-400"
            }`}
          />
          {state.kind === "loading" ? "Checking" : healthy ? "Connected" : "Unavailable"}
        </span>
      </div>

      {state.kind === "error" ? (
        <p className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-xs leading-5 text-rose-200">
          {state.message}. Start the API with <code className="font-mono">pnpm dev</code> or{" "}
          <code className="font-mono">docker compose up</code>.
        </p>
      ) : state.kind === "ok" ? (
        <>
          <dl className="mt-5 grid grid-cols-2 gap-4">
            <Stat label="API version" value={state.data.version} />
            <Stat label="Database" value={state.data.database} />
            <Stat label="Uptime" value={`${state.data.uptimeSeconds}s`} />
            <Stat label="Instance" value={state.data.instanceId.slice(0, 8)} />
          </dl>
          <p className="mt-4 text-[11px] text-slate-500">Last checked {checkedAt || "just now"}.</p>
        </>
      ) : (
        <div className="mt-5 animate-pulse space-y-3">
          <div className="h-3 w-2/3 rounded bg-white/5" />
          <div className="h-3 w-1/2 rounded bg-white/5" />
        </div>
      )}
    </section>
  );
}
