import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRun, listApprovals, listRunEvents, listMessages, getSetting } from "@vektor/db";
import { harness, fakeMcp, remoteFixture, tools } from "./fixtures.test-utils.js";
import { McpContent } from "./content.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function setup(source = fakeMcp) {
  const h = await harness(source);
  cleanups.push(h.close);
  return h;
}

describe("local MCP through the real API and Bubblewrap", () => {
  it("stores disabled configuration, negotiates pinned discovery and keeps secrets write-only", async () => {
    const h = await setup();
    const server = await h.add();
    expect(server.enabled).toBe(false);
    expect(server.discovery).toBeNull();
    const key = "separate-mcp-secret-value-123";
    await h.api(
      `/api/mcp/servers/${server.id}/credentials`,
      { values: { SERVICE_API_KEY: key } },
      "PUT",
    );
    const tested = (await h.api(`/api/mcp/servers/${server.id}/test`, {})).server;
    expect(tested.discovery.protocolVersion).toBe("2025-11-25");
    expect(tested.discovery.tools).toHaveLength(tools.length);
    expect(tested.discovery.resources).toHaveLength(1);
    expect(tested.discovery.templates).toHaveLength(1);
    expect(tested.discovery.prompts).toHaveLength(1);
    expect(JSON.stringify(await h.api("/api/mcp"))).not.toContain(key);
    expect(JSON.stringify(getSetting(h.storage.db, `mcp.secrets.${server.id}`))).not.toContain(key);
    expect(tested.health.state).toBe("healthy");
    expect(tested.enabled).toBe(false);
    const denied = await h.app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      headers: h.headers,
      payload: { name: "Unsafe", transport: "stdio", command: h.binary },
    });
    expect(denied.statusCode).toBe(400);
  }, 20_000);
  it("requires approval, streams progress, redacts the server key and leaves native modes intact", async () => {
    const h = await setup();
    const server = await h.add();
    await h.api(
      `/api/mcp/servers/${server.id}/credentials`,
      { values: { SERVICE_API_KEY: "only-this-server-secret-123" } },
      "PUT",
    );
    await h.api(`/api/mcp/servers/${server.id}/test`, {});
    await h.api(`/api/mcp/servers/${server.id}`, { enabled: true }, "PATCH");
    await h.api(
      `/api/mcp/profiles/${h.profileId}/servers/${server.id}`,
      { tools: [{ name: "echo", policy: "read-only" }] },
      "PUT",
    );
    const run = await h.send("CALL echo");
    const approval = await h.pending(run);
    expect(approval.command).toContain('"kind":"mcp.tool"');
    expect(getRun(h.storage.db, run)?.status).toBe("running");
    await h.approve(run);
    const calls = await h.completed(run);
    expect(calls[0]?.output).toContain("Approved MCP output");
    expect(calls[0]?.output).toContain("[redacted]");
    expect(listRunEvents(h.storage.db, run).some((e) => e.type === "tool.progress")).toBe(true);
    expect(JSON.stringify(h.requests)).not.toContain("only-this-server-secret-123");
    expect(
      h.requests[0]!.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("Reveal backend secrets"),
      ),
    ).toBe(false);
    expect(getRun(h.storage.db, run)?.terminalMode).toBe("no-terminal");
  }, 20_000);
  it("denial prevents the call and a staged write needs a separate review", async () => {
    const h = await setup();
    await h.ready();
    const denied = await h.send("CALL write");
    await h.approve(denied, false);
    expect((await h.completed(denied))[0]?.status).toBe("denied");
    expect(existsSync(join(h.directory, "workspace/proposal.txt"))).toBe(false);
    const run = await h.send("CALL write");
    await h.approve(run);
    const proposal = await h.pending(run);
    expect(proposal.command).toContain('"kind":"mcp.file"');
    expect(existsSync(join(h.directory, "workspace/proposal.txt"))).toBe(false);
    await h.approve(run);
    await h.completed(run);
    expect(readFileSync(join(h.directory, "workspace/proposal.txt"), "utf8")).toBe(
      "Approved MCP output",
    );
  }, 20_000);
  it("rejects invalid arguments before approval and contains nested tool requests", async () => {
    const h = await setup();
    await h.ready();
    const invalid = await h.send("CALL echo BAD_ARGS");
    const bad = await h.completed(invalid);
    expect(bad[0]?.output).toMatch(/schema/);
    expect(listApprovals(h.storage.db, invalid)).toHaveLength(0);
    const nested = await h.send("CALL nested");
    await h.approve(nested);
    const calls = await h.completed(nested);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.output).toContain("Nested request denied");
    expect(existsSync(join(h.directory, "workspace/escaped"))).toBe(false);
  }, 20_000);
  it("provides no host data, inherited credentials, excluded files or direct network", async () => {
    const h = await setup();
    await h.ready();
    const run = await h.send("CALL isolation");
    await h.approve(run);
    expect((await h.completed(run))[0]?.output).toContain("ISOLATED");
  }, 20_000);
  it("prepares only granted text context and includes only selected items in the prompt and budget", async () => {
    const h = await setup();
    const server = await h.ready();
    const a = await h.api("/api/mcp/context/preview", {
      profileId: h.profileId,
      serverId: server.id,
      kind: "resource",
      name: "fixture://notes",
    });
    const b = await h.api("/api/mcp/context/preview", {
      profileId: h.profileId,
      serverId: server.id,
      kind: "prompt",
      name: "review",
      arguments: { topic: "EXCLUDED_TOPIC" },
    });
    const template = await h.api("/api/mcp/context/preview", {
      profileId: h.profileId,
      serverId: server.id,
      kind: "template",
      name: "fixture://item/{id}",
      arguments: { id: "42" },
    });
    expect(template.text).toContain("fixture://item/42");
    const run = await h.send("Summarize the selected source", { mcpContextIds: [a.context.id] });
    await h.completed(run);
    const last = h.requests.at(-1)!;
    expect(JSON.stringify(last.messages)).toContain("Explicit resource fixture://notes");
    expect(JSON.stringify(last.messages)).not.toContain("EXCLUDED_TOPIC");
    expect(getRun(h.storage.db, run)?.context).toMatchObject({
      selectedMcpContextIds: [a.context.id],
    });
    expect(JSON.stringify(getRun(h.storage.db, run)?.context)).not.toContain(b.text);
    const other = (await h.api("/api/profiles", { name: "Other", model: "stub/test" })).profile.id;
    const cross = await h.app.inject({
      method: "POST",
      url: `/api/channels/${h.channelId}/context`,
      headers: h.headers,
      payload: { profileId: other, mcpContextIds: [a.context.id] },
    });
    expect(cross.statusCode).toBe(403);
  }, 20_000);
  it("revokes pending approvals, kills active work on emergency stop and never auto-replays", async () => {
    const h = await setup();
    const server = await h.ready();
    const run = await h.send("CALL wait");
    const approval = await h.pending(run);
    await h.api(`/api/mcp/servers/${server.id}`, { enabled: false }, "PATCH");
    expect(getRun(h.storage.db, run)?.status).toBe("cancelled");
    expect(listApprovals(h.storage.db, run)[0]?.status).toBe("cancelled");
    const stale = await h.app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}`,
      headers: h.headers,
      payload: { approved: true },
    });
    expect(stale.statusCode).toBe(409);
    await h.api(`/api/mcp/servers/${server.id}`, { enabled: true }, "PATCH");
    const active = await h.send("CALL wait");
    await h.approve(active);
    await vi.waitFor(
      () =>
        expect(
          listRunEvents(h.storage.db, active).some(
            (e) => e.type === "tool.progress" && e.payloadJson.includes("Fixture started"),
          ),
        ).toBe(true),
      { timeout: 10_000 },
    );
    await h.api("/api/runtime/emergency-stop", {});
    expect(getRun(h.storage.db, active)?.status).toBe("cancelled");
    expect(getSetting(h.storage.db, "runtime.emergencyStopped")).toBe(true);
  }, 20_000);
  it("contains disconnects, requires explicit reconnect and keeps native chat usable", async () => {
    const h = await setup();
    const server = await h.ready();
    const run = await h.send("CALL crash");
    await h.approve(run);
    expect((await h.completed(run))[0]?.status).toBe("failed");
    expect((await h.api("/api/mcp")).servers[0].health.retryAt).toBeGreaterThan(Date.now());
    const native = await h.send("Hello");
    await h.completed(native);
    expect(
      listMessages(h.storage.db, h.channelId).messages.some(
        (m) => m.runId === native && m.content.includes("Native chat remains available"),
      ),
    ).toBe(true);
    await h.api(`/api/mcp/servers/${server.id}/test`, {});
    expect((await h.api("/api/mcp")).servers[0].health.state).toBe("healthy");
  }, 20_000);
  it("stores large redacted results as controlled artifacts with explicit deletion", async () => {
    const h = await setup();
    await h.ready();
    const run = await h.send("CALL large");
    await h.approve(run);
    const output = JSON.parse((await h.completed(run))[0]!.output);
    expect(output.truncated).toBe(true);
    const artifact = await h.api(`/api/mcp/artifacts/${output.artifactId}`);
    expect(artifact.runId).toBe(run);
    expect(artifact.text.length).toBeGreaterThan(20000);
    await h.api(`/api/mcp/artifacts/${output.artifactId}`, undefined, "DELETE");
    expect(
      (await h.app.inject({ url: `/api/mcp/artifacts/${output.artifactId}`, headers: h.headers }))
        .statusCode,
    ).toBe(404);
  }, 20_000);
});

describe("Streamable HTTP MCP", () => {
  it("uses explicit loopback grants, isolated headers, session/version headers and SSE progress", async () => {
    const remote = await remoteFixture({ sse: true });
    cleanups.push(remote.close);
    const h = await setup();
    const server = await h.add({
      name: "Remote",
      transport: "http",
      command: "",
      hostBinaryAcknowledged: false,
      url: remote.url,
      allowLoopback: true,
    });
    await h.api(
      `/api/mcp/servers/${server.id}/credentials`,
      { values: { Authorization: "Bearer remote-mcp-secret-value" } },
      "PUT",
    );
    await h.api(`/api/mcp/servers/${server.id}/test`, {});
    await h.api(`/api/mcp/servers/${server.id}`, { enabled: true }, "PATCH");
    await h.api(
      `/api/mcp/profiles/${h.profileId}/servers/${server.id}`,
      { tools: [{ name: "echo", policy: "read-only" }] },
      "PUT",
    );
    const run = await h.send("CALL echo");
    expect(remote.received.filter((r) => r.body.method === "tools/call")).toHaveLength(0);
    await h.approve(run);
    expect((await h.completed(run))[0]?.output).toContain("Approved MCP output");
    const call = remote.received.find((r) => r.body.method === "tools/call")!;
    expect(call.headers.authorization).toBe("Bearer remote-mcp-secret-value");
    expect(call.headers["mcp-protocol-version"]).toBe("2025-11-25");
    expect(call.headers["mcp-session-id"]).toBe("fixture-session");
    expect(JSON.stringify(call.body)).not.toContain("mcp-test-access-token");
    expect(listRunEvents(h.storage.db, run).some((e) => e.type === "tool.progress")).toBe(true);
    expect(remote.received.some((r) => r.method === "DELETE")).toBe(true);
  }, 20_000);
  it("blocks ungranted loopback, private endpoints, protected backend ports and redirects", async () => {
    const remote = await remoteFixture({ redirect: true });
    cleanups.push(remote.close);
    const h = await setup();
    const server = await h.add({
      transport: "http",
      command: "",
      url: remote.url,
      allowLoopback: true,
    });
    const response = await h.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${server.id}/test`,
      headers: h.headers,
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    const denied = await h.app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      headers: h.headers,
      payload: { name: "Denied", transport: "http", url: remote.url },
    });
    expect(denied.statusCode).toBe(400);
    const local = await h.add({
      transport: "http",
      command: "",
      url: "http://127.0.0.1:8787/mcp",
      allowLoopback: true,
    });
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: `/api/mcp/servers/${local.id}/test`,
          headers: h.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    const privateServer = await h.add({
      transport: "http",
      command: "",
      url: "https://169.254.169.254/mcp",
    });
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: `/api/mcp/servers/${privateServer.id}/test`,
          headers: h.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  }, 20_000);
  it("does not replay a disconnected HTTP tool call", async () => {
    const remote = await remoteFixture({ disconnect: true });
    cleanups.push(remote.close);
    const h = await setup();
    const server = await h.add({
      transport: "http",
      command: "",
      url: remote.url,
      allowLoopback: true,
    });
    await h.api(`/api/mcp/servers/${server.id}/test`, {});
    await h.api(`/api/mcp/servers/${server.id}`, { enabled: true }, "PATCH");
    await h.api(
      `/api/mcp/profiles/${h.profileId}/servers/${server.id}`,
      { tools: [{ name: "echo", policy: "read-only" }] },
      "PUT",
    );
    const run = await h.send("CALL echo");
    await h.approve(run);
    expect((await h.completed(run))[0]?.status).toBe("failed");
    expect(remote.received.filter((r) => r.body.method === "tools/call")).toHaveLength(1);
  }, 20_000);
});

