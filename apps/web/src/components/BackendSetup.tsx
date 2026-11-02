import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { backendUrl, normalizeBackend } from "../lib/transport";
import { saveDesktopConnection, type DesktopConnection } from "../lib/desktop";

export function BackendSetup({
  onConnected,
  initialError,
}: {
  onConnected: () => void;
  initialError?: string | null;
}) {
  const [mode, setMode] = useState<"local" | "docker">("local");
  const [url, setUrl] = useState(backendUrl);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState(false);
  const [notifications, setNotifications] = useState(
    () => localStorage.getItem("vektor.desktop.notifications") === "true",
  );
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const connection =
        mode === "local"
          ? await invoke<DesktopConnection>("install_local_service")
          : await invoke<DesktopConnection>("connect_docker", { baseUrl: normalizeBackend(url) });
      await saveDesktopConnection(connection);
      localStorage.setItem("vektor.desktop.notifications", String(notifications));
      onConnected();
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
        <div className="mb-5 text-sm font-semibold text-accent-300">Vektor</div>
        <h1 className="text-2xl font-semibold">Set up your workspace</h1>
        <p className="mt-2 text-sm text-slate-400">
          Choose where your agents run. Sign-in is configured automatically.
        </p>
        <fieldset disabled={busy} className="mt-6 grid gap-3">
          <legend className="sr-only">API connection</legend>
          {(["local", "docker"] as const).map((choice) => (
            <label
              key={choice}
              className={`flex cursor-pointer gap-3 rounded-xl border p-4 ${mode === choice ? "border-accent-400/60 bg-accent-400/5" : "border-white/10"}`}
            >
              <input
                type="radio"
                name="backend-mode"
                value={choice}
                checked={mode === choice}
                onChange={() => {
                  setMode(choice);
                  setError(null);
                }}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-semibold">
                  {choice === "local" ? "Install local API service" : "Connect to Docker"}
                </span>
                <span className="mt-1 block text-xs leading-5 text-slate-400">
                  {choice === "local"
                    ? "Recommended for this computer. Includes Node and the API; no Docker, terminal or administrator access needed. Starts when you sign in."
                    : "Use an existing Vektor Docker API on this computer. Containers and their data stay independent of the desktop."}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {mode === "docker" ? (
          <div className="mt-4 text-xs text-slate-400">
            <p>
              Start your Vektor containers with the Docker installer, then connect below. Docker
              must be accessible to your user account.
            </p>
            <label htmlFor="backend-url" className="mt-3 block text-slate-300">
              Local backend URL
            </label>
            <input
              id="backend-url"
              disabled={busy}
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className="mt-2 w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            />
            <p className="mt-2">
              Use the API port (normally 8787). The separate browser UI normally uses port 8788.
            </p>
          </div>
        ) : (
          <p className="mt-4 text-xs leading-5 text-slate-400">
            Closing the window keeps Vektor in the system tray so agents can finish. Choose “Quit
            Vektor and stop local API” in the tray to stop this service. Data stays in your user
            account.
          </p>
        )}
        <label className="mt-5 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            disabled={busy}
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
        {error ? (
          <p role="alert" className="mt-4 rounded-lg bg-rose-400/10 p-3 text-sm text-rose-200">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void connect()}
          className="mt-6 w-full rounded-lg bg-accent-400 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-40"
        >
          {busy
            ? mode === "local"
              ? "Installing and starting API…"
              : "Connecting…"
            : mode === "local"
              ? "Install service and open workspace"
              : "Connect and open workspace"}
        </button>
        <p role="status" className="mt-3 text-center text-xs text-slate-500">
          {busy
            ? "This can take a minute. Keep this window open."
            : "Your access credentials are handled securely on this computer."}
        </p>
      </section>
    </main>
  );
}
