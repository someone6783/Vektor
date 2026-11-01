import { useEffect, useState } from "react";
import { APP_VERSION, type UpdateCheck, type UpdatePreferences } from "@vektor/shared";
import type { ApiClient } from "../lib/api";
import { ReleaseLink } from "./ReleaseLink";

const errors = {
  token_required: "A read-only GitHub token is required for this private repository.",
  offline: "Unable to check while GitHub is unreachable. Your workspace keeps working.",
  rate_limited: "GitHub rate limited this check. Try again later.",
  not_found: "No published stable release is available, or the token cannot access it.",
  invalid_response: "GitHub did not return a valid stable release.",
};

export function AboutView({ client }: { client: ApiClient }) {
  const [info, setInfo] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  useEffect(() => {
    let active = true;
    void client
      .updateCheck()
      .then((value) => {
        if (active) setInfo(value);
      })
      .catch(() => {
        if (active) setError("Unable to load update settings.");
      });
    return () => {
      active = false;
    };
  }, [client]);
  const perform = async (patch?: UpdatePreferences) => {
    setBusy(true);
    setError(null);
    try {
      setInfo(patch ? await client.updatePreferences(patch) : await client.updateCheck(true));
      setToken("");
    } catch {
      setError("Unable to update release settings. Check your backend connection.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <h2 className="text-sm font-medium text-slate-200">About Vektor</h2>
      <p className="mt-2 text-xs text-slate-400">
        App v{APP_VERSION}
        {info ? ` · Backend v${info.currentVersion}` : ""}
      </p>
      {info && info.currentVersion !== APP_VERSION ? (
        <p className="mt-2 text-xs text-amber-200">
          App and backend versions differ. Upgrade both together.
        </p>
      ) : null}
      {info ? (
        <div className="mt-4 space-y-3 text-xs text-slate-400">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={info.enabled}
              disabled={busy || !info.allowed}
              onChange={(event) => void perform({ enabled: event.target.checked })}
            />
            Check for updates every 24 hours
          </label>
          {!info.allowed ? <p>Disabled by VEKTOR_UPDATE_CHECK=0 on the backend.</p> : null}
          <p>
            {info.repositoryPrivate
              ? "Private repository: checks are off by default. Only release requests to api.github.com receive the optional token."
              : "Checks send only the app version in a User-Agent to api.github.com."}{" "}
            No workspace or usage data is sent.
          </p>
          {info.repositoryPrivate ? (
            <div className="space-y-2">
              <p>
                GitHub token:{" "}
                {info.tokenSource === "env"
                  ? "managed by the backend environment"
                  : info.tokenSource === "stored"
                    ? "stored encrypted"
                    : "not configured"}
                . Use Contents: read access for {info.repository}.
              </p>
              {info.tokenSource !== "env" ? (
                <div className="flex flex-wrap gap-2">
                  <input
                    aria-label="GitHub release token"
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="Read-only token (write-only)"
                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-3 py-2"
                  />
                  <button
                    disabled={busy || token.length < 8}
                    onClick={() => void perform({ githubToken: token })}
                  >
                    Save token
                  </button>
                  <button
                    disabled={busy || info.tokenSource !== "stored"}
                    onClick={() => void perform({ githubToken: null })}
                  >
                    Clear stored token
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <button
              disabled={
                busy || !info.enabled || (info.repositoryPrivate && info.tokenSource === "none")
              }
              onClick={() => void perform()}
              className="rounded-lg border border-white/10 px-3 py-2 disabled:opacity-40"
            >
              {busy ? "Checking…" : "Check now"}
            </button>
            <span>
              Last checked: {info.checkedAt ? new Date(info.checkedAt).toLocaleString() : "Never"}
            </span>
          </div>
          {info.error ? <p role="status">{errors[info.error]}</p> : null}
          {info.status === "current" ? <p>You are using the latest stable release.</p> : null}
          {info.updateAvailable && info.releaseUrl ? (
            <p>
              <ReleaseLink href={info.releaseUrl}>
                Update available: v{info.latestVersion} · Release notes
              </ReleaseLink>
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-amber-200">
          {error}
        </p>
      ) : null}
      <p className="mt-4 text-xs text-slate-500">
        Back up first. With the release compose file, run{" "}
        <code>docker compose pull &amp;&amp; docker compose up -d</code> in the same project
        directory. The vektor-data volume is preserved. Desktop users install the release package
        and upgrade their backend separately. Updates are installed manually.
      </p>
    </section>
  );
}
