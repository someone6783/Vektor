import { useEffect, useState } from "react";
import {
  type SshAuthType,
  type SshConnection,
  type SshConnectionInput,
} from "@vektor/shared";
import type { ApiClient } from "../lib/api";

const field = "rounded border border-white/15 bg-slate-950 p-2 text-sm";
const button = "rounded border border-white/15 px-3 py-1.5 text-xs disabled:opacity-40";

const blank: SshConnectionInput = {
  name: "",
  host: "",
  port: 22,
  username: "",
  authType: "key",
  keyPath: undefined,
};

export function SshSettings({ client }: { client: ApiClient }) {
  const [connections, setConnections] = useState<SshConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<SshConnectionInput>(blank);
  const [editing, setEditing] = useState<string>();
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");

  const load = async () => {
    setConnections(await client.sshList());
  };
  useEffect(() => {
    void load().catch(() => setError("SSH settings could not be loaded."));
  }, []);
  const action = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "SSH action failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4 rounded-xl border border-white/10 bg-slate-900/40 p-5">
      <h3 className="text-lg font-semibold">SSH connections</h3>
      <p className="text-sm text-slate-400">
        Log in to remote machines with an SSH key stored on this computer or a password. Passwords
        and key passphrases are encrypted at rest and never displayed again. A connection can then
        be selected as the execution target of a conversation's terminal.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-rose-300">
          {error}
        </p>
      ) : null}
      {connections === null ? (
        <button className={button} disabled={busy} onClick={() => void action(load)}>
          Reload SSH connections
        </button>
      ) : null}
      {connections?.map((connection) => (
        <ConnectionCard
          key={connection.id}
          client={client}
          connection={connection}
          refresh={load}
          onError={setError}
          disabled={busy}
        />
      ))}
      {connections ? (
        <form
          className="space-y-3 rounded border border-white/10 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              const payload = {
                ...draft,
                port: draft.port || 22,
                keyPath: draft.authType === "key" ? draft.keyPath?.trim() || undefined : undefined,
              };
              const created = editing
                ? await client.sshUpdate(editing, payload)
                : await client.sshCreate(payload);
              if (password || passphrase) {
                await client.sshCredentials(created.id, {
                  ...(draft.authType === "password" && password ? { password } : {}),
                  ...(draft.authType === "key" && passphrase ? { passphrase } : {}),
                });
              }
              setDraft(blank);
              setPassword("");
              setPassphrase("");
              setEditing(undefined);
              await load();
            });
          }}
        >
          <h4 className="font-medium">{editing ? "Edit SSH connection" : "Add SSH connection"}</h4>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              Name
              <input
                required
                className={`${field} mt-1 block w-full`}
                placeholder="Build server"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="text-sm">
              Host
              <input
                required
                className={`${field} mt-1 block w-full`}
                placeholder="build.example.com"
                value={draft.host}
                onChange={(e) => setDraft({ ...draft, host: e.target.value })}
              />
            </label>
            <label className="text-sm">
              Username
              <input
                required
                className={`${field} mt-1 block w-full`}
                placeholder="deploy"
                value={draft.username}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
              />
            </label>
            <label className="text-sm">
              Port
              <input
                type="number"
                min={1}
                max={65535}
                className={`${field} mt-1 block w-full`}
                value={draft.port || ""}
                onChange={(e) => setDraft({ ...draft, port: e.target.valueAsNumber || 22 })}
              />
            </label>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              Authentication
              <select
                className={`${field} mt-1 block w-full`}
                value={draft.authType}
                onChange={(e) =>
                  setDraft({ ...draft, authType: e.target.value as SshAuthType })
                }
              >
                <option value="key">SSH key on this computer</option>
                <option value="password">Password</option>
              </select>
            </label>
            {draft.authType === "key" ? (
              <label className="text-sm">
                Private key path
                <input
                  required
                  className={`${field} mt-1 block w-full`}
                  placeholder="~/.ssh/id_ed25519"
                  value={draft.keyPath ?? ""}
                  onChange={(e) => setDraft({ ...draft, keyPath: e.target.value })}
                />
              </label>
            ) : null}
          </div>
          {draft.authType === "key" ? (
            <label className="block text-sm">
              Key passphrase (optional, stored encrypted)
              <input
                type="password"
                autoComplete="new-password"
                className={`${field} mt-1 block w-full`}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
          ) : (
            <label className="block text-sm">
              {editing ? "Replace password (leave empty to keep the encrypted one)" : "Password"}
              <input
                type="password"
                autoComplete="new-password"
                required={!editing}
                className={`${field} mt-1 block w-full`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <span className="text-xs text-slate-400">
                Stored with AES-256-GCM encryption and never returned by the API. Typing a
                different value replaces the stored password.
              </span>
            </label>
          )}
          <div className="flex gap-2">
            <button type="submit" className={button} disabled={busy}>
              {editing ? "Save SSH connection" : "Add SSH connection"}
            </button>
            {editing ? (
              <button
                type="button"
                className={button}
                onClick={() => {
                  setEditing(undefined);
                  setDraft(blank);
                  setPassword("");
                  setPassphrase("");
                }}
              >
                Cancel edit
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
    </section>
  );
}

function ConnectionCard({
  client,
  connection,
  refresh,
  onError,
  disabled,
}: {
  client: ApiClient;
  connection: SshConnection;
  refresh: () => Promise<void>;
  onError: (value: string) => void;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const locked = busy || disabled;
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const action = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await refresh();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "SSH action failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="space-y-2 rounded-lg border border-white/10 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium">
          {connection.name} · {connection.username}@{connection.host}:{connection.port}
        </h4>
        <div className="flex gap-2">
          <button
            className={button}
            disabled={locked}
            onClick={() =>
              void action(async () => {
                setTest(await client.sshTest(connection.id));
              })
            }
          >
            Test connection
          </button>
          <button
            className={button}
            disabled={locked}
            onClick={() => void action(() => client.sshRemove(connection.id))}
          >
            Remove
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-400">
        {connection.authType === "key"
          ? `SSH key · ${connection.keyPath ?? "no key path"}${connection.hasPassphrase ? " · passphrase stored" : ""}`
          : `Password authentication · ${connection.hasPassword ? "password stored" : "no password stored"}`}
      </p>
      {test ? <p className={`text-xs ${test.ok ? "text-emerald-300" : "text-rose-300"}`}>{test.message}</p> : null}
      <details className="text-xs">
        <summary className="cursor-pointer">Replace stored password or passphrase</summary>
        <div className="mt-2 space-y-2">
          {connection.authType === "password" ? (
            <input
              type="password"
              autoComplete="new-password"
              aria-label={`${connection.name} replacement password`}
              placeholder="New password"
              className={`${field} w-full`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          ) : null}
          {connection.authType === "key" ? (
            <input
              type="password"
              autoComplete="new-password"
              aria-label={`${connection.name} replacement key passphrase`}
              placeholder="Key passphrase (empty clears it)"
              className={`${field} w-full`}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          ) : null}
          <button
            className={button}
            disabled={locked || !(password || passphrase)}
            onClick={() =>
              void action(async () => {
                await client.sshCredentials(connection.id, {
                  ...(connection.authType === "password" ? { password: password || null } : {}),
                  ...(connection.authType === "key" ? { passphrase: passphrase || null } : {}),
                });
                setPassword("");
                setPassphrase("");
              })
            }
          >
            Save encrypted credentials
          </button>
        </div>
      </details>
    </article>
  );
}
