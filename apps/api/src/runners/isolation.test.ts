import { once } from "node:events";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InferenceProxy } from "./isolation.js";
async function request(socket: string, header: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = connect(socket);
    let output = "";
    client.setTimeout(2000, () => {
      client.destroy();
      reject(new Error("Proxy did not terminate denied request"));
    });
    client.on("error", reject);
    client.on("connect", () => client.write(header));
    client.on("data", (chunk) => (output += chunk.toString()));
    client.on("close", () => resolve(output));
  });
}
describe("inference-only network bridge", () => {
  it("denies unknown hosts, domain suffix spoofing, plain HTTP and private DNS destinations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vektor-egress-test-"));
    const path = join(directory, "proxy.sock");
    const controller = new AbortController();
    const proxy = new InferenceProxy(["api.openai.com", "localhost"], controller.signal);
    try {
      await proxy.listen(path);
      for (const header of [
        "CONNECT example.com:443 HTTP/1.1\r\n\r\n",
        "CONNECT api.openai.com.evil.test:443 HTTP/1.1\r\n\r\n",
        "GET http://api.openai.com/ HTTP/1.1\r\n\r\n",
        "CONNECT localhost:443 HTTP/1.1\r\n\r\n",
        "CONNECT api.openai.com:80 HTTP/1.1\r\n\r\n",
      ])
        expect(await request(path, header)).toContain("403 Forbidden");
      const client = connect(path);
      client.on("error", () => {});
      await once(client, "connect");
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      controller.abort();
      await closed;
      expect(client.destroyed).toBe(true);
    } finally {
      await proxy.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
