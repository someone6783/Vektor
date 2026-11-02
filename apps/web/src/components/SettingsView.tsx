import { RunnerSetup } from "./RunnerSetup";
import { useState } from "react";
import { setChunkedStreaming, useChunkedStreaming } from "../lib/streamingPreference";
import { AboutView } from "./AboutView";
import { BrowserProfileCard } from "./BrowserProfileCard";
import {
  runnerIdSchema,
  browserPermissionsSchema,
  computerPermissionsSchema,
  type BrowserPermissions,
  type ComputerPermissions,
  type ModelInfo,
  type Profile,
  type RunnerId,
  type RunnerInstallationView,
  type SettingsView,
  type TerminalMode,
} from "@vektor/shared";
import type { ApiClient } from "../lib/api";
import { HealthCard } from "./HealthCard";
import { UsageView } from "./UsageView";

interface SettingsViewProps {
  client: ApiClient;
  settings: SettingsView;
  profiles: Profile[];
  onSettingsChange: (settings: SettingsView) => void;
  onProfilesChange: () => Promise<void>;
  onError: (message: string) => void;
}

const terminalModes: Array<{ value: TerminalMode; label: string }> = [
  { value: "no-terminal", label: "No terminal" },
  { value: "basic", label: "Basic · workspace commands" },
  { value: "full-access", label: "Full access · approval required" },
  { value: "full-unrestricted", label: "Full Unrestricted · no approvals" },
];

const colors = ["emerald", "sky", "violet", "amber", "rose"] as const;

