// Exercises the exact platform-specific payload shipped in the installer, without
// registering a login task or modifying the developer's real desktop service.
import process from "node:process";
import { log } from "node:console";
const { fetch } = globalThis;
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
const payload = resolve(process.argv[2] ?? "apps/web/src-tauri/resources/backend");
const data = mkdtempSync(resolve(tmpdir(), "vektor-desktop-service-"));
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const systemd = process.env.VEKTOR_SERVICE_SMOKE_SYSTEMD === "1";
const unit = `vektor-service-smoke-${process.pid}`;
let child;
try {
  const node = resolve(payload, process.platform === "win32" ? "node.exe" : "node");
  const args = [resolve(payload, "service-launcher.mjs"), data, String(port)];
  child = spawn(
    systemd ? "systemd-run" : node,
    systemd
      ? [
          "--user",
          "--wait",
          "--collect",
          `--unit=${unit}`,
          "--property=Restart=on-failure",
          "--property=UMask=0077",
          node,
          ...args,
        ]
      : args,
    {
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        VEKTOR_UPDATE_CHECK: "0",
        VEKTOR_SCHEDULER_ENABLED: "0",
        VEKTOR_ACCESS_TOKEN: "must-not-override-managed-credentials",
      },
    },
  );
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null, "Bundled API exited during startup");
    try {
      if ((await fetch(`${base}/healthz`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* starting */
    }
    await setTimeout(100);
  }
  assert.ok(ready, "Bundled service did not become healthy");
  const token = readFileSync(resolve(data, "access-token"), "utf8").trim();
  assert.ok(token.length >= 32);
  assert.notEqual(token, "must-not-override-managed-credentials");
  assert.equal((await fetch(`${base}/api/settings`)).status, 401);
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${base}/api/settings`, { headers: auth })).status, 200);
  const discovery = await fetch(`${base}/api/runners/discover`, { headers: auth });
  assert.equal(discovery.status, 200);
  assert.ok(Array.isArray((await discovery.json()).executables));
  // Invalid input checks route availability without probing or importing an account.
  assert.equal(
    (
      await fetch(`${base}/api/runners/connect`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    400,
    "Bundled API must expose native agent connection",
  );
  const { code } = await (
    await fetch(`${base}/api/session-link`, { method: "POST", headers: auth })
  ).json();
  const response = await fetch(`${base}/auth/session`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).status, 200);
  execFileSync(
    resolve(payload, process.platform === "win32" ? "node.exe" : "node"),
    [
      "--input-type=module",
      "-e",
      `
    import { chromium } from 'playwright';
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); await page.setContent('<title>Vektor bundled browser</title>');
    if (await page.title() !== 'Vektor bundled browser') throw new Error('Browser smoke failed');
    await browser.close();
  `,
    ],
    {
      cwd: resolve(payload, "api"),
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve(payload, "browsers") },
      stdio: "pipe",
      timeout: 30000,
    },
  );
  writeFileSync(resolve(data, "desktop-stop"), "stop", { mode: 0o600 });
  for (let i = 0; i < 140 && child.exitCode === null; i++) await setTimeout(100);
  assert.equal(child.exitCode, 0, "Service must exit gracefully after tray stop");
  log(
    "Bundled desktop API: native SQLite, bundled Chromium, generated credentials, browser pairing and graceful tray shutdown passed.",
  );
} finally {
  if (systemd) {
    try {
      execFileSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
    } catch {
      /* transient unit already collected */
    }
  }
  if (child && child.exitCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGKILL");
    await exited;
  }
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
