import { useEffect, useState } from "react";
import { healthResponseSchema, type HealthResponse } from "@vektor/shared";
import { fetch } from "@tauri-apps/plugin-http";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { ApiClient } from "../lib/api";
import { BACKEND_KEY, backendUrl, normalizeBackend, tokenStorageKey } from "../lib/transport";

const field =
  "mt-2 w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100";
export function BackendSetup({ onConnected }: { onConnected: () => void }) {
  const [url, setUrl] = useState(backendUrl);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [storage, setStorage] = useState<{
    dataDir: string;
    workspaceDir: string;
    executionEnvironment: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notifications, setNotifications] = useState(
    () => localStorage.getItem("vektor.desktop.notifications") === "true",
  );
  useEffect(() => {
    const token = localStorage.getItem(tokenStorageKey());
    if (token)
      void new ApiClient(token)
        .backendInfo()
        .then(setStorage)
        .catch(() => {});
  }, []);
  const connect = async () => {
    setBusy(true);
    setError(null);
    setHealth(null);
    try {
      const base = normalizeBackend(url);
      const response = await fetch(`${base}/healthz`, {
        signal: AbortSignal.timeout(5000),
        maxRedirections: 0,
      });
      if (!response.ok) throw new Error(`Backend health check failed (${response.status}).`);
      const next = healthResponseSchema.parse(await response.json());
      if (next.status !== "ok") throw new Error("The backend database is unhealthy.");
      setHealth(next);
      localStorage.setItem(BACKEND_KEY, base);
      localStorage.setItem("vektor.desktop.notifications", String(notifications));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const enableNotifications = async () => {
    try {
      let allowed = await isPermissionGranted();
      if (!allowed) allowed = (await requestPermission()) === "granted";
      if (!allowed) throw new Error("Notifications are blocked by the operating system.");
      setNotifications(true);
      localStorage.setItem("vektor.desktop.notifications", "true");
      sendNotification({ title: "Vektor", body: "Run completion notifications are enabled." });
    } catch (error) {
      setError(String(error));
    }
  };
  return (
    <main className="grid min-h-screen place-items-center overflow-y-auto bg-slate-950 p-6 text-slate-100">
      <section className="w-full max-w-xl rounded-2xl border border-white/10 bg-slate-900/60 p-6">
        <h1 className="text-xl font-semibold">Backend connection</h1>
        <p className="mt-2 text-sm text-slate-400">
          Start your Docker backend, then connect this desktop app to it.
        </p>
        <pre className="my-4 rounded-lg bg-slate-950 p-3 text-xs">docker compose up -d --build</pre>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <label htmlFor="backend-url" className="text-xs text-slate-300">
            Local backend URL
          </label>
          <input
            id="backend-url"
            disabled={busy}
            type="url"
            required
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setHealth(null);
              setStorage(null);
            }}
            className={field}
          />
          <p className="mt-2 text-xs text-slate-500">
            Use localhost, 127.0.0.1, or [::1]. The backend stays separate from this app.
          </p>
          <button
            disabled={busy}
            className="mt-4 rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-40"
          >
            {busy ? "Checking…" : "Check and save connection"}
          </button>
        </form>
        {error ? (
          <p role="alert" className="mt-4 text-sm text-rose-300">
            {error}
          </p>
        ) : null}
        {health ? (
          <div role="status" className="mt-4 text-xs text-accent-200">
            Healthy · version {health.version} · database {health.database}
            <br />
            Instance {health.instanceId}
          </div>
        ) : null}
        <div className="mt-5 border-t border-white/10 pt-4 text-xs text-slate-400">
          <h2 className="font-semibold text-slate-200">Backend data</h2>
          {storage ? (
            <dl className="mt-2 space-y-1 break-all">
              <dt>Data directory ({storage.executionEnvironment})</dt>
              <dd className="font-mono text-slate-200">{storage.dataDir}</dd>
              <dt>Workspace</dt>
              <dd className="font-mono text-slate-200">{storage.workspaceDir}</dd>
            </dl>
          ) : (
            <p className="mt-2">
              Unlock the workspace to inspect its data directory. Docker defaults to /data in the
              vektor-data volume.
            </p>
          )}
          <p className="mt-2">
            For Docker volume details: <code>docker volume inspect vektor_vektor-data</code> (the
            project prefix may differ). Closing the desktop app leaves the backend and schedules
            running.
          </p>
        </div>
        <div className="mt-5 border-t border-white/10 pt-4 text-xs">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={notifications}
              onChange={(event) => {
                if (event.target.checked) void enableNotifications();
                else {
                  setNotifications(false);
                  localStorage.setItem("vektor.desktop.notifications", "false");
                }
              }}
            />
            Notify when a run finishes
          </label>
          <p className="mt-2 text-slate-500">
            Notifications cover all channels while the unlocked app runs, including when hidden in
            the tray. They contain status only, without message contents.
          </p>
        </div>
        <button
          type="button"
          onClick={onConnected}
          disabled={!health && !localStorage.getItem(BACKEND_KEY)}
          className="mt-5 rounded-lg border border-white/20 px-4 py-2 text-sm disabled:opacity-40"
        >
          {health ? "Open workspace" : "Use saved connection"}
        </button>
      </section>
    </main>
  );
}