function ProfileEditor({
  client,
  profile,
  models,
  runners = [],
  onSaved,
  onError,
}: {
  client: ApiClient;
  profile: Profile;
  models: ModelInfo[];
  runners?: RunnerInstallationView[];
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(profile.name);
  const [model, setModel] = useState(profile.model);
  const [runner, setRunner] = useState<RunnerId>(profile.runner ?? "native");
  const [systemPrompt, setSystemPrompt] = useState(profile.systemPrompt);
  const [temperature, setTemperature] = useState(String(profile.temperature));
  const [maxTokens, setMaxTokens] = useState(String(profile.maxTokens));
  const [terminalMode, setTerminalMode] = useState<TerminalMode>(profile.terminalMode);
  const [terminalTool, setTerminalTool] = useState(profile.tools.includes("terminal"));
  const initialBrowser = browserPermissionsSchema.parse(profile.browser ?? {});
  const [browserMode, setBrowserMode] = useState<BrowserPermissions["mode"]>(initialBrowser.mode);
  const [browserSession, setBrowserSession] = useState<BrowserPermissions["session"]>(
    initialBrowser.session,
  );
  const [browserDisplay, setBrowserDisplay] = useState<BrowserPermissions["display"]>(
    initialBrowser.display,
  );
  const [origins, setOrigins] = useState(initialBrowser.allowedOrigins.join("\n"));
  const [localOrigins, setLocalOrigins] = useState(initialBrowser.localOrigins.join("\n"));
  const [localAcknowledged, setLocalAcknowledged] = useState(
    initialBrowser.localOrigins.length > 0,
  );
  const initialComputer = computerPermissionsSchema.parse(profile.computer ?? {});
  const [computerMode, setComputerMode] = useState<ComputerPermissions["mode"]>(
    initialComputer.mode,
  );
  const [computerWidth, setComputerWidth] = useState(String(initialComputer.width));
  const [computerHeight, setComputerHeight] = useState(String(initialComputer.height));
  const [computerAppName, setComputerAppName] = useState(initialComputer.apps[0]?.name ?? "");
  const [computerCommand, setComputerCommand] = useState(initialComputer.apps[0]?.command ?? "");
  const [computerArgs, setComputerArgs] = useState(
    (initialComputer.apps[0]?.args ?? []).join("\n"),
  );
  const [additionalComputerApps, setAdditionalComputerApps] = useState(
    initialComputer.apps
      .slice(1)
      .map((app) => ({ name: app.name, command: app.command, argsText: app.args.join("\n") })),
  );
  const [computerMaxActions, setComputerMaxActions] = useState(String(initialComputer.maxActions));
  const [computerMinutes, setComputerMinutes] = useState(
    String(initialComputer.maxDurationMs / 60_000),
  );
  const [computerArtifactDays, setComputerArtifactDays] = useState(
    String(initialComputer.artifactDays),
  );
  const [computerAcknowledged, setComputerAcknowledged] = useState(initialComputer.mode !== "off");
  const [fullAccessAcknowledged, setFullAccessAcknowledged] = useState(
    profile.terminalMode === "full-access",
  );
  const [color, setColor] = useState(profile.color);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (terminalMode === "full-access" && !fullAccessAcknowledged) {
      onError("Acknowledge the full-access warning before saving this profile.");
      return;
    }
    setBusy(true);
    try {
      const browser = browserPermissionsSchema.parse({
        mode: browserMode,
        session: browserSession,
        display: browserDisplay,
        allowedOrigins: origins.split(/\s+/).filter(Boolean),
        localOrigins: localOrigins.split(/\s+/).filter(Boolean),
      });
      if (browser.localOrigins.length && !localAcknowledged)
        throw new Error("Acknowledge the scoped local testing grant before saving.");
      const computer = computerPermissionsSchema.parse({
        mode: computerMode,
        width: Math.round(Number(computerWidth) || 1280),
        height: Math.round(Number(computerHeight) || 800),
        apps: computerCommand.trim()
          ? [
              {
                name: computerAppName.trim() || "Application",
                command: computerCommand.trim(),
                args: computerArgs
                  .split("\n")
                  .map((arg) => arg.trim())
                  .filter(Boolean),
              },
            ]
          : [],
        maxActions: Number(computerMaxActions),
        maxDurationMs: Math.round(Number(computerMinutes) * 60_000),
        artifactDays: Number(computerArtifactDays),
      });
      computer.apps.push(
        ...additionalComputerApps.map((app) => ({
          name: app.name,
          command: app.command,
          args: app.argsText.split("\n").filter(Boolean),
        })),
      );
      computerPermissionsSchema.parse(computer);
      if (computer.mode !== "off" && !computer.apps.length)
        throw new Error("Add the application command the isolated desktop should run.");
      if (computer.mode !== "off" && !computerAcknowledged)
        throw new Error("Acknowledge the isolated computer access warning before saving.");
      await client.updateProfile(profile.id, {
        name: name.trim() || profile.name,
        model: model.trim() || profile.model,
        runner,
        systemPrompt,
        temperature: Math.min(2, Math.max(0, Number(temperature) || 0)),
        maxTokens: Math.max(1, Math.round(Number(maxTokens) || 2048)),
        terminalMode,
        browser,
        computer,
        tools: [
          ...profile.tools.filter((tool) => tool !== "terminal"),
          ...(terminalTool && terminalMode !== "no-terminal" ? ["terminal"] : []),
        ],
        color,
      });
      await onSaved();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not save the profile.");
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!window.confirm(`Archive profile "${profile.name}"? This cannot be undone in the UI.`)) {
      return;
    }

    setBusy(true);
    try {
      await client.archiveProfile(profile.id);
      await onSaved();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not archive the profile.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-slate-950/40 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <label className="text-[10px] uppercase tracking-wide text-slate-500">Name</label>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-accent-400/50"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-slate-500">Color</label>
          <div className="mt-2 flex gap-1.5">
            {colors.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setColor(value)}
                aria-label={value}
                className={`h-5 w-5 rounded-full border-2 ${
                  color === value ? "border-white" : "border-transparent"
                }`}
                style={{ backgroundColor: `var(--profile-${value})` }}
              />
            ))}
          </div>
        </div>
      </div>

      <label className="mt-3 block text-xs text-slate-400">
        Runner
        <select
          aria-label={`Runner for ${profile.name}`}
          value={runner}
          onChange={(event) => setRunner(runnerIdSchema.parse(event.target.value))}
          className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950 p-2 text-slate-100"
        >
          <option value="native">Native · OpenRouter</option>
          <option value="codex">
            Codex ·{" "}
            {runners.find((entry) => entry.id === "codex")?.enabled
              ? "enabled"
              : "configure in Agent runner setup"}
          </option>
          {runners
            .filter((entry) => entry.id.startsWith("acp:"))
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} · {entry.enabled ? "enabled" : "disabled"}
              </option>
            ))}
          {runner !== "native" &&
          runner !== "codex" &&
          !runners.some((entry) => entry.id === runner) ? (
            <option value={runner}>{runner} · unavailable</option>
          ) : null}
        </select>
        <span className="mt-1 block">
          Codex uses separate authentication. Unavailable runners reject new runs; select Native to
          use OpenRouter.
        </span>
      </label>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-[10px] uppercase tracking-wide text-slate-500">Model</label>
          <input
            list={`models-${profile.id}`}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-accent-400/50"
          />
          <datalist id={`models-${profile.id}`}>
            {(runner === "native" ? models : []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </datalist>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-slate-500">
            Terminal mode
          </label>
          <select
            value={terminalMode}
            onChange={(event) => {
              setTerminalMode(event.target.value as TerminalMode);
              setTerminalTool(event.target.value !== "no-terminal");
              setFullAccessAcknowledged(false);
            }}
            id={`terminal-${profile.id}`}
            aria-label={`Terminal mode for ${profile.name}`}
            className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent-400/50"
          >
            {terminalModes.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-slate-500">Temperature</label>
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={temperature}
            onChange={(event) => setTemperature(event.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent-400/50"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-slate-500">
            Max output tokens
          </label>
          <input
            type="number"
            min={1}
            max={200000}
            value={maxTokens}
            onChange={(event) => setMaxTokens(event.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent-400/50"
          />
        </div>
      </div>

      <div className="mt-3">
        <label className="text-[10px] uppercase tracking-wide text-slate-500">System prompt</label>
        <textarea
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
          rows={4}
          className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-slate-950 px-2 py-2 text-xs leading-5 text-slate-100 outline-none focus:border-accent-400/50"
        />
      </div>

      <div className="mt-4 space-y-2 rounded-lg border border-white/10 p-3 text-xs text-slate-400">
        <label className="block">
          Browser access
          <select
            id={`browser-${profile.id}`}
            aria-label={`Browser access for ${profile.name}`}
            value={browserMode}
            onChange={(event) => {
              const mode = event.target.value as BrowserPermissions["mode"];
              if (browserMode === "off")
                setBrowserSession(mode === "observe" ? "default" : "separate");
              setBrowserMode(mode);
            }}
            className="ml-3 rounded border border-white/10 bg-slate-950 p-1"
          >
            <option value="off">Off</option>
            <option value="observe">Observation only</option>
            <option value="interactive">Interactive · approvals required</option>
          </select>
        </label>
        <p>
          Uses managed Chromium with independent browser and terminal permissions. Choose a saved
          default profile or a separate temporary session. Page content cannot approve actions.
          Navigation makes network requests and may have external effects even in observation mode.
        </p>
        {browserMode !== "off" ? (
          <>
            <label className="block">
              Browser profile
              <select
                aria-label={`Browser profile for ${profile.name}`}
                value={browserSession}
                onChange={(event) =>
                  setBrowserSession(event.target.value as BrowserPermissions["session"])
                }
                className="ml-3 rounded border border-white/10 bg-slate-950 p-1"
              >
                <option value="default">Default profile · saved logins and site storage</option>
                <option value="separate">
                  Separate session · starts clean, discarded after run
                </option>
              </select>
            </label>
            <p>
              {browserSession === "default"
                ? "Shares Vektor’s saved browser profile with other profiles that select Default. Only one run can use it at a time. Observation and interactive permissions still apply."
                : "Fully separate from the default profile and other runs. Cookies and site storage are cleared when the session closes. Interactive actions still require approvals."}
            </p>
            <label className="block">
              Browser window
              <select
                aria-label={`Browser window for ${profile.name}`}
                value={browserDisplay}
                onChange={(event) =>
                  setBrowserDisplay(event.target.value as BrowserPermissions["display"])
                }
                className="ml-3 rounded border border-white/10 bg-slate-950 p-1"
              >
                <option value="headless">Headless · use the run panel</option>
                <option value="window">Visible window · open on the backend desktop</option>
              </select>
            </label>
            <p>
              {browserDisplay === "window"
                ? "Opens a Chromium window on the backend machine. Local desktop backends show it on that desktop; Docker needs a connected display. Use the run panel to open/focus the window, then pause before manual interaction. This applies to new runs."
                : "Runs Chromium in the background. View snapshots and screenshots in the run panel."}
            </p>
            <label className="block">
              Allowed origins (one per line)
              <textarea
                aria-label={`Browser origins for ${profile.name}`}
                value={origins}
                onChange={(event) => setOrigins(event.target.value)}
                rows={2}
                placeholder="* (all websites; also used when empty)"
                className="mt-1 w-full rounded border border-white/10 bg-slate-950 p-2"
              />
            </label>
            <label className="block">
              Local test origins (exact loopback host and port)
              <textarea
                aria-label={`Local browser origins for ${profile.name}`}
                value={localOrigins}
                onChange={(event) => {
                  setLocalOrigins(event.target.value);
                  setLocalAcknowledged(false);
                }}
                rows={2}
                placeholder="http://127.0.0.1:3000"
                className="mt-1 w-full rounded border border-white/10 bg-slate-950 p-2"
              />
            </label>
            {localOrigins.trim() ? (
              <label className="flex gap-2 text-amber-200">
                <input
                  type="checkbox"
                  checked={localAcknowledged}
                  onChange={(event) => setLocalAcknowledged(event.target.checked)}
                />
                I grant browser access to only these local test services. In Docker, loopback refers
                to the container.
              </label>
            ) : null}
            <p>
              Clicks, uploads/downloads and network writes pause for approval. Private fields
              require takeover. Screenshot inputs are masked; artifacts expire after the backend
              retention period and can be deleted from the run timeline.
            </p>
          </>
        ) : null}
      </div>

      <div className="mt-4 space-y-2 rounded-lg border border-white/10 p-3 text-xs text-slate-400">
        <label className="block">
          Computer access
          <select
            id={`computer-${profile.id}`}
            aria-label={`Computer access for ${profile.name}`}
            value={computerMode}
            onChange={(event) => {
              const mode = event.target.value as ComputerPermissions["mode"];
              if (mode !== "off") setComputerAcknowledged(false);
              setComputerMode(mode);
            }}
            className="ml-3 rounded border border-white/10 bg-slate-950 p-1"
          >
            <option value="off">Off</option>
            <option value="observe">Observation only · screenshots</option>
            <option value="control">Control · each action requires approval</option>
          </select>
        </label>
        <p>
          Runs one allowed application in a fresh Xvfb virtual desktop on the backend. This does not
          control the user&apos;s real desktop. Screenshots and window titles are untrusted. The
          session closes with the run, cancellation or emergency stop.
        </p>
        {computerMode !== "off" ? (
          <>
            <div className="flex flex-wrap gap-2">
              <label>
                Width
                <input
                  aria-label={`Computer width for ${profile.name}`}
                  value={computerWidth}
                  onChange={(event) => setComputerWidth(event.target.value)}
                  inputMode="numeric"
                  className="ml-2 w-20 rounded border border-white/10 bg-slate-950 p-1"
                />
              </label>
              <label>
                Height
                <input
                  aria-label={`Computer height for ${profile.name}`}
                  value={computerHeight}
                  onChange={(event) => setComputerHeight(event.target.value)}
                  inputMode="numeric"
                  className="ml-2 w-20 rounded border border-white/10 bg-slate-950 p-1"
                />
              </label>
            </div>
            <label className="block">
              Application name
              <input
                aria-label={`Computer application name for ${profile.name}`}
                value={computerAppName}
                onChange={(event) => setComputerAppName(event.target.value)}
                placeholder="Test application"
                className="mt-1 w-full rounded border border-white/10 bg-slate-950 p-2"
              />
            </label>
            <label className="block">
              Application command (absolute path)
              <input
                aria-label={`Computer application command for ${profile.name}`}
                value={computerCommand}
                onChange={(event) => setComputerCommand(event.target.value)}
                placeholder="/usr/bin/xmessage"
                className="mt-1 w-full rounded border border-white/10 bg-slate-950 p-2"
              />
            </label>
            <label className="block">
              Arguments (one per line)
              <textarea
                aria-label={`Computer application arguments for ${profile.name}`}
                value={computerArgs}
                onChange={(event) => setComputerArgs(event.target.value)}
                rows={2}
                placeholder="Phase 10 test"
                className="mt-1 w-full rounded border border-white/10 bg-slate-950 p-2"
              />
            </label>
            {additionalComputerApps.map((app, index) => (
              <div key={index} className="space-y-2 rounded border border-white/10 p-2">
                <label>
                  Application {index + 2} name
                  <input
                    aria-label={`Additional application ${index + 2} name`}
                    value={app.name}
                    onChange={(event) =>
                      setAdditionalComputerApps((values) =>
                        values.map((value, i) =>
                          i === index ? { ...value, name: event.target.value } : value,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Command
                  <input
                    aria-label={`Additional application ${index + 2} command`}
                    value={app.command}
                    onChange={(event) =>
                      setAdditionalComputerApps((values) =>
                        values.map((value, i) =>
                          i === index ? { ...value, command: event.target.value } : value,
                        ),
                      )
                    }
                    placeholder="/usr/bin/xmessage"
                  />
                </label>
                <label>
                  Arguments (one per line)
                  <textarea
                    aria-label={`Additional application ${index + 2} arguments`}
                    value={app.argsText}
                    onChange={(event) =>
                      setAdditionalComputerApps((values) =>
                        values.map((value, i) =>
                          i === index ? { ...value, argsText: event.target.value } : value,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  onClick={() =>
                    setAdditionalComputerApps((values) => values.filter((_, i) => i !== index))
                  }
                >
                  Remove application {index + 2}
                </button>
              </div>
            ))}
            <button
              disabled={additionalComputerApps.length >= 4}
              onClick={() =>
                setAdditionalComputerApps((values) => [
                  ...values,
                  { name: "Application", command: "", argsText: "" },
                ])
              }
            >
              Add allowed application
            </button>
            <div className="flex flex-wrap gap-3">
              <label>
                Action limit
                <input
                  aria-label={`Computer action limit for ${profile.name}`}
                  type="number"
                  min="1"
                  max="200"
                  value={computerMaxActions}
                  onChange={(event) => setComputerMaxActions(event.target.value)}
                />
              </label>
              <label>
                Time limit (minutes)
                <input
                  aria-label={`Computer time limit for ${profile.name}`}
                  type="number"
                  min="1"
                  max="30"
                  value={computerMinutes}
                  onChange={(event) => setComputerMinutes(event.target.value)}
                />
              </label>
              <label>
                Screenshot retention (days; 0 disables)
                <input
                  aria-label={`Computer screenshot retention for ${profile.name}`}
                  type="number"
                  min="0"
                  max="30"
                  value={computerArtifactDays}
                  onChange={(event) => setComputerArtifactDays(event.target.value)}
                />
              </label>
            </div>
            <label className="flex gap-2 text-amber-200">
              <input
                type="checkbox"
                checked={computerAcknowledged}
                onChange={(event) => setComputerAcknowledged(event.target.checked)}
              />
              I understand the agent can see and control only this isolated virtual desktop, and
              that every automated input still requires my approval. The application runs with the
              backend account’s file and network access. Use trusted applications and avoid
              passwords or payment details; sensitive-field protection is not available yet.
            </label>
          </>
        ) : null}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <p className="text-[11px] leading-5 text-slate-400">
          {terminalMode === "no-terminal"
            ? "Command execution is disabled, including unsolicited tool requests."
            : terminalMode === "basic"
              ? "Basic mode allows pwd, ls, cat, head, tail, wc, mkdir, and touch with restricted options and checked workspace paths. No shell, scripts, interpreters, or symlinks. This is a guardrail, not a hardened sandbox; the container boundary provides isolation."
              : terminalMode === "full-unrestricted"
                ? "Full Unrestricted runs commands without approval and can read or modify files outside the workspace with the backend account's permissions. Docker commands run inside the container; a local backend runs commands on your host."
                : "Full access can read or modify files outside the workspace with the backend account's permissions. Docker commands run inside the container; a local backend runs commands on your host. Every command requires approval."}
        </p>
      </div>
      {terminalMode !== "no-terminal" ? (
        <label className="mt-2 flex gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={terminalTool}
            onChange={(event) => setTerminalTool(event.target.checked)}
          />
          Enable terminal tool for this profile
        </label>
      ) : null}
      {terminalMode === "full-access" ? (
        <label className="mt-2 flex gap-2 text-xs text-amber-200">
          <input
            type="checkbox"
            checked={fullAccessAcknowledged}
            onChange={(event) => setFullAccessAcknowledged(event.target.checked)}
          />
          I understand full access can affect files outside the workspace.
        </label>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || (terminalMode === "full-access" && !fullAccessAcknowledged)}
          className="rounded-lg bg-accent-400 px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-40"
        >
          Save profile
        </button>
        <button
          type="button"
          onClick={() => void archive()}
          disabled={busy}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-400 hover:text-rose-300 disabled:opacity-40"
        >
          Archive
        </button>
        <p className="ml-auto text-[10px] text-slate-600">
          Changes apply to new runs; revoked terminal permissions stop further tool execution.
        </p>
      </div>
    </div>
  );
}

export function SettingsView({
  client,
  settings,
  profiles,
  onSettingsChange,
  onProfilesChange,
  onError,
}: SettingsViewProps) {
  const [runners, setRunners] = useState<RunnerInstallationView[]>([]);
  const chunkedStreaming = useChunkedStreaming();
  const [keyDraft, setKeyDraft] = useState("");
  const [defaultModel, setDefaultModel] = useState(settings.defaultModel);
  const [newName, setNewName] = useState("");
  const [newModel, setNewModel] = useState(settings.defaultModel);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const fail = (message: string) => {
    setFormError(message);
    onError(message);
  };

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key) {
      return;
    }

    setBusy(true);
    setFormError(null);
    try {
      const next = await client.updateSettings({ openRouterKey: key });
      onSettingsChange(next);
      setKeyDraft("");
      setTestResult("Key saved. Test the connection to refresh models.");
    } catch (error) {
      fail(error instanceof Error ? error.message : "Could not save the key.");
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const next = await client.updateSettings({ openRouterKey: null });
      onSettingsChange(next);
      setTestResult("Stored key cleared.");
    } catch (error) {
      fail(error instanceof Error ? error.message : "Could not clear the key.");
    } finally {
      setBusy(false);
    }
  };

  const saveDefaultModel = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const next = await client.updateSettings({ defaultModel: defaultModel.trim() });
      onSettingsChange(next);
    } catch (error) {
      fail(error instanceof Error ? error.message : "Could not save the default model.");
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setTestResult(null);
    setFormError(null);
    try {
      const result = await client.testProvider();
      const next = await client.getSettings();
      onSettingsChange(next);
      setTestResult(`Connected. ${result.models.length} models available.`);
    } catch (error) {
      setTestResult(error instanceof Error ? error.message : "Connection test failed.");
    } finally {
      setBusy(false);
    }
  };

  const createProfile = async () => {
    const name = newName.trim();
    const model = newModel.trim();
    if (!name || !model) {
      return;
    }

    setBusy(true);
    setFormError(null);
    try {
      await client.createProfile({ name, model });
      setNewName("");
      await onProfilesChange();
    } catch (error) {
      fail(error instanceof Error ? error.message : "Could not create the profile.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-400">
            Settings
          </p>
          <h1 className="mt-2 text-2xl font-semibold">Providers, models, and profiles</h1>
        </div>

        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <h2 className="text-sm font-medium text-slate-200">Preferences</h2>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={chunkedStreaming}
              onChange={(event) => setChunkedStreaming(event.target.checked)}
            />
            Stream replies by paragraph
          </label>
          <p className="mt-1 text-xs text-slate-500">
            Show complete paragraphs instead of word by word. Tool calls and the end of a turn
            reveal any remaining text. Saved on this device.
          </p>
        </section>

        {formError ? (
          <p className="rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs text-rose-200">
            {formError}
          </p>
        ) : null}

        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium text-slate-200">OpenRouter</h2>
              <p className="mt-1 text-xs text-slate-500">
                {settings.openRouterSource === "env"
                  ? "Configured by VEKTOR_OPENROUTER_KEY. The environment key overrides stored settings."
                  : settings.openRouterConfigured
                    ? "A key is stored encrypted with /data/secrets.key."
                    : "No key configured. Chat uses the deterministic stub provider."}
              </p>
            </div>
            <span
              className={`rounded-full border px-3 py-1 text-[11px] ${
                settings.openRouterConfigured
                  ? "border-accent-400/30 bg-accent-400/10 text-accent-300"
                  : "border-amber-400/30 bg-amber-400/10 text-amber-200"
              }`}
            >
              {settings.openRouterConfigured ? "Configured" : "Stub mode"}
            </span>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <input
              type="password"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              placeholder="sk-or-v1-… (write-only)"
              autoComplete="off"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-accent-400/50"
            />
            <button
              type="button"
              onClick={() => void saveKey()}
              disabled={busy || keyDraft.trim().length === 0}
              className="rounded-lg bg-accent-400 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-40"
            >
              Save key
            </button>
            <button
              type="button"
              onClick={() => void test()}
              disabled={busy}
              className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-200 hover:bg-white/5 disabled:opacity-40"
            >
              Test connection
            </button>
            <button
              type="button"
              onClick={() => void clearKey()}
              disabled={busy || !settings.openRouterConfigured}
              className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-400 hover:text-rose-300 disabled:opacity-40"
            >
              Clear stored key
            </button>
          </div>

          {testResult ? (
            <p className="mt-3 rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-xs text-slate-300">
              {testResult}
            </p>
          ) : null}

          <p className="mt-3 text-[10px] text-slate-600">
            Keys are encrypted at rest and never returned by the API. A test fetches the OpenRouter
            model list and caches it for the picker.
          </p>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <h2 className="text-sm font-medium text-slate-200">Default model</h2>
          <p className="mt-1 text-xs text-slate-500">
            Used for new profiles and the dev provider. Existing profiles keep their own model.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              list="settings-models"
              value={defaultModel}
              onChange={(event) => setDefaultModel(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-accent-400/50"
            />
            <datalist id="settings-models">
              {settings.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </datalist>
            <button
              type="button"
              onClick={() => void saveDefaultModel()}
              disabled={busy || defaultModel.trim().length === 0}
              className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-200 hover:bg-white/5 disabled:opacity-40"
            >
              Save default
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium text-slate-200">Profiles</h2>
              <p className="mt-1 text-xs text-slate-500">
                Prompt, model, parameters, and terminal mode. The header switcher applies a profile
                to the active channel.
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {profiles.map((profile) => (
              <ProfileEditor
                key={profile.id}
                client={client}
                profile={profile}
                models={settings.models}
                runners={runners}
                onSaved={onProfilesChange}
                onError={fail}
              />
            ))}
          </div>

          <div className="mt-5 rounded-xl border border-dashed border-white/10 p-4">
            <h3 className="text-xs font-medium text-slate-300">New profile</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Name"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent-400/50"
              />
              <input
                value={newModel}
                onChange={(event) => setNewModel(event.target.value)}
                placeholder="Model"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-accent-400/50"
              />
              <button
                type="button"
                onClick={() => void createProfile()}
                disabled={busy || !newName.trim() || !newModel.trim()}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/5 disabled:opacity-40"
              >
                Create
              </button>
            </div>
          </div>
        </section>

        <UsageView client={client} />
        <BrowserProfileCard client={client} />
        <HealthCard />
        <RunnerSetup client={client} profiles={profiles} onInstallations={setRunners} />
        <McpSettings client={client} profiles={profiles} />
        <AboutView client={client} />
      </div>
    </div>
  );
}
import { McpSettings } from "./McpSettings";
