import { useEffect, useState } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import { BackendSetup } from "./components/BackendSetup";
import { saveDesktopConnection, type DesktopConnection } from "./lib/desktop";
import { BACKEND_KEY, backendUrl, tokenStorageKey } from "./lib/transport";

export function DesktopRoot() {
  const [editing, setEditing] = useState(() => {
    if (!isTauri()) return false;
    return !localStorage.getItem(BACKEND_KEY);
  });
  const [restoring, setRestoring] = useState(isTauri);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void invoke<DesktopConnection | null>("restore_backend")
      .then(async (connection) => {
        if (!active) return;
        if (connection) {
          await saveDesktopConnection(connection);
          if (active) setEditing(false);
        } else if (!localStorage.getItem(tokenStorageKey())) {
          setEditing(true);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setSetupError(String(error));
          setEditing(true);
        }
      })
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen("desktop:connection", () => setEditing(true));
    const unlistenNotice = listen<string>("desktop:notice", (event) => setNotice(event.payload));
    return () => {
      void unlisten.then((dispose) => dispose());
      void unlistenNotice.then((dispose) => dispose());
    };
  }, []);
  if (restoring)
    return (
      <main
        className="grid min-h-screen place-items-center bg-slate-950 text-slate-300"
        role="status"
      >
        Connecting to your workspace…
      </main>
    );
  if (isTauri() && editing) {
    return (
      <BackendSetup
        initialError={setupError}
        onConnected={() => {
          setRevision((value) => value + 1);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <>
      <App
        key={`${backendUrl()}:${revision}`}
        onConnection={isTauri() ? () => setEditing(true) : undefined}
      />
      {notice ? (
        <div
          role="status"
          className="fixed bottom-4 left-4 z-50 max-w-lg rounded-xl border border-white/20 bg-slate-900 p-4 text-sm text-slate-100 shadow-xl"
        >
          {notice}
          <button className="ml-4 text-accent-300" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </>
  );
}
