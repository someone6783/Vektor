import { useState } from "react";
import {
  mcpGrantSchema,
  mcpServerInputSchema,
  type McpGrant,
  type McpServer,
  type McpServerInput,
  type McpSetup,
  type Profile,
} from "@vektor/shared";
import type { ApiClient } from "../lib/api";

const field = "rounded border border-white/15 bg-slate-950 p-2 text-sm";
const button = "rounded border border-white/15 px-3 py-1.5 text-xs disabled:opacity-40";
const blank = {
  ...mcpServerInputSchema.parse({ name: "New MCP server", transport: "stdio" }),
  name: "",
};

function ServerCard({
  client,
  server,
  profileId,
  initialGrant,
  refresh,
  edit,
  onError,
}: {
  client: ApiClient;
  server: McpServer;
  profileId: string;
  initialGrant: McpGrant;
  refresh: () => Promise<void>;
  edit: () => void;
  onError: (value: string) => void;
}) {
  const [grant, setGrant] = useState(initialGrant),
    [busy, setBusy] = useState(false);
  const [secrets, setSecrets] = useState([{ name: "", value: "" }]);
  const [args, setArgs] = useState("{}"),
    [preview, setPreview] = useState("");
  const action = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await refresh();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "MCP action failed.");
    } finally {
      setBusy(false);
    }
  };
  const toggle = (kind: "resources" | "templates" | "prompts", name: string) =>
    setGrant({
      ...grant,
      [kind]: grant[kind].includes(name)
        ? grant[kind].filter((n) => n !== name)
        : [...grant[kind], name],
    });
  const context = async (kind: "resource" | "template" | "prompt", name: string) => {
    const input = JSON.parse(args) as Record<string, string>;
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.values(input).some((v) => typeof v !== "string")
    )
      throw new Error("Context arguments must be a JSON object of strings.");
    const result = await client.previewMcp(profileId, server.id, kind, name, input);
    setPreview(result.text);
  };
  return (
    <article className="space-y-3 rounded-lg border border-white/10 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium">
          {server.name} · {server.transport} · {server.enabled ? "enabled" : "disabled"}
        </h4>
        <div className="flex gap-2">
          <button className={button} disabled={busy} onClick={edit}>
            Edit
          </button>
          <button
            className={button}
            disabled={busy}
            onClick={() => void action(() => client.testMcp(server.id))}
          >
            Test / reconnect
          </button>
          <button
            className={button}
            disabled={busy || (!server.enabled && !server.discovery)}
            onClick={() => void action(() => client.enableMcp(server.id, !server.enabled))}
          >
            {server.enabled ? "Disable" : "Enable"}
          </button>
          <button
            className={button}
            disabled={busy}
            onClick={() => void action(() => client.removeMcp(server.id))}
          >
            Remove
          </button>
        </div>
      </div>
      <p className="break-all text-xs text-slate-400">
        {server.transport === "stdio"
          ? `${server.command} ${JSON.stringify(server.args)} · workspace/${server.workingDirectory}`
          : server.url}
      </p>
      <p className="text-xs text-slate-400">
        {server.health.state} · {server.health.message}
        {server.health.retryAt > Date.now()
          ? ` · reconnect after ${new Date(server.health.retryAt).toLocaleTimeString()}`
          : ""}
      </p>
      {server.discovery ? (
        <p className="text-xs text-slate-400">
          MCP {server.discovery.protocolVersion} · {server.discovery.serverInfo.name}{" "}
          {server.discovery.serverInfo.version} · tested{" "}
          {new Date(server.discovery.checkedAt).toLocaleString()} · {server.discovery.tools.length}{" "}
          tools, {server.discovery.resources.length} resources, {server.discovery.templates.length}{" "}
          templates, {server.discovery.prompts.length} prompts
        </p>
      ) : null}
      {server.discovery?.warnings.map((w) => (
        <p key={w} className="text-xs text-amber-300">
          {w}
        </p>
      ))}
      <details>
        <summary className="cursor-pointer text-sm">
          Protected {server.transport === "stdio" ? "environment variables" : "headers"}
        </summary>
        <p className="my-2 text-xs text-slate-400">
          Configured names: {server.configuredSecretNames.join(", ") || "none"}. Values are
          write-only. Replacing them disables this server and requires a fresh test and grants.
        </p>
        <div className="space-y-2">
          {secrets.map((secret, index) => (
            <div className="flex gap-2" key={index}>
              <input
                className={field}
                aria-label={`${server.name} credential name ${index + 1}`}
                placeholder={server.transport === "stdio" ? "SERVICE_API_KEY" : "Authorization"}
                value={secret.name}
                onChange={(e) =>
                  setSecrets(
                    secrets.map((s, i) => (i === index ? { ...s, name: e.target.value } : s)),
                  )
                }
              />
              <input
                className={`${field} min-w-0 flex-1`}
                type="password"
                autoComplete="new-password"
                aria-label={`${server.name} credential value ${index + 1}`}
                value={secret.value}
                onChange={(e) =>
                  setSecrets(
                    secrets.map((s, i) => (i === index ? { ...s, value: e.target.value } : s)),
                  )
                }
              />
            </div>
          ))}
          <div className="flex gap-2">
            <button
              className={button}
              disabled={secrets.length >= 20 || busy}
              onClick={() => setSecrets([...secrets, { name: "", value: "" }])}
            >
              Add credential
            </button>
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await client.mcpCredentials(
                    server.id,
                    Object.fromEntries(
                      secrets.filter((s) => s.name.trim()).map((s) => [s.name.trim(), s.value]),
                    ),
                  );
                  setSecrets([{ name: "", value: "" }]);
                })
              }
            >
              Replace protected values
            </button>
          </div>
        </div>
      </details>
      {server.discovery && profileId ? (
        <details>
          <summary className="cursor-pointer text-sm">Profile tools and context grants</summary>
          <p className="my-2 text-xs text-slate-400">
            Every tool call requires approval, including tools marked read-only. Server hints do not
            grant access. Local read-only tools receive a read-only text snapshot; proposed writes
            from other tools require separate review.
          </p>
          <div className="space-y-2">
            {server.discovery.tools.map((tool) => {
              const selected = grant.tools.find((t) => t.name === tool.name);
              return (
                <div key={tool.name} className="rounded border border-white/10 p-2">
                  <label className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!!selected}
                      onChange={(e) =>
                        setGrant({
                          ...grant,
                          tools: e.target.checked
                            ? [...grant.tools, { name: tool.name, policy: "approval" }]
                            : grant.tools.filter((t) => t.name !== tool.name),
                        })
                      }
                    />
                    {tool.name}
                  </label>
                  <p className="my-1 whitespace-pre-wrap text-xs text-slate-400">
                    {tool.description}
                  </p>
                  <details className="my-2 text-xs text-slate-400">
                    <summary className="cursor-pointer">Declared schemas</summary>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(
                        {
                          input: tool.inputSchema,
                          ...(tool.outputSchema ? { output: tool.outputSchema } : {}),
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                  {selected ? (
                    <select
                      className={field}
                      aria-label={`${tool.name} policy`}
                      value={selected.policy}
                      onChange={(e) =>
                        setGrant({
                          ...grant,
                          tools: grant.tools.map((t) =>
                            t.name === tool.name
                              ? { ...t, policy: e.target.value as "read-only" | "approval" }
                              : t,
                          ),
                        })
                      }
                    >
                      <option value="approval">Approve calls and review file proposals</option>
                      {tool.annotations?.readOnlyHint === true ? (
                        <option value="read-only">Read-only snapshot; approve every call</option>
                      ) : null}
                    </select>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="my-3 flex flex-wrap gap-4 text-sm">
            <label>
              <input
                type="checkbox"
                checked={grant.externalRunners}
                onChange={(e) => setGrant({ ...grant, externalRunners: e.target.checked })}
              />{" "}
              Allow these tools in Codex / ACP runs
            </label>
            <label>
              <input
                type="checkbox"
                checked={grant.scheduled}
                onChange={(e) => setGrant({ ...grant, scheduled: e.target.checked })}
              />{" "}
              Allow explicitly declared scheduled jobs
            </label>
          </div>
          <p className="my-2 text-xs text-slate-400">
            Context sources are fetched only by Prepare preview. Save grants first, then review the
            preview and select it in the composer.
          </p>
          {server.discovery.resources.map((r) => (
            <div key={r.uri} className="my-2 flex flex-wrap justify-between gap-2 text-sm">
              <label>
                <input
                  type="checkbox"
                  checked={grant.resources.includes(r.uri)}
                  onChange={() => toggle("resources", r.uri)}
                />{" "}
                Resource: {r.name} · {r.uri}
              </label>
              <button
                className={button}
                disabled={busy}
                onClick={() => void action(() => context("resource", r.uri))}
              >
                Prepare preview
              </button>
            </div>
          ))}
          {server.discovery.templates.map((r) => (
            <div key={r.uriTemplate} className="my-2 flex flex-wrap justify-between gap-2 text-sm">
              <label>
                <input
                  type="checkbox"
                  checked={grant.templates.includes(r.uriTemplate)}
                  onChange={() => toggle("templates", r.uriTemplate)}
                />{" "}
                Template: {r.name} · {r.uriTemplate}
              </label>
              <button
                className={button}
                disabled={busy}
                onClick={() => void action(() => context("template", r.uriTemplate))}
              >
                Prepare preview
              </button>
            </div>
          ))}
          {server.discovery.prompts.map((p) => (
            <div key={p.name} className="my-2 flex flex-wrap justify-between gap-2 text-sm">
              <label>
                <input
                  type="checkbox"
                  checked={grant.prompts.includes(p.name)}
                  onChange={() => toggle("prompts", p.name)}
                />{" "}
                Prompt: {p.name}{" "}
                {p.arguments?.map((a) => `${a.name}${a.required ? "*" : ""}`).join(", ")}
              </label>
              <button
                className={button}
                disabled={busy}
                onClick={() => void action(() => context("prompt", p.name))}
              >
                Prepare preview
              </button>
            </div>
          ))}
          <label className="my-2 block text-xs">
            Prompt / template arguments (JSON object of strings)
            <textarea
              className={`${field} mt-1 block w-full font-mono`}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
            />
          </label>
          <button
            className={button}
            disabled={busy}
            onClick={() => void action(() => client.grantMcp(profileId, server.id, grant))}
          >
            Save MCP profile grants
          </button>
        </details>
      ) : null}
      {preview ? (
        <div>
          <p className="text-xs text-amber-200">
            Untrusted MCP preview. Available for explicit selection in the composer.
          </p>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
            {preview}
          </pre>
          <button className={button} onClick={() => setPreview("")}>
            Close preview
          </button>
        </div>
      ) : null}
    </article>
  );
}

export function McpSettings({ client, profiles }: { client: ApiClient; profiles: Profile[] }) {
  const [setup, setSetup] = useState<McpSetup | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [draft, setDraft] = useState<McpServerInput>(blank),
    [editing, setEditing] = useState<string>(),
    [args, setArgs] = useState("[]");
  const [environment, setEnvironment] = useState("{}");
  const load = async () => {
    setSetup(await client.mcpSetup());
  };
  const action = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "MCP action failed.");
    } finally {
      setBusy(false);
    }
  };
  const changeTransport = (transport: McpServerInput["transport"]) => {
    setDraft({ ...blank, name: draft.name, transport });
    setArgs("[]");
    setEnvironment("{}");
  };
  return (
    <section className="mcp-settings space-y-4 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <h3 className="text-sm font-semibold">MCP plugins</h3>
      <p className="text-sm text-slate-400">
        Connect your own optional tool and context servers. Servers start only when explicitly
        tested or used. Native chat works without plugins.
      </p>
      <button className={button} disabled={busy} onClick={() => void action(load)}>
        Load MCP settings
      </button>
      {error ? (
        <p role="alert" className="text-sm text-rose-300">
          {error}
        </p>
      ) : null}
      {setup ? (
        <>
          <label className="mcp-profile-field block text-sm">
            Profile for MCP grants
            <select
              className={`${field} mt-1 block w-full`}
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {setup.servers.map((server) => (
            <ServerCard
              key={`${server.id}:${server.revision}:${profileId}`}
              client={client}
              server={server}
              profileId={profileId}
              initialGrant={
                setup.grants.find((g) => g.serverId === server.id && g.profileId === profileId)
                  ?.grant ?? mcpGrantSchema.parse({})
              }
              refresh={load}
              onError={setError}
              edit={() => {
                setEditing(server.id);
                setDraft(mcpServerInputSchema.strip().parse(server));
                setArgs(JSON.stringify(server.args));
                setEnvironment(JSON.stringify(server.environment));
              }}
            />
          ))}
          <form
            className="space-y-3 rounded border border-white/10 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await client.configureMcp(
                  { ...draft, args: JSON.parse(args), environment: JSON.parse(environment) },
                  editing,
                );
                setDraft(blank);
                setArgs("[]");
                setEnvironment("{}");
                setEditing(undefined);
                await load();
              });
            }}
          >
            <h4 className="font-medium">{editing ? "Edit MCP server" : "Add MCP server"}</h4>
            <p className="text-xs text-slate-400">
              Saving only stores configuration. A new or edited server remains disabled until you
              test it and enable it. Editing clears protected values and previous grants.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm">
                Server name
                <input
                  required
                  className={`${field} mt-1 block w-full`}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="text-sm">
                Transport
                <select
                  className={`${field} mt-1 block w-full`}
                  value={draft.transport}
                  onChange={(e) => changeTransport(e.target.value as McpServerInput["transport"])}
                >
                  <option value="stdio">Local stdio</option>
                  <option value="http">Remote Streamable HTTP</option>
                </select>
              </label>
            </div>
            {draft.transport === "stdio" ? (
              <>
                <label className="block text-sm">
                  Installed executable
                  <input
                    required
                    className={`${field} mt-1 block w-full`}
                    placeholder="/opt/agents/my-mcp-server"
                    value={draft.command}
                    onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  />
                </label>
                <label className="block text-sm">
                  Arguments (JSON array)
                  <textarea
                    className={`${field} mt-1 block w-full font-mono`}
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  Working directory within Vektor workspace
                  <input
                    className={`${field} mt-1 block w-full`}
                    value={draft.workingDirectory}
                    onChange={(e) => setDraft({ ...draft, workingDirectory: e.target.value })}
                  />
                </label>
                <label className="block text-sm">
                  Non-secret environment (JSON object)
                  <textarea
                    className={`${field} mt-1 block w-full font-mono`}
                    value={environment}
                    onChange={(e) => setEnvironment(e.target.value)}
                  />
                  <span className="text-xs text-slate-400">
                    Use the protected environment section after saving for passwords and API keys.
                  </span>
                </label>
                <label className="block text-sm">
                  Allowed HTTPS hosts (one per line, empty blocks external network)
                  <textarea
                    className={`${field} mt-1 block w-full`}
                    value={draft.networkHosts.join("\n")}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        networkHosts: e.target.value.split(/\s+/).filter(Boolean),
                      })
                    }
                  />
                </label>
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.hostBinaryAcknowledged}
                    onChange={(e) =>
                      setDraft({ ...draft, hostBinaryAcknowledged: e.target.checked })
                    }
                  />{" "}
                  Allow this installed executable to run in isolation. Granted tools and context
                  sources can receive a text snapshot of this working directory.
                </label>
              </>
            ) : (
              <>
                <label className="block text-sm">
                  MCP endpoint
                  <input
                    required
                    type="url"
                    className={`${field} mt-1 block w-full`}
                    placeholder="https://service.example/mcp"
                    value={draft.url}
                    onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                  />
                </label>
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.allowLoopback}
                    onChange={(e) => setDraft({ ...draft, allowLoopback: e.target.checked })}
                  />{" "}
                  Allow this exact loopback service, including local HTTP. Vektor's backend listener
                  remains blocked.
                </label>
              </>
            )}
            <div className="flex gap-2">
              <button type="submit" className={button} disabled={busy}>
                Save disabled MCP server
              </button>
              {editing ? (
                <button
                  type="button"
                  className={button}
                  onClick={() => {
                    setEditing(undefined);
                    setDraft(blank);
                    setArgs("[]");
                    setEnvironment("{}");
                  }}
                >
                  Cancel edit
                </button>
              ) : null}
            </div>
          </form>
        </>
      ) : null}
    </section>
  );
}
