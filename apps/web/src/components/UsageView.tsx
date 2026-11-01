import { useState } from "react";
import type { UsageReport, UsageSummary } from "@vektor/shared";
import type { ApiClient } from "../lib/api";

function cost(usage: UsageSummary) {
  return usage.knownCostUsd === null
    ? "Unreported"
    : `$${usage.knownCostUsd.toFixed(6)}${usage.incompleteCostRuns ? " + unreported" : ""}`;
}
function Groups({ title, rows }: { title: string; rows: UsageReport["byProfile"] }) {
  const max = Math.max(1, ...rows.map((row) => row.usage.totalTokens));
  return (
    <section className="mt-5">
      <h3 className="mb-2 text-xs font-medium text-slate-200">{title}</h3>
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th scope="col" className="py-2 font-normal">
                  Name
                </th>
                <th scope="col" className="px-3 font-normal">
                  Runs
                </th>
                <th scope="col" className="px-3 font-normal">
                  Tokens
                </th>
                <th scope="col" className="text-right font-normal">
                  Reported cost
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id ?? "unscheduled"} className="border-t border-white/5">
                  <th scope="row" className="max-w-48 py-2 font-normal text-slate-300">
                    <span className="block truncate" title={row.name}>
                      {row.name}
                    </span>
                    <span aria-hidden="true" className="mt-1 block h-0.5 rounded bg-white/5">
                      <span
                        className="block h-full rounded bg-emerald-400/50"
                        style={{ width: `${(row.usage.totalTokens / max) * 100}%` }}
                      />
                    </span>
                  </th>
                  <td className="px-3 tabular-nums">{row.usage.runs}</td>
                  <td className="px-3 tabular-nums">{row.usage.totalTokens.toLocaleString()}</td>
                  <td className="text-right tabular-nums">{cost(row.usage)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-slate-500">No runs in this period.</p>
      )}
    </section>
  );
}
export function UsageView({ client }: { client: ApiClient }) {
  const [from, setFrom] = useState(() =>
    new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10),
  );
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [provider, setProvider] = useState<UsageReport["provider"]>("openrouter");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      if (!from || !to || from > to) throw new Error("Choose a valid date range.");
      const end = new Date(`${to}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      setReport(
        await client.usageReport(
          new Date(`${from}T00:00:00Z`).toISOString(),
          end.toISOString(),
          provider,
        ),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load usage.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="rounded-2xl border border-white/10 bg-white/[0.02] p-5"
      aria-label="Usage and cost reporting"
    >
      <h2 className="text-sm font-semibold text-slate-100">Usage and costs</h2>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        Provider-reported tokens and USD cost, grouped by the profile and job used for each run.
        Unknown prices remain unreported; context estimates are excluded.
      </p>
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label className="text-xs text-slate-400">
          From (UTC)
          <input
            type="date"
            aria-label="Usage from date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setReport(null);
            }}
            disabled={busy}
            className="mt-1 block rounded-lg border border-white/10 bg-slate-950 p-2"
          />
        </label>
        <label className="text-xs text-slate-400">
          Through (UTC)
          <input
            type="date"
            aria-label="Usage through date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setReport(null);
            }}
            disabled={busy}
            className="mt-1 block rounded-lg border border-white/10 bg-slate-950 p-2"
          />
        </label>
        <label className="text-xs text-slate-400">
          Provider
          <select
            aria-label="Usage provider"
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value as UsageReport["provider"]);
              setReport(null);
            }}
            disabled={busy}
            className="mt-1 block rounded-lg border border-white/10 bg-slate-950 p-2"
          >
            <option value="openrouter">OpenRouter</option>
            <option value="stub">Demo provider</option>
            <option value="unknown">Unknown / historical</option>
            <option value="all">All providers</option>
          </select>
        </label>
        <button
          disabled={busy}
          className="rounded-lg border border-white/20 px-3 py-2 text-xs text-slate-200 disabled:opacity-40"
        >
          {busy ? "Loading…" : "Load usage report"}
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-3 text-xs text-rose-300">
          {error}
        </p>
      ) : null}
      {report ? (
        <div className="mt-4 text-xs text-slate-400">
          <p>
            {report.totals.runs} runs · {report.totals.promptTokens.toLocaleString()} input +{" "}
            {report.totals.completionTokens.toLocaleString()} output tokens · {cost(report.totals)}
          </p>
          <p className="mt-2 text-slate-500">
            {report.totals.completed} completed · {report.totals.failed} failed ·{" "}
            {report.totals.cancelled} cancelled · {report.totals.running} running
          </p>
          <p className="mt-2 text-slate-500">
            {report.totals.runsWithoutUsage} runs without usage · {report.totals.incompleteCostRuns}{" "}
            runs with incomplete cost · {report.totals.pricedCalls} of {report.totals.providerCalls}{" "}
            calls priced
          </p>
          <Groups title="By profile" rows={report.byProfile} />
          <Groups title="By scheduled job" rows={report.byJob} />
          <p className="mt-4 text-[10px] text-slate-500">
            Date range uses run start times in UTC. Retries count as separate runs and retain job
            attribution. Historical runs have unknown provider attribution; this report is not an
            invoice.
          </p>
        </div>
      ) : null}
    </section>
  );
}
