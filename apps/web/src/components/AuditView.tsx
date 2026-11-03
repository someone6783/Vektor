import { useEffect, useState } from "react";
import type { AuditEntry } from "@vektor/shared";
import type { ApiClient } from "../lib/api";

export function AuditView({ client }: { client: ApiClient }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async (cursor?: number) => {
    try {
      const result = await client.audit(cursor);
      setEntries((value) => (cursor ? [...value, ...result.entries] : result.entries));
      setBefore(result.nextBefore);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to load audit log.");
    }
  };
  useEffect(() => {
    let active = true;
    void client
      .audit()
      .then((result) => {
        if (active) {
          setEntries(result.entries);
          setBefore(result.nextBefore);
        }
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [client]);
  return (
    <section className="management-page min-h-0 flex-1 overflow-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Audit log</h1>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-white/20 px-3 py-1 text-xs"
        >
          Refresh audit
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-rose-300">
          {error}
        </p>
      ) : null}
      <ol className="space-y-2">
        {entries.map((entry) => (
          <li key={entry.id} className="rounded border border-white/10 p-3 text-xs">
            <details>
              <summary className="cursor-pointer">
                {new Date(entry.createdAt).toLocaleString()} · {entry.action}
              </summary>
              <p className="mt-2 font-mono text-[10px] text-slate-500">
                {entry.runId ?? "Global runtime"}
              </p>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px]">
                {JSON.stringify(entry.details, null, 2)}
              </pre>
            </details>
          </li>
        ))}
      </ol>
      {before ? (
        <button
          type="button"
          onClick={() => void load(before)}
          className="mt-4 rounded border border-white/20 px-3 py-1 text-xs"
        >
          Earlier audit entries
        </button>
      ) : null}
    </section>
  );
}
