import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioRpc } from "./rpc.js";

const directory = mkdtempSync(join(tmpdir(), "vektor-rpc-"));
const connections: StdioRpc[] = [];
function agent(body: string, options: Partial<ConstructorParameters<typeof StdioRpc>[0]> = {}) {
  const rpc = new StdioRpc({
    command: process.execPath,
    args: [
      "-e",
      `const readline = require('node:readline'); readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line); ${body} });`,
    ],
    cwd: directory,
    env: {},
    timeoutMs: 1000,
    ...options,
  });
  connections.push(rpc);
  return rpc;
}
afterEach(async () => {
  for (const rpc of connections.splice(0)) {
    rpc.close();
    await rpc.exited;
  }
});
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));

describe("supervised stdio RPC", () => {
  it("correlates responses with fragmented UTF-8 output", async () => {
    const rpc = agent(
      `const value = JSON.stringify({id:m.id,result:'Hello 世界'})+'\\n'; process.stdout.write(value.slice(0,10)); setTimeout(()=>process.stdout.write(value.slice(10)),5);`,
    );
    expect(await rpc.call("initialize", {})).toBe("Hello 世界");
  });
  it("does not inherit backend secrets", async () => {
    const rpc = agent(
      `console.log(JSON.stringify({id:m.id,result:process.env.VEKTOR_ACCESS_TOKEN ?? null}));`,
    );
    expect(await rpc.call("initialize", {})).toBeNull();
  });
  it("rejects malformed output and contains agent death", async () => {
    const rpc = agent(`process.stdout.write('invalid\\n');`);
    await expect(rpc.call("initialize", {})).rejects.toThrow("Malformed");
    await rpc.exited;
  });
  it("bounds startup, output and cancellation", async () => {
    const rpc = agent(``, { timeoutMs: 30 });
    await expect(rpc.call("initialize", {})).rejects.toThrow("timed out");
    const loud = agent(`process.stdout.write('x'.repeat(2048));`, { maxBytes: 100 });
    await expect(loud.call("initialize", {})).rejects.toThrow();
    const controller = new AbortController();
    const blocked = agent(``, { signal: controller.signal });
    const pending = blocked.call("session/prompt", {});
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });
  it("denies unknown requests without invoking capabilities", async () => {
    const rpc = agent(
      `if(m.method)console.log(JSON.stringify({id:'permission',method:'terminal/create',params:{}}));else console.log(JSON.stringify({id:1,result:m.error.code}));`,
    );
    expect(await rpc.call("session/prompt", {})).toBe(-32601);
  });
  it("rejects duplicate incoming requests rather than executing twice", async () => {
    let calls = 0;
    const rpc = agent(
      `const request=JSON.stringify({id:'dup',method:'permission'});process.stdout.write(request+'\\n'+request+'\\n');`,
      {
        request: async () => {
          calls++;
          return {};
        },
      },
    );
    await expect(rpc.call("session/prompt", {})).rejects.toThrow("Malformed");
    expect(calls).toBe(1);
  });
  it("surfaces authentication and usage-limit failures without echoing provider errors", async () => {
    const auth = agent(
      `console.log(JSON.stringify({ id:m.id, error:{code:-32000,message:'401 Unauthorized private-token-content'} }));`,
    );
    await expect(auth.call("session/new", {})).rejects.toThrow("authentication");
    const quota = agent(
      `console.log(JSON.stringify({ id:m.id, error:{code:-32000,message:'429 quota exceeded private-token-content'} }));`,
    );
    await expect(quota.call("session/prompt", {})).rejects.toThrow("usage or rate limit");
  });
});
