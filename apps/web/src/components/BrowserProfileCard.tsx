import { useState } from "react";
import type { DefaultBrowserProfile } from "@vektor/shared";
import type { ApiClient } from "../lib/api";

export function BrowserProfileCard({ client }: { client: ApiClient }) {
  const [info, setInfo] = useState<DefaultBrowserProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action?: "disconnect" | "reset") => {
    if (
      action === "reset" &&
      !window.confirm(
        "Reset Vektor’s default browser profile? This closes its active session and removes saved logins and site storage. Separate sessions are unaffected.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      setInfo(
        action
          ? await client.controlDefaultBrowserProfile(action)
          : await client.defaultBrowserProfile(),
      );
    } catch {
      setError("Could not update the default browser profile. Check your backend connection.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-xs text-slate-400">
      <h2 className="text-sm font-medium text-slate-200">Default browser profile</h2>
      <p className="mt-2">
        A saved Vektor-managed profile for observation or interactive runs. Cookies and site storage
        are encrypted on the backend and included in data backups. Separate sessions start clean and
        never read or update this profile.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button disabled={busy} onClick={() => void act()} className="text-sky-300">
          Refresh profile status
        </button>
        <button disabled={busy || !info?.inUse} onClick={() => void act("disconnect")}>
          Disconnect default profile
        </button>
        <button disabled={busy} onClick={() => void act("reset")} className="text-rose-300">
          Reset saved browser profile
        </button>
      </div>
      {info ? (
        <p className="mt-3" role="status">
          {info.inUse ? `In use by run ${info.runId?.slice(0, 8)}.` : "Available."}{" "}
          {info.configured
            ? `Last saved: ${info.savedAt ? new Date(info.savedAt).toLocaleString() : "Unknown"}.`
            : "No saved browser state yet."}{" "}
          {info.error ? "The last save failed; previous saved state was retained." : ""}
        </p>
      ) : null}
      <p className="mt-2 text-[10px]">
        One run can use the default profile at a time. Disconnect keeps its saved state; reset
        removes it. Reset does not sign out remote sessions or erase existing backups.
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-rose-300">
          {error}
        </p>
      ) : null}
    </section>
  );
}
