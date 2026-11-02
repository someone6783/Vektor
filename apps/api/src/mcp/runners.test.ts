import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setSetting, getRun, listApprovals } from "@vektor/db";
import { encryptSecret } from "../secrets.js";
import { registryEntrySchema } from "../runners/catalog.js";
import { fakeCodex, fakeAcp } from "../runners/fixtures.test-utils.js";
import { harness } from "./fixtures.test-utils.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const codexMcp = fakeCodex
  .replace(
    "elif method=='thread/start':\n",
    "elif method=='thread/start':\n  granted=[t['name'] for t in m['params']['dynamicTools'] if t['name'].startswith('vektor_mcp_')]\n",
  )
  .replace(
    "'tool':'vektor_write_file','arguments':{'path':'hello.txt','content':'Human approved content'}",
    "'tool':granted[0] if granted else 'vektor_mcp_not_granted','arguments':{'text':'Codex MCP task'}",
  );
const acpMcp = fakeAcp
  .replace("import sys,json,os", "import sys,json,os,subprocess")
  .replace(
    "elif method=='session/new':\n",
    "elif method=='session/new':\n  servers=m['params']['mcpServers']\n",
  )
  .replace(
    "elif method=='session/prompt':\n",
    `elif method=='session/prompt':
  if servers:
   server=servers[0]
   bridge=subprocess.Popen([server['command']]+server['args'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   def rpc(i,method,params):
    bridge.stdin.write(json.dumps({'jsonrpc':'2.0','id':i,'method':method,'params':params})+'\\n');bridge.stdin.flush()
    return json.loads(bridge.stdout.readline())
   rpc(1,'initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'acp-fixture','version':'1.0.0'}})
   bridge.stdin.write(json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\\n');bridge.stdin.flush()
   granted=rpc(2,'tools/list',{})['result']['tools']
   result=rpc(3,'tools/call',{'name':granted[0]['name'],'arguments':{'text':'ACP MCP task'}})
   bridge.stdin.close();bridge.wait(timeout=2)
   send({'method':'session/update','params':{'sessionId':'acp-session','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':json.dumps(result)}}}})
   send({'id':m['id'],'result':{'stopReason':'end_turn'}})
   continue
`,
  );

async function configured(kind: "codex" | "acp", externalRunners: boolean) {
  const h = await harness();
  close = h.close;
  await h.ready({}, { tools: [{ name: "echo", policy: "read-only" }], externalRunners });
  const source = kind === "codex" ? codexMcp : acpMcp,
    command = join(h.directory, `agent-${kind}`);
  writeFileSync(command, source, { mode: 0o700 });
  const entry = registryEntrySchema.parse({
    id: "fixture-mcp",
    name: "Fixture ACP",
    version: "1.0.0",
    description: "Controlled ACP integration",
    authors: ["Tests"],
    license: "MIT",
    distribution: {
      binary: {
        "linux-x86_64": {
          archive: "https://example.com/agent",
          cmd: "./agent",
          sha256: "0".repeat(64),
        },
      },
    },
  });
  const id = kind === "codex" ? "codex" : "acp:fixture-mcp";
  setSetting(h.storage.db, "runner.registry.snapshot", {
    source: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
    checkedAt: new Date().toISOString(),
    hash: "0".repeat(64),
    agents: [entry],
  });
  setSetting(h.storage.db, "runner.installations", [
    {
      id,
      name: "Controlled agent",
      interface: kind === "codex" ? "codex-app-server" : "acp-v1",
      version: kind === "codex" ? "0.166.0" : "1.0.0",
      command,
      args: [],
      executableHash: createHash("sha256").update(source).digest("hex"),
      source: "test-fixture",
      sourceHash: createHash("sha256").update(JSON.stringify(entry)).digest("hex"),
      verifiedAt: new Date().toISOString(),
      enabled: true,
      inferenceHosts: ["api.openai.com"],
      credentialName: "OPENAI_API_KEY",
    },
  ]);
  setSetting(
    h.storage.db,
    `runner.credentials.${id}`,
    encryptSecret("runner-own-fixture-key-123", h.storage.secretsKey),
  );
  setSetting(h.storage.db, `runner.grant.${h.profileId}`, {
    runner: id,
    workspace: true,
    inference: true,
  });
  await h.api(
    `/api/profiles/${h.profileId}`,
    {
      runner: id,
      model: kind === "codex" ? "fixture" : "agent-default",
      terminalMode: "full-access",
      tools: ["terminal"],
    },
    "PATCH",
  );
  return h;
}

describe("MCP capabilities in external runners", () => {
  it("exposes granted Codex dynamic tools through Vektor approval", async () => {
    const h = await configured("codex", true);
    const run = await h.send("Use MCP");
    await h.approve(run);
    const calls = await h.completed(run);
    expect(calls.find((t) => t.name.startsWith("vektor_mcp_"))?.output).toContain("Codex MCP task");
    expect(getRun(h.storage.db, run)?.harness?.state).toBe("completed");
  }, 20_000);
  it("does not expose a plugin merely because a Codex profile can use it natively", async () => {
    const h = await configured("codex", false);
    const run = await h.send("Use MCP");
    const calls = await h.completed(run);
    expect(calls.some((t) => t.name.startsWith("vektor_mcp_"))).toBe(false);
    expect(listApprovals(h.storage.db, run)).toHaveLength(0);
  }, 20_000);
  it("passes only the run-scoped stdio broker to ACP and approves its real MCP call", async () => {
    const h = await configured("acp", true);
    const run = await h.send("Use MCP");
    await h.approve(run);
    const calls = await h.completed(run);
    expect(calls.find((t) => t.name.startsWith("vektor_mcp_"))?.output).toContain("ACP MCP task");
    expect(getRun(h.storage.db, run)?.harness?.interface).toBe("acp-v1");
  }, 20_000);
});
