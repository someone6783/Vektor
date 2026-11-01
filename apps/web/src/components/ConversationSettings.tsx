import { useState } from "react";
import {
  browserPermissionsSchema,
  type Channel,
  type ConversationExecution,
  type Profile,
  type TerminalMode,
  type BrowserPermissions,
} from "@vektor/shared";
import { Modal } from "./Modal";

export function ConversationSettings({
  channel,
  profile,
  section,
  onSave,
  onClose,
}: {
  channel: Channel;
  profile: Profile;
  section: "terminal" | "browser";
  onSave: (execution: ConversationExecution) => Promise<void>;
  onClose: () => void;
}) {
  const [terminal, setTerminal] = useState(profile.terminalMode);
  const [browser, setBrowser] = useState(browserPermissionsSchema.parse(profile.browser ?? {}));
  const [origins, setOrigins] = useState(browser.allowedOrigins.join("\n"));
  const [localOrigins, setLocalOrigins] = useState(browser.localOrigins.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
                ? { terminalMode: terminal }
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
            await onSave(execution);
            onClose();
          } catch (error) {
            setError(error instanceof Error ? error.message : "Couldn’t save changes.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>Only this conversation.</p>
        {section === "terminal" ? (
          <>
            <label>
              Terminal access
              <select
                aria-label="Terminal access"
                value={terminal}
                onChange={(event) => setTerminal(event.target.value as TerminalMode)}
              >
                <option value="no-terminal">Off</option>
                <option value="basic">Workspace commands</option>
                <option value="full-access">Full access · approve each command</option>
                <option value="full-unrestricted">Full Unrestricted · no approvals</option>
              </select>
            </label>
          </>
        ) : (
          <>
            <label>
              Browser access
              <select
                value={browser.mode}
                onChange={(event) =>
                  setBrowser({ ...browser, mode: event.target.value as BrowserPermissions["mode"] })
                }
              >
                <option value="off">Off</option>
                <option value="observe">Observe</option>
                <option value="interactive">Interactive</option>
              </select>
            </label>
            {browser.mode !== "off" ? (
              <>
                <label>
                  Session
                  <select
                    value={browser.session}
                    onChange={(event) =>
                      setBrowser({
                        ...browser,
                        session: event.target.value as BrowserPermissions["session"],
                      })
                    }
                  >
                    <option value="separate">Separate</option>
                    <option value="default">Saved logins</option>
                  </select>
                </label>
                <label>
                  Display
                  <select
                    value={browser.display}
                    onChange={(event) =>
                      setBrowser({
                        ...browser,
                        display: event.target.value as BrowserPermissions["display"],
                      })
                    }
                  >
                    <option value="headless">Background</option>
                    <option value="window">Visible window</option>
                  </select>
                </label>
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
        <button className="header-control" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
    </Modal>
  );
}
