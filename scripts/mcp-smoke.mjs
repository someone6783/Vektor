import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath, URL } from "node:url";
import { setTimeout } from "node:timers/promises";
import process from "node:process";

const root = process.env.VEKTOR_API_ROOT ?? fileURLToPath(new URL("../apps/api/", import.meta.url));
const load = (name) => import(pathToFileURL(resolve(root, `dist/${name}.js`)).href);
const [{ buildApp }, { loadConfig }, { bootstrapStorage }] = await Promise.all([
  load("app"),
  load("config"),
  load("bootstrap"),
]);
const directory = await mkdtemp(join(tmpdir(), "vektor-mcp-packaged-"));
const access = "mcp-packaged-fixture-access-token",
  key = "separate-mcp-packaged-fixture-key";
let calls = 0;
const tool = {
  name: "echo",
  description: "Controlled container fixture",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};
const init = {
  protocolVersion: "2025-11-25",
  serverInfo: { name: "packaged-mcp", version: "1.0.0" },
  capabilities: { tools: {} },
};
const fixture = createServer(async (request, response) => {
  if (request.method === "GET") {
    response.writeHead(405).end();
    return;
  }
  if (request.method === "DELETE") {
    response.writeHead(200).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(request.headers["x-api-key"], key);
  if (message.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  let result;
  if (message.method === "initialize") result = init;
  else if (message.method === "tools/list") result = { tools: [tool] };
  else if (message.method === "tools/call") {
    calls++;
    assert.equal(request.headers["mcp-protocol-version"], "2025-11-25");
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "mcp-session-id": "packaged-fixture-session",
    });
    const token = message.params._meta?.progressToken;
    if (token !== undefined)
      response.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1, total: 1, message: "Packaged MCP progress" } })}\n\n`,
      );
    response.end(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: message.params.arguments.text }] } })}\n\n`,
    );
    return;
  } else {
    response.writeHead(400).end();
    return;
  }
  response
    .writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "packaged-fixture-session",
    })
    .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});
await new Promise((done) => fixture.listen(0, "127.0.0.1", done));
const config = loadConfig({
  NODE_ENV: "test",
  VEKTOR_DATA_DIR: directory,
  VEKTOR_ACCESS_TOKEN: access,
  VEKTOR_WEB_DIST: join(directory, "no-web"),
});
const app = await buildApp({
  config,
  storage: bootstrapStorage(config),
  logger: false,
  startScheduler: false,
  provider: {
    kind: "stub",
    async *streamChat(request) {
      if (request.messages.at(-1)?.role === "tool") {
        yield { type: "text.delta", text: "Reviewed MCP operation finished." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      const selected = request.tools.find((t) => t.function.name.startsWith("vektor_mcp_"));
      assert.ok(selected);
      yield {
        type: "tool_call",
        id: "packaged-mcp",
        name: selected.function.name,
        argumentsJson: JSON.stringify({ text: "Packaged MCP result" }),
      };
      yield { type: "finish", reason: "tool_calls" };
    },
  },
});
const headers = { authorization: `Bearer ${access}` };
async function api(url, payload, method) {
  const response = await app.inject({
    method: method ?? (payload === undefined ? "GET" : "POST"),
    url,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
  assert.ok(response.statusCode < 400, response.payload);
  return response.statusCode === 204 ? null : response.json();
}
async function until(check) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await setTimeout(25);
  }
  throw new Error("Packaged MCP check timed out.");
}
try {
  const profileId = (await api("/api/profiles")).profiles[0].id;
  const channelId = (await api("/api/channels", { name: "Packaged MCP", profileId })).channel.id;
  const command = join(directory, "server.py");
  await writeFile(
    command,
    `#!/usr/bin/python3
import sys,json
tool=json.loads(${JSON.stringify(JSON.stringify(tool))})
init=json.loads(${JSON.stringify(JSON.stringify(init))})
for line in sys.stdin:
 m=json.loads(line);method=m.get('method')
 if 'id' not in m:continue
 if method=='initialize':result=init
 elif method=='tools/list':result={'tools':[tool]}
 elif method=='tools/call':result={'content':[{'type':'text','text':m['params']['arguments']['text']}]}
 else:continue
 print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}),flush=True)
`,
    { mode: 0o755 },
  );
  const local = (
    await api("/api/mcp/servers", {
      name: "Local packaged",
      transport: "stdio",
      command,
      hostBinaryAcknowledged: true,
    })
  ).server;
  const probe = await app.inject({
    method: "POST",
    url: `/api/mcp/servers/${local.id}/test`,
    headers,
    payload: {},
  });
  if (probe.statusCode < 400) {
    assert.equal(probe.json().server.discovery.protocolVersion, "2025-11-25");
    process.stdout.write("Packaged local MCP: isolated protocol/discovery passed.\n");
  } else {
    assert.equal(probe.statusCode, 409, probe.payload);
    assert.equal((await api("/api/mcp")).servers.find((s) => s.id === local.id).enabled, false);
    process.stdout.write(
      "Packaged local MCP: unavailable under this container namespace policy; launch failed closed.\n",
    );
  }
  const server = (
    await api("/api/mcp/servers", {
      name: "HTTP packaged",
      transport: "http",
      url: `http://127.0.0.1:${fixture.address().port}/mcp`,
      allowLoopback: true,
    })
  ).server;
  await api(`/api/mcp/servers/${server.id}/credentials`, { values: { "x-api-key": key } }, "PUT");
  await api(`/api/mcp/servers/${server.id}/test`, {});
  await api(`/api/mcp/servers/${server.id}`, { enabled: true }, "PATCH");
  await api(
    `/api/mcp/profiles/${profileId}/servers/${server.id}`,
    { tools: [{ name: "echo", policy: "read-only" }] },
    "PUT",
  );
  for (const approved of [false, true]) {
    const runId = (
      await api(`/api/channels/${channelId}/messages`, { content: "Use the packaged MCP fixture" })
    ).run.id;
    const approval = await until(async () => {
      const details = await api(`/api/runs/${runId}/details`);
      return details.approvals.find((a) => a.status === "pending");
    });
    assert.equal(calls, 0);
    await api(`/api/approvals/${approval.id}`, { approved });
    const details = await until(async () => {
      const result = await api(`/api/runs/${runId}/details`);
      return result.run.status === "completed" ? result : null;
    });
    assert.equal(details.tools[0].status, approved ? "completed" : "denied");
    if (approved) {
      assert.match(details.tools[0].output, /Packaged MCP result/);
      assert.ok(details.events.some((e) => e.type === "tool.progress"));
    }
  }
  assert.equal(calls, 1);
  assert.ok(
    (await api("/api/audit")).entries.some((entry) => entry.action === "mcp.tool_finished"),
  );
  assert.ok(!JSON.stringify(await api("/api/mcp")).includes(key));
  await api("/api/runtime/emergency-stop", {});
  assert.equal((await api("/api/runtime")).emergencyStopped, true);
  process.stdout.write(
    "Packaged HTTP MCP: protected auth, discovery, schema worker, denial, approval, SSE progress, audit/history and emergency stop passed.\n",
  );
} finally {
  await app.close();
  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
  await rm(directory, { recursive: true, force: true });
}