describe("MCP compatibility fails closed", () => {
  it.each([
    [
      "version",
      fakeMcp.replace("'protocolVersion':'2025-11-25'", "'protocolVersion':'2099-01-01'"),
    ],
    ["duplicate names", fakeMcp.replace("'tools':tools", "'tools':tools+tools")],
    [
      "external schemas",
      fakeMcp.replace(
        "'tools':tools",
        "'tools':[{'name':'bad','inputSchema':{'type':'object','$ref':'https://evil.example/schema'}}]",
      ),
    ],
    [
      "malformed messages",
      fakeMcp.replace(
        "send({'id':m['id'],'result':{'protocolVersion'",
        "print('not-json',flush=True);send({'id':m['id'],'result':{'protocolVersion'",
      ),
    ],
  ])(
    "rejects %s",
    async (_name, source) => {
      const h = await setup(source);
      const server = await h.add();
      const response = await h.app.inject({
        method: "POST",
        url: `/api/mcp/servers/${server.id}/test`,
        headers: h.headers,
        payload: {},
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect((await h.api("/api/mcp")).servers[0].discovery).toBeNull();
    },
    20_000,
  );
  it("refuses executable drift until explicit testing and renewed grants", async () => {
    const h = await setup();
    const server = await h.ready();
    writeFileSync(h.binary, fakeMcp + "\n# a deliberately changed installed server\n");
    const run = await h.send("CALL echo");
    await h.approve(run);
    expect((await h.completed(run))[0]?.output).toContain("executable changed");
    await h.api(`/api/mcp/servers/${server.id}/test`, {});
    expect((await h.api("/api/mcp")).servers[0].enabled).toBe(false);
  }, 20_000);
});

it("does not apply a file proposal after a concurrent human edit", async () => {
  const h = await setup();
  writeFileSync(join(h.directory, "workspace/proposal.txt"), "Original text");
  await h.ready();
  const run = await h.send("CALL write");
  await h.approve(run);
  await h.pending(run);
  writeFileSync(join(h.directory, "workspace/proposal.txt"), "Human changed this");
  await h.approve(run);
  const calls = await h.completed(run);
  expect(calls[0]?.status).toBe("failed");
  expect(readFileSync(join(h.directory, "workspace/proposal.txt"), "utf8")).toBe(
    "Human changed this",
  );
}, 20_000);

it("enforces a read-only snapshot even when a server falsely labels a write as read-only", async () => {
  const h = await setup(
    fakeMcp.replace(
      "pending=None",
      "for tool in tools:tool['annotations']['readOnlyHint']=True\npending=None",
    ),
  );
  await h.ready({}, { tools: [{ name: "write", policy: "read-only" }] });
  const run = await h.send("CALL write");
  await h.approve(run);
  expect((await h.completed(run))[0]?.status).toBe("failed");
  expect(existsSync(join(h.directory, "workspace/proposal.txt"))).toBe(false);
}, 20_000);

it("rejects repeated pagination cursors instead of continuing discovery", async () => {
  const h = await setup(fakeMcp.replace("'tools':tools", "'tools':tools,'nextCursor':'same'"));
  const server = await h.add();
  const response = await h.app.inject({
    method: "POST",
    url: `/api/mcp/servers/${server.id}/test`,
    headers: h.headers,
    payload: {},
  });
  expect(response.statusCode).toBe(409);
  expect((await h.api("/api/mcp")).servers[0].discovery).toBeNull();
}, 20_000);

it("discovers bounded pages without losing or duplicating tools", async () => {
  const h = await setup(
    fakeMcp.replace(
      "'tools':tools",
      "'tools':tools[:3] if not p.get('cursor') else tools[3:],**({'nextCursor':'last'} if not p.get('cursor') else {})",
    ),
  );
  const server = await h.add();
  const tested = (await h.api(`/api/mcp/servers/${server.id}/test`, {})).server;
  expect(tested.discovery.tools).toHaveLength(tools.length);
}, 20_000);

it("rejects a message if an MCP context grant is revoked during preparation", async () => {
  const h = await setup(),
    server = await h.ready();
  const prepared = await h.api("/api/mcp/context/preview", {
    profileId: h.profileId,
    serverId: server.id,
    kind: "resource",
    name: "fixture://notes",
  });
  let release!: () => void,
    entered = false;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const original = McpContent.prototype.read;
  vi.spyOn(McpContent.prototype, "read").mockImplementation(async function (
    this: McpContent,
    kind,
    id,
  ) {
    if (kind === "contexts" && id === prepared.context.id) {
      entered = true;
      await gate;
    }
    return original.call(this, kind, id);
  });
  const response = h.app
    .inject({
      method: "POST",
      url: `/api/channels/${h.channelId}/messages`,
      headers: h.headers,
      payload: { content: "Use this source", mcpContextIds: [prepared.context.id] },
    })
    .then((r) => r);
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    await h.api(`/api/mcp/profiles/${h.profileId}/servers/${server.id}`, {}, "PUT");
  } finally {
    release();
  }
  expect((await response).statusCode).toBe(409);
  expect(h.requests).toHaveLength(0);
  expect((await h.api(`/api/runs?channelId=${h.channelId}`)).runs).toHaveLength(0);
}, 20_000);

it("contains an unreadable plugin credential and allows its replacement", async () => {
  const h = await setup(),
    server = await h.ready();
  const { setSetting } = await import("@vektor/db");
  setSetting(h.storage.db, `mcp.secrets.${server.id}`, "damaged encrypted record");
  const native = await h.send("Hello native");
  await h.completed(native);
  const plugin = await h.send("CALL echo");
  await h.approve(plugin);
  expect((await h.completed(plugin))[0]?.output).toContain("protected values are unreadable");
  await h.api(
    `/api/mcp/servers/${server.id}/credentials`,
    { values: { SERVICE_API_KEY: "replacement-mcp-secret" } },
    "PUT",
  );
  await h.api(`/api/mcp/servers/${server.id}/test`, {});
  expect((await h.api("/api/mcp")).servers[0].health.state).toBe("healthy");
}, 20_000);

it("keeps policy bindings stable when one of multiple servers finishes an operation", async () => {
  const h = await setup();
  await h.ready({ name: "First MCP" });
  await h.ready({ name: "Second MCP" });
  const { McpStore } = await import("./store.js");
  const store = new McpStore(h.storage.db, h.storage.secretsKey),
    before = store.policyHash(h.profileId);
  const run = await h.send("CALL echo");
  await h.approve(run);
  await h.completed(run);
  expect(store.policyHash(h.profileId)).toBe(before);
  const names = h.requests[0]!.tools!.map((t) => t.function.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names.every((name) => name.length <= 64 && !name.startsWith("mcp__"))).toBe(true);
}, 20_000);

it("accepts unchanged discovery in a different tool order", async () => {
  const h = await setup(
    fakeMcp.replace(
      "elif method=='tools/list':send",
      "elif method=='tools/list':tools.reverse();send",
    ),
  );
  await h.ready();
  const run = await h.send("CALL echo");
  await h.approve(run);
  expect((await h.completed(run))[0]?.output).toContain("Approved MCP output");
}, 20_000);
