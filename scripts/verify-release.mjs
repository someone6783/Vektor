import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { clearTimeout } from "node:timers";
import { metadata, projectRoot } from "./version.mjs";

const { fetch } = globalThis;

const { version } = metadata();
const directory = mkdtempSync(resolve(tmpdir(), "vektor-release-smoke-"));
const archive = resolve(
  process.argv[2] ?? `release-artifacts/vektor-api-${version}-linux-x64-node22.tar.gz`,
);
const token = "release-smoke-test-access-token";
let child;
try {
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
  const portServer = createServer();
  await new Promise((done) => portServer.listen(0, "127.0.0.1", done));
  const port = portServer.address().port;
  await new Promise((done) => portServer.close(done));
  child = spawn(process.execPath, [resolve(directory, "api/dist/server.js")], {
    cwd: directory,
    stdio: "ignore",
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      VEKTOR_DATA_DIR: resolve(directory, "data"),
      VEKTOR_ACCESS_TOKEN: token,
      VEKTOR_WEB_DIST: resolve(directory, "web/dist"),
      VEKTOR_UPDATE_CHECK: "0",
      VEKTOR_SCHEDULER_ENABLED: "0",
    },
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("Packaged API exited before becoming healthy.");
    try {
      const health = await fetch(`${base}/healthz`);
      if (health.ok) {
        assert.equal((await health.json()).version, version);
        ready = true;
        break;
      }
    } catch {
      /* Startup is bounded below. */
    }
    await setTimeout(100);
  }
  assert.ok(ready, "Packaged API must start within 10 seconds.");
  assert.match(await (await fetch(base)).text(), /<html/);
  assert.equal((await fetch(`${base}/api/update-check`)).status, 401);
  const result = await fetch(`${base}/api/update-check?force=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status, "disabled");
  execFileSync("sha256sum", ["--check", "SHA256SUMS"], {
    cwd: resolve(projectRoot, "release-artifacts"),
    stdio: "inherit",
  });
  process.stdout.write(
    `Packaged API/web ${version}: health, assets, bearer auth, opt-out and checksums passed.\n`,
  );
} finally {
  if (child && child.exitCode === null) {
    const closed = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    const kill = globalThis.setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(kill);
  }
  rmSync(directory, { recursive: true, force: true });
}
