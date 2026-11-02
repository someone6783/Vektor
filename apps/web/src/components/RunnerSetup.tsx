import { useState } from "react";
import type { RunnerId, Profile, RunnerInstallationView, RunnerSetupView } from "@vektor/shared";
import type { ApiClient } from "../lib/api";

function InstallationCard({
  entry,
  client,
  action,
}: {
  entry: RunnerInstallationView;
  client: ApiClient;
  action: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const [credential, setCredential] = useState("");
  return (
    <article className="mt-4 rounded border border-white/10 p-3 text-xs">
      <h3>
        {entry.name} · {entry.version} ·{" "}
        {entry.compatible === false
          ? "Re-verification required"
          : entry.enabled
            ? "Enabled"
            : "Disabled"}
      </h3>
      {entry.compatibilityReason ? (
        <p className="mt-1 text-slate-400">{entry.compatibilityReason}</p>
      ) : null}
      <p className="mt-1 text-slate-400">
        {entry.interface} ·{" "}
        {entry.credentialConfigured
          ? "Separate API key configured; access is verified by a successful turn"
          : "Authentication missing"}
      </p>
      {entry.health ? (
        <p className="mt-1 text-slate-400">
          Last run health: {entry.health.state}
          {entry.health.retryAt > Date.now()
            ? ` · reconnect available after ${new Date(entry.health.retryAt).toLocaleTimeString()}`
            : ""}
          . Failed connections never restart tasks automatically.
        </p>
      ) : null}
      <p className="mt-1 break-all text-slate-500">
        Source: {entry.source}
        <br />
        Executable SHA-256: {entry.executableHash}
        <br />
        Inference hosts: {entry.inferenceHosts.join(", ")}
      </p>
      <p className="mt-1 text-slate-500">
        Agent/provider billing and quotas are separate from OpenRouter. Subscription access is not
        assumed.
      </p>
      <label className="mt-2 block">
        {entry.credentialName}
        <input
          aria-label={`Credential for ${entry.name}`}
          type="password"
          autoComplete="off"
          className="ml-2 bg-slate-950 p-2"
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          placeholder="Write-only API key"
        />
      </label>
      <div className="mt-2 flex flex-wrap gap-3">
        <button
          disabled={credential.length < 8}
          onClick={() => {
            const key = credential;
            setCredential("");
            void action(() => client.runnerCredential(entry.id, key));
          }}
        >
          Save credential
        </button>
        <button
          disabled={!entry.credentialConfigured}
          onClick={() => void action(() => client.runnerCredential(entry.id, null))}
        >
          Clear credential
        </button>
        <button
          disabled={!entry.enabled && (!entry.credentialConfigured || entry.compatible === false)}
          onClick={() => void action(() => client.enableRunner(entry.id, !entry.enabled))}
        >
          {entry.enabled ? "Disable agent" : "Enable agent"}
        </button>
        <button onClick={() => void action(() => client.removeRunner(entry.id))}>
          Remove agent
        </button>
      </div>
    </article>
  );
}
export function RunnerSetup({
  client,
  profiles = [],
  onInstallations,
}: {
  client: ApiClient;
  profiles?: Profile[];
  onInstallations?: (entries: RunnerInstallationView[]) => void;
}) {
  const [data, setData] = useState<RunnerSetupView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [kind, setKind] = useState<"codex-app-server" | "acp-v1">("codex-app-server");
  const [query, setQuery] = useState("");
  const [discovered, setDiscovered] = useState<Array<{ name: string; command: string }>>([]);
  const [selectedProbe, setSelectedProbe] = useState("");
  const [entryId, setEntryId] = useState("codex");
  const [hosts, setHosts] = useState("api.openai.com");
  const [credentialName, setCredentialName] = useState("OPENAI_API_KEY");
  const [trust, setTrust] = useState(false);
  function useOpenCode() {
    setKind("acp-v1");
    setArgs('["acp"]');
    setEntryId("acp:opencode");
    setHosts("openrouter.ai");
    setCredentialName("OPENROUTER_API_KEY");
    setSelectedProbe("");
    setTrust(false);
  }
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      const next = await client.runnerSetup();
      setData(next);
      onInstallations?.(next.installations ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Runner setup failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-6 rounded-xl border border-white/10 bg-slate-900 p-4">
      <h2 className="text-sm font-semibold">Agent runner setup</h2>
      <p className="mt-2 text-xs text-slate-400">
        Native chat uses OpenRouter. Codex, OpenCode and verified ACP agents use separate
        credentials and an isolated Linux session. Only approved Vektor tools can reach the real
        workspace. Grant workspace and inference access separately to each profile; Full access with
        per-action approvals is currently required.
      </p>
      <div className="mt-3 flex flex-wrap gap-3 text-xs">
        <button disabled={busy} onClick={() => void action(async () => {})}>
          Load setup
        </button>
        <button disabled={busy} onClick={() => void action(() => client.syncRunnerRegistry())}>
          Refresh official ACP registry
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void action(async () => setDiscovered((await client.discoverRunners()).executables))
          }
        >
          Find installed executables
        </button>
      </div>
      <div className="mt-3 text-xs">
        <button disabled={busy} onClick={useOpenCode}>
          Set up OpenCode
        </button>
        {entryId === "acp:opencode" ? (
          <p className="mt-2 text-slate-400">
            OpenCode uses ACP with arguments ["acp"]. Refresh the official registry, then probe the
            matching installed OpenCode binary. The preset uses a separate OpenRouter key and
            openrouter.ai; change the credential type and inference hosts for another provider.
            After enabling and granting access, select OpenCode in the profile and use agent-default
            or an advertised provider/model ID.
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-rose-300">
          {error}
        </p>
      ) : null}
      {discovered.length ? (
        <ul className="mt-2 text-xs">
          {discovered.map((entry) => (
            <li key={entry.command}>
              <button
                onClick={() => {
                  if (entry.name === "opencode") useOpenCode();
                  setCommand(entry.command);
                }}
              >
                {entry.name}: {entry.command} · Use path
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="mt-4 grid gap-2 text-xs"
        onSubmit={(event) => {
          event.preventDefault();
          void action(async () => {
            const parsed: unknown = JSON.parse(args);
            if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string"))
              throw new Error("Arguments must be a JSON array of strings.");
            const result = await client.probeRunner({ interface: kind, command, args: parsed });
            setSelectedProbe(result.executableHash);
          });
        }}
      >
        <label>
          Interface
          <select
            aria-label="Runner probe interface"
            className="ml-2 bg-slate-950 p-2"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="codex-app-server">Codex app-server</option>
            <option value="acp-v1">ACP v1</option>
          </select>
        </label>
        <label>
          Installed executable path
          <input
            aria-label="Agent executable path"
            className="ml-2 bg-slate-950 p-2"
            required
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder={
              entryId === "acp:opencode" ? "/usr/local/bin/opencode" : "/usr/local/bin/codex"
            }
          />
        </label>
        {kind === "acp-v1" ? (
          <label>
            Arguments (JSON)
            <input
              aria-label="Agent arguments"
              className="ml-2 bg-slate-950 p-2"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
            />
          </label>
        ) : null}
        <p className="text-slate-500">
          Probe launches only the executable you specify, without credentials or network. It does
          not install, log in, upgrade or start a task.
        </p>
        <button
          className="justify-self-start rounded border border-white/10 p-2"
          disabled={busy || !command.startsWith("/")}
        >
          Probe installed agent
        </button>
      </form>
      {data?.probes.map((probe) => (
        <article
          key={`${probe.command}:${probe.interface}`}
          className="mt-3 border-t border-white/10 pt-3 text-xs"
        >
          <p>
            {probe.agent?.name} {probe.agent?.version} · {probe.interface} · Handshake compatible;
            verification and enablement are separate
          </p>
          <p className="mt-1 break-all font-mono text-slate-500">
            {probe.command}
            <br />
            SHA-256 {probe.executableHash}
          </p>
          <button
            disabled={busy}
            className="mt-2"
            onClick={() => void action(() => client.removeRunnerProbe(probe.executableHash))}
          >
            Remove probe record
          </button>
        </article>
      ))}
      {data?.probes.length ? (
        <form
          className="mt-4 grid gap-2 border-t border-white/10 pt-3 text-xs"
          onSubmit={(event) => {
            event.preventDefault();
            void action(() =>
              client.configureRunner({
                id: entryId,
                executableHash: selectedProbe,
                inferenceHosts: hosts
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
                credentialName,
                ...(entryId === "codex" && trust ? { trustLocalCodex: true as const } : {}),
              }),
            );
          }}
        >
          <h3>Verify an agent or upgrade its pinned executable</h3>
          <label>
            Probe
            <select
              aria-label="Executable to verify"
              value={selectedProbe}
              onChange={(event) => setSelectedProbe(event.target.value)}
              className="ml-2 max-w-full bg-slate-950 p-2"
            >
              <option value="">Select a probe</option>
              {data.probes.map((probe) => (
                <option
                  key={`${probe.executableHash}:${probe.interface}`}
                  value={probe.executableHash}
                >
                  {probe.agent?.name} {probe.agent?.version} · {probe.interface} ·{" "}
                  {probe.executableHash.slice(0, 12)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Registry entry
            <select
              aria-label="Agent registry identity"
              className="ml-2 bg-slate-950 p-2"
              value={entryId}
              onChange={(event) => {
                setEntryId(event.target.value);
                setTrust(false);
              }}
            >
              <option value="codex">Codex · managed app-server</option>
              {!data.registry?.agents.some((entry) => entry.id === "opencode") &&
              entryId === "acp:opencode" ? (
                <option value="acp:opencode">OpenCode · refresh registry to verify</option>
              ) : null}
              {data.registry?.agents
                .filter((entry) => entry.id !== "codex-acp")
                .map((entry) => (
                  <option key={entry.id} value={`acp:${entry.id}`}>
                    {entry.name} {entry.version}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Inference hosts (comma separated)
            <input
              aria-label="Agent inference hosts"
              className="ml-2 bg-slate-950 p-2"
              value={hosts}
              onChange={(event) => setHosts(event.target.value)}
            />
          </label>
          <label>
            Credential type
            <select
              aria-label="Agent credential type"
              className="ml-2 bg-slate-950 p-2"
              value={credentialName}
              onChange={(event) => setCredentialName(event.target.value)}
            >
              {[
                "OPENAI_API_KEY",
                "OPENROUTER_API_KEY",
                "OPENCODE_API_KEY",
                "ANTHROPIC_API_KEY",
                "AMP_API_KEY",
                "MISTRAL_API_KEY",
              ].map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          {entryId === "codex" ? (
            <label>
              <input
                type="checkbox"
                checked={trust}
                onChange={(event) => setTrust(event.target.checked)}
              />{" "}
              I verified this local Codex executable and approve pinning the displayed hash. Only
              Codex 0.166.0 is supported.
            </label>
          ) : (
            <p className="text-slate-400">
              Verification downloads the official registry archive, checks its published checksum,
              and compares the installed executable. No archive is installed or executed. Entries
              without verifiable platform binaries remain unavailable.
            </p>
          )}
          <p className="text-slate-500">
            Adding or upgrading keeps the agent disabled. Review its source, configure its separate
            key, then enable it explicitly. The real workspace is accessed through Vektor tools;
            agent-local files are private scratch. Upgrading invalidates old-session resume.
          </p>
          <button
            disabled={busy || !selectedProbe || (entryId === "codex" && !trust)}
            className="justify-self-start rounded border border-white/10 p-2"
          >
            Verify and add agent
          </button>
        </form>
      ) : null}
      {data?.installations?.map((entry) => (
        <InstallationCard
          key={`${entry.id}:${entry.executableHash}`}
          entry={entry}
          client={client}
          action={action}
        />
      ))}
      {data && profiles.length ? (
        <div className="mt-4 border-t border-white/10 pt-3 text-xs">
          <h3>Profile grants</h3>
          <p className="mt-1 text-slate-500">
            Bind each profile grant to one selected agent, then enable workspace and inference
            access separately. Changing the agent clears both grants. Select the run's runner/model
            in the profile editor. Revocation cancels active external work; browser, desktop and MCP
            capabilities remain separate.
          </p>
          {profiles.map((profile) => {
            const grant = data.grants?.find((grant) => grant.profileId === profile.id) ?? {
              workspace: false,
              inference: false,
              runner: undefined,
            };
            return (
              <div key={profile.id} className="mt-2 flex flex-wrap gap-3">
                <span>{profile.name}</span>
                <select
                  aria-label={`${profile.name} granted agent`}
                  className="rounded bg-slate-950 p-1"
                  value={grant.runner ?? ""}
                  disabled={busy}
                  onChange={(event) => {
                    if (event.target.value)
                      void action(() =>
                        client.runnerGrant(profile.id, {
                          runner: event.target.value as RunnerId,
                          workspace: false,
                          inference: false,
                        }),
                      );
                  }}
                >
                  <option value="">Select an agent for this profile</option>
                  {data.installations?.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                  {grant.runner &&
                  !data.installations?.some((entry) => entry.id === grant.runner) ? (
                    <option value={grant.runner}>{grant.runner} · unconfigured</option>
                  ) : null}
                </select>
                {(["workspace", "inference"] as const).map((capability) => (
                  <label key={capability}>
                    <input
                      disabled={busy || !grant.runner}
                      type="checkbox"
                      aria-label={`${profile.name} runner ${capability} access`}
                      checked={grant[capability]}
                      onChange={(event) =>
                        void action(() =>
                          client.runnerGrant(profile.id, {
                            runner: grant.runner,
                            workspace: grant.workspace,
                            inference: grant.inference,
                            [capability]: event.target.checked,
                          }),
                        )
                      }
                    />{" "}
                    {capability === "workspace" ? "Real workspace" : "Configured inference hosts"}
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
      {data?.registry ? (
        <div className="mt-4 text-xs">
          <p className="text-slate-400">
            Official registry snapshot · {new Date(data.registry.checkedAt).toLocaleString()}
          </p>
          <p className="mt-1 text-slate-500">
            Registry provenance is advisory. Unverified entries cannot execute. Codex uses its
            app-server adapter; its ACP entry cannot run concurrently.
          </p>
          <input
            aria-label="Search ACP registry"
            className="mt-2 w-full bg-slate-950 p-2"
            placeholder="Search registry"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul className="mt-2 max-h-72 space-y-3 overflow-auto">
            {data.registry.agents
              .filter((agent) =>
                `${agent.name} ${agent.id} ${agent.authors.join(" ")}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((agent) => {
                const installed = data.installations?.find(
                  (entry) =>
                    entry.id === `acp:${agent.id}` ||
                    (agent.id === "codex-acp" && entry.id === "codex"),
                );
                return (
                  <li key={agent.id}>
                    <p>
                      {agent.name} · {agent.version} ·{" "}
                      {installed
                        ? installed.enabled
                          ? "Verified / enabled"
                          : "Verified / disabled"
                        : "Unverified / unavailable"}
                    </p>
                    <p className="text-slate-500">
                      {agent.authors.join(", ")} · {agent.description}
                    </p>
                  </li>
                );
              })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
