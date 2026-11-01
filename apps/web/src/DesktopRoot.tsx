import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import { BackendSetup } from "./components/BackendSetup";
import { BACKEND_KEY, backendUrl } from "./lib/transport";

export function DesktopRoot() {
  const [editing, setEditing] = useState(() => {
    if (!isTauri()) return false;
    return !localStorage.getItem(BACKEND_KEY);
  });
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen("desktop:connection", () => setEditing(true));
    const unlistenNotice = listen<string>("desktop:notice", (event) => setNotice(event.payload));
    return () => {
      void unlisten.then((dispose) => dispose());
      void unlistenNotice.then((dispose) => dispose());
    };
  }, []);
  if (isTauri() && editing) {
    return (
      <BackendSetup
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
