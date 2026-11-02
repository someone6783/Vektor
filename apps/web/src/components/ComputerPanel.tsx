import { useEffect, useState, useRef } from "react";
import {
  computerInputSchema,
  type ComputerArtifact,
  type ComputerCapabilities,
  type ComputerState,
} from "@vektor/shared";
import type { ApiClient } from "../lib/api";

export function ComputerPanel({
  client,
  runId,
  active,
}: {
  client: ApiClient;
  runId: string;
  active: boolean;
}) {
  const [state, setState] = useState<ComputerState | null>(null);
  const [capabilities, setCapabilities] = useState<ComputerCapabilities | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [artifacts, setArtifacts] = useState<ComputerArtifact[]>([]);
  const [artifactUrl, setArtifactUrl] = useState("");
  const artifactRef = useRef("");
  const [appIndex, setAppIndex] = useState("0");
  useEffect(
    () => () => {
      if (artifactRef.current) URL.revokeObjectURL(artifactRef.current);
    },
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [x, setX] = useState("0");
  const [y, setY] = useState("0");
  const [text, setText] = useState("");
  const [key, setKey] = useState("Return");
  useEffect(() => {
    let mounted = true;
    void client
      .computerCapabilities()
      .then((value) => {
        if (mounted) setCapabilities(value);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [client]);
  useEffect(() => {
    let mounted = true;
    let url = "";
    let refreshing = false;
    const refresh = () => {
      if (refreshing) return;
      refreshing = true;
      void client
        .computerArtifacts(runId)
        .then((files) => {
          if (mounted) setArtifacts(files);
        })
        .catch(() => {});
      void client
        .computerState(runId)
        .then(async (value) => {
          if (!mounted) return;
          setState(value);
          if (!value.active) {
            if (url) URL.revokeObjectURL(url);
            url = "";
            setImageUrl("");
            return;
          }
          const blob = await client.computerScreenshot(runId);
          if (!mounted) return;
          const next = URL.createObjectURL(blob);
          if (url) URL.revokeObjectURL(url);
          url = next;
          setImageUrl(next);
        })
        .catch(() => {
          if (mounted) setError("Unable to load the isolated desktop.");
        })
        .finally(() => {
          refreshing = false;
        });
    };
    refresh();
    const timer = setInterval(refresh, 2500);
    return () => {
      mounted = false;
      clearInterval(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, runId]);
  const perform = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Desktop action failed.");
    } finally {
      setBusy(false);
    }
  };
  const send = (input: unknown) => {
    setText("");
    return perform(() => client.computerInput(runId, computerInputSchema.parse(input)));
  };
  const control = (action: "pause" | "resume" | "close" | "private") =>
    perform(() => client.computerControl(runId, action));
  return (
    <section
      aria-label="Isolated computer"
      className="my-3 space-y-2 rounded-lg border border-violet-400/20 p-3"
    >
      <p className="font-medium text-violet-300">
        Isolated computer · {state?.mode ?? "off"} · {state?.app ?? "no app"}
      </p>
      <p className="text-[11px] text-slate-400">
        {capabilities?.available
          ? `Virtual desktop on the backend (${state?.width ?? 0}×${state?.height ?? 0}). The user's real desktop is not controlled.`
          : (capabilities?.reason ?? "Checking backend computer support…")}
      </p>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt="Current isolated virtual desktop"
          className="w-full rounded border border-white/10 bg-black object-contain"
        />
      ) : (
        <p className="rounded border border-dashed border-white/10 p-4 text-center text-[11px] text-slate-500">
          {state?.active ? "Waiting for the first screenshot…" : "The desktop starts on demand."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span>
          phase {state?.phase ?? "idle"} · {state?.actions ?? 0} actions · cursor{" "}
          {state?.cursor.x ?? 0},{state?.cursor.y ?? 0}
        </span>
        <button disabled={busy || !active} onClick={() => void control("pause")}>
          Pause
        </button>
        <button
          disabled={busy || !active || state?.sensitive}
          onClick={() => void control("resume")}
        >
          Resume
        </button>
        <button disabled={busy || !active} onClick={() => void send({ action: "screenshot" })}>
          Screenshot
        </button>
        <button
          disabled={busy || !active || state?.sensitive}
          onClick={() => void control("private")}
        >
          Private takeover
        </button>
        <button disabled={busy || !active} onClick={() => void control("close")}>
          Close desktop
        </button>
      </div>
      {state?.sensitive ? (
        <p role="status" className="text-sm text-amber-200">
          Private takeover: only you can see this preview. Agent input and screenshots are blocked.
          Close the desktop when finished; it cannot resume with private content visible.
        </p>
      ) : null}
      <p className="text-[11px] text-slate-400">
        {state?.remainingActions ?? "—"} actions remaining · target {state?.target ?? "none"}
      </p>
      {(state?.apps?.length ?? 0) > 1 ? (
        <div className="flex gap-2 text-sm">
          <select
            aria-label="Allowed application"
            value={appIndex}
            onChange={(event) => setAppIndex(event.target.value)}
          >
            {state?.apps?.map((name, index) => (
              <option key={index} value={index}>
                {name}
              </option>
            ))}
          </select>
          <button
            disabled={busy || !active || state?.mode !== "control" || state?.sensitive}
            onClick={() => void send({ action: "launch", appIndex: Number(appIndex) })}
          >
            Switch application
          </button>
        </div>
      ) : null}
      {state?.windows.length ? (
        <ul className="text-[11px] text-slate-400">
          {state.windows.map((window) => (
            <li key={window.id}>
              {window.id} · {window.title}
              <button
                className="ml-2"
                disabled={busy || !active || state?.mode !== "control"}
                onClick={() => void send({ action: "focus", windowId: window.id })}
              >
                Focus
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-end gap-2 text-[11px]">
        <label>
          x
          <input
            value={x}
            onChange={(event) => setX(event.target.value)}
            inputMode="numeric"
            className="ml-1 w-16 rounded border border-white/10 bg-slate-950 p-1"
          />
        </label>
        <label>
          y
          <input
            value={y}
            onChange={(event) => setY(event.target.value)}
            inputMode="numeric"
            className="ml-1 w-16 rounded border border-white/10 bg-slate-950 p-1"
          />
        </label>
        <button
          disabled={busy || !active || state?.mode !== "control"}
          onClick={() =>
            void send({
              action: "click",
              x: Number(x) || 0,
              y: Number(y) || 0,
            })
          }
        >
          Click
        </button>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          type="password"
          autoComplete="off"
          placeholder="Private text (starts takeover)"
          className="min-w-32 flex-1 rounded border border-white/10 bg-slate-950 p-1"
        />
        <button
          disabled={busy || !active || state?.mode !== "control" || !text}
          onClick={() => void send({ action: "type", text })}
        >
          Type
        </button>
        <input
          value={key}
          onChange={(event) => setKey(event.target.value)}
          aria-label="Key to send"
          className="w-24 rounded border border-white/10 bg-slate-950 p-1"
        />
        <button
          disabled={busy || !active || state?.mode !== "control"}
          onClick={() => void send({ action: "key", key })}
        >
          Key
        </button>
      </div>
      {artifacts.length ? (
        <div className="space-y-2 text-[11px]">
          <p>Action screenshots · retained until their expiry date</p>
          <div className="flex flex-wrap gap-2">
            {artifacts.map((file) => (
              <button
                key={file.id}
                onClick={() =>
                  void perform(async () => {
                    const blob = await client.computerArtifact(file.id);
                    if (artifactRef.current) URL.revokeObjectURL(artifactRef.current);
                    artifactRef.current = URL.createObjectURL(blob);
                    setArtifactUrl(artifactRef.current);
                  })
                }
              >
                {file.action} · {file.stage} · {new Date(file.createdAt).toLocaleTimeString()}
              </button>
            ))}
          </div>
          <button
            onClick={() =>
              void perform(async () => {
                await client.deleteComputerArtifacts(runId);
                setArtifacts([]);
                if (artifactRef.current) URL.revokeObjectURL(artifactRef.current);
                artifactRef.current = "";
                setArtifactUrl("");
              })
            }
          >
            Delete action screenshots
          </button>
        </div>
      ) : null}
      {artifactUrl ? (
        <img
          src={artifactUrl}
          alt="Saved desktop action screenshot"
          className="w-full rounded border border-white/10"
        />
      ) : null}
      {state?.error ? (
        <p role="alert" className="text-[11px] text-rose-300">
          {state.error}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[11px] text-rose-300">
          {error}
        </p>
      ) : null}
      <p className="text-[10px] text-slate-500">
        Manual controls are audited. The agent must obtain a separate approval for every automated
        click, drag, scroll, key and text input. Manual text and keys start private takeover.
        Clipboard, file transfer and external network access are disabled. Screenshots and window
        titles are untrusted.
      </p>
    </section>
  );
}
