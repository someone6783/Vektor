import { createServer } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandboxBase } from "./sandbox.js";
import { computerCapabilities } from "./desktop.js";
import { defaultRunner } from "./controller.js";

describe.runIf(computerCapabilities().available)("actual application isolation", () => {
  it("blocks backend files, credentials, host processes and loopback network access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vektor-isolation-test-"));
    const secret = join(directory, "backend-secret");
    await writeFile(secret, "do not expose");
    const server = createServer((socket) => socket.end("backend"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const script = `import os, socket, json
s=socket.socket(); s.settimeout(0.3)
try:
 s.connect(('127.0.0.1', ${port})); network=True
except OSError: network=False
print(json.dumps({'secret':os.path.exists(${JSON.stringify(secret)}),'network':network,'key':os.getenv('PROVIDER_SECRET'),'host_process':os.path.exists('/proc/${process.pid}/cmdline')}))`;
      const result = await defaultRunner.run(
        "/usr/bin/bwrap",
        [...sandboxBase(), "--", "/usr/bin/python3", "-c", script],
        { env: { PATH: "/usr/bin:/bin", PROVIDER_SECRET: "secret" }, timeout: 5000 },
      );
      expect(JSON.parse(result.stdout)).toEqual({
        secret: false,
        network: false,
        key: null,
        host_process: false,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
