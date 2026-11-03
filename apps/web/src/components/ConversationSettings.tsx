import { ChoicePicker } from "./ChoicePicker";
import { useEffect, useState } from "react";
import {
  browserPermissionsSchema,
  type Channel,
  type ConversationExecution,
  type Profile,
  type RunnerId,
  type SshConnection,
  type TerminalMode,
  type BrowserPermissions,
} from "@vektor/shared";
import { Modal } from "./Modal";
import type { ApiClient } from "../lib/api";

export function ConversationSettings({
  channel,
  profile,
  section,
  runner,
  retryOnSave = false,
  client,
  onSave,
  onClose,
}: {
  channel: Channel;
  profile: Profile;
  section: "terminal" | "browser";
  runner?: RunnerId;
  retryOnSave?: boolean;
  client?: ApiClient;
  onSave: (execution: ConversationExecution) => Promise<void>;
  onClose: () => void;
}) {
  const selectedRunner = runner ?? profile.runner ?? "native";
  const external =
    selectedRunner !== "native" && selectedRunner !== "cli" && section === "terminal";
  const agentName =
    selectedRunner === "codex"
      ? "Codex"
      : selectedRunner === "acp:opencode"
        ? "OpenCode"
        : "This agent";
  const [grant, setGrant] = useState({ workspace: false, inference: false });
  const [grantLoaded, setGrantLoaded] = useState(false);
  const [agentAvailable, setAgentAvailable] = useState(false);
  const [terminal, setTerminal] = useState(profile.terminalMode);
  const [sshConnections, setSshConnections] = useState<SshConnection[]>([]);
  const [sshTarget, setSshTarget] = useState<string>(channel.execution?.sshConnectionId ?? "");
  const [browser, setBrowser] = useState(browserPermissionsSchema.parse(profile.browser ?? {}));
  const [origins, setOrigins] = useState(browser.allowedOrigins.join("\n"));
  const [localOrigins, setLocalOrigins] = useState(browser.localOrigins.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (section !== "terminal" || !client) return;
    void client
      .sshList()
      .then(setSshConnections)
      .catch(() => setSshConnections([]));
  }, [client, section]);
  useEffect(() => {
    if (!external || !client) return;
    let active = true;
    setGrantLoaded(false);
    void client
      .runnerSetup()
      .then((setup) => {
        if (!active) return;
        const existing = setup.grants.find(
          (item) => item.profileId === profile.id && item.runner === selectedRunner,
        );
        setGrant({
          workspace: existing?.workspace ?? false,
          inference: existing?.inference ?? false,
        });
        setAgentAvailable(
          setup.installations.some((entry) => entry.id === selectedRunner && entry.enabled),
        );
        setGrantLoaded(true);
      })
      .catch(() => {
        if (active) setError("Could not load agent access. Reopen these settings to retry.");
      });
    return () => {
      active = false;
    };
  }, [client, external, profile.id, selectedRunner]);
  return (
    <Modal
      title={`${section === "terminal" ? "Terminal" : "Browser"} · ${channel.name}`}
      onClose={onClose}
    >
      <form
        className="conversation-settings"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            const execution =
              section === "terminal"
                ? { terminalMode: terminal, sshConnectionId: sshTarget || null }
                : {
                    browser: browserPermissionsSchema.parse({
                      ...browser,
                      allowedOrigins: origins
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean),
                      localOrigins: localOrigins
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean),
                    }),
                  };
            if (external) {
              if (
                !client ||
                !grantLoaded ||
                !agentAvailable ||
                terminal !== "full-access" ||
                !grant.workspace ||
                !grant.inference
              )
                throw new Error("Select Full access and allow workspace and model access first.");
              await client.runnerGrant(profile.id, { runner: selectedRunner, ...grant });
            }
            await onSave(execution);
            onClose();
          } catch (error) {
            setError(error instanceof Error ? error.message : "Couldn’t save changes.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          {external
            ? `Terminal access applies to this conversation. Agent access applies to profile “${profile.name}”.`
            : "Only this conversation."}
        </p>
        {section === "terminal" ? (
          <>
            <div className="settings-field">
              <span>Terminal access</span>
              <ChoicePicker
                className="form-choice"
                label="Terminal access"
                value={terminal}
                disabled={busy}
                onChange={(value) => setTerminal(value as TerminalMode)}
                options={[
                  { value: "no-terminal", label: "Off", disabled: external },
                  { value: "basic", label: "Workspace commands", disabled: external },
                  { value: "full-access", label: "Full access · approve each command" },
                  {
                    value: "full-unrestricted",
                    label: "Full Unrestricted · no approvals",
                    disabled: external,
                  },
                ]}
              />
            </div>
            {external ? (
              <fieldset className="runner-permission-grants">
                <legend>{agentName} access</legend>
                <p>Each command and file change requires approval.</p>
                {!grantLoaded ? (
                  <p role="status">Loading agent access…</p>
                ) : !agentAvailable ? (
                  <p role="alert">Connect {agentName} in Agent runner setup first.</p>
                ) : null}
                <label>
                  <input
                    type="checkbox"
                    disabled={!grantLoaded || !agentAvailable || busy}
                    checked={grant.workspace}
                    onChange={(event) => setGrant({ ...grant, workspace: event.target.checked })}
                  />
                  Allow {agentName} workspace access
                </label>
                <label>
                  <input
                    type="checkbox"
                    disabled={!grantLoaded || !agentAvailable || busy}
                    checked={grant.inference}
                    onChange={(event) => setGrant({ ...grant, inference: event.target.checked })}
                  />
                  Allow {agentName} model requests
                </label>
              </fieldset>
            ) : null}
            {terminal !== "no-terminal" ? (
              <div className="settings-field">
                <span>Run commands on</span>
                <ChoicePicker
                  className="form-choice"
                  label="SSH execution target"
                  value={typeof sshTarget === "string" ? sshTarget : ""}
                  disabled={busy}
                  onChange={setSshTarget}
                  options={[
                    { value: "", label: "This computer" },
                    ...sshConnections.map((connection) => ({
                      value: connection.id,
                      label: `${connection.name} · ${connection.username}@${connection.host}`,
                    })),
                  ]}
                />
                {sshTarget ? (
                  <span className="text-xs">
                    Commands run over SSH on the selected machine and require its approval mode
                    above. Only basic paths relative to the remote login directory are allowed in
                    Workspace commands mode.
                  </span>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="settings-field">
              <span>Browser access</span>
              <ChoicePicker
                className="form-choice"
                label="Browser access"
                value={browser.mode}
                disabled={busy}
                onChange={(value) =>
                  setBrowser({ ...browser, mode: value as BrowserPermissions["mode"] })
                }
                options={[
                  { value: "off", label: "Off" },
                  { value: "observe", label: "Observe" },
                  { value: "interactive", label: "Interactive" },
                ]}
              />
            </div>
            {browser.mode !== "off" ? (
              <>
                <div className="settings-field">
                  <span>Session</span>
                  <ChoicePicker
                    className="form-choice"
                    label="Session"
                    value={browser.session}
                    disabled={busy}
                    onChange={(value) =>
                      setBrowser({ ...browser, session: value as BrowserPermissions["session"] })
                    }
                    options={[
                      { value: "separate", label: "Separate" },
                      { value: "default", label: "Saved logins" },
                    ]}
                  />
                </div>
                <div className="settings-field">
                  <span>Display</span>
                  <ChoicePicker
                    className="form-choice"
                    label="Display"
                    value={browser.display}
                    disabled={busy}
                    onChange={(value) =>
                      setBrowser({ ...browser, display: value as BrowserPermissions["display"] })
                    }
                    options={[
                      { value: "headless", label: "Background" },
                      { value: "window", label: "Visible window" },
                    ]}
                  />
                </div>
                <label>
                  Allowed website origins
                  <textarea
                    placeholder="* (all websites; also used when empty)"
                    value={origins}
                    onChange={(event) => setOrigins(event.target.value)}
                  />
                </label>
                <label>
                  Local test origins
                  <textarea
                    placeholder="http://localhost:3000"
                    value={localOrigins}
                    onChange={(event) => setLocalOrigins(event.target.value)}
                  />
                </label>
              </>
            ) : null}
          </>
        )}
        {error ? <p role="alert">{error}</p> : null}
        <button
          className="header-control"
          type="submit"
          disabled={
            busy ||
            (external &&
              (!grantLoaded ||
                !agentAvailable ||
                terminal !== "full-access" ||
                !grant.workspace ||
                !grant.inference))
          }
        >
          {busy ? "Saving…" : retryOnSave ? "Save and retry" : "Save"}
        </button>
      </form>
    </Modal>
  );
}
