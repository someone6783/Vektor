import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ApiClient } from "../lib/api";

export function InstallUpdates({
  client,
  enabled,
  backendAvailable = false,
  refreshKey,
  compact = false,
}: {
  client: ApiClient;
  enabled: boolean;
  backendAvailable?: boolean;
  refreshKey?: string | null;
  compact?: boolean;
}) {
  const [docker, setDocker] = useState<{
    configured: boolean;
    state: string;
    message: string;
  } | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [interacted, setInteracted] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () => {
      void client
        .updateInstallState()
        .then((value) => {
          if (active) setDocker(value);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client]);
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let active = true;
    const check = () => {
      void invoke<string | null>("check_desktop_update")
        .then((value) => {
          if (active) setVersion(value);
        })
        .catch((error: unknown) => {
          if (active) setMessage(String(error));
        });
    };
    check();
    const timer = setInterval(check, 24 * 60 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled, refreshKey]);
  const install = async (desktop: boolean) => {
    setInteracted(true);
    setBusy(true);
    setMessage(null);
    try {
      if (desktop) {
        setMessage("Downloading and verifying the desktop update. Vektor will restart when ready.");
        await invoke("install_desktop_update");
      } else {
        const state = await client.installBackendUpdate();
        setDocker(state);
        setMessage(
          "Updating the API and Web UI. The backend will restart; reload the page after it reconnects. Resume execution explicitly after checking the update.",
        );
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const updating =
    docker && ["queued", "pulling", "backing_up", "installing"].includes(docker.state);
  if (
    !version &&
    !backendAvailable &&
    (!message || (compact && !interacted)) &&
    (!docker?.configured || docker.state === "idle")
  )
    return null;
  return (
    <div
      className={
        compact ? "space-y-1 text-xs text-slate-400" : "mt-3 space-y-2 text-xs text-slate-400"
      }
    >
      {enabled && version ? (
        <button
          disabled={busy}
          onClick={() => void install(true)}
          className="rounded-lg border border-white/10 px-3 py-2"
        >
          Install desktop v{version} and restart
        </button>
      ) : null}
      {enabled && backendAvailable && docker?.configured ? (
        <button
          disabled={busy || !!updating}
          onClick={() => void install(false)}
          className="rounded-lg border border-white/10 px-3 py-2"
        >
          {updating ? "Updating backend…" : "Install latest backend update"}
        </button>
      ) : null}
      {docker?.configured && docker.state !== "idle" ? <p role="status">{docker.message}</p> : null}
      {message && (!compact || interacted) ? <p role="status">{message}</p> : null}
    </div>
  );
}
