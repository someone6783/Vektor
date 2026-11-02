// Persistent service supervisor. IPC lets Windows shut down the API gracefully too.
import { fork } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { setTimeout, setInterval, clearInterval } from "node:timers";
import { fileURLToPath, URL } from "node:url";
const directory = fileURLToPath(new URL(".", import.meta.url));
const data = process.argv[2];
const port = process.argv[3];
if (!data || !/^\d+$/.test(port ?? "")) throw new Error("Missing service data directory or port.");
mkdirSync(data, { recursive: true, mode: 0o700 });
const stopFile = join(data, "desktop-stop");
if (existsSync(stopFile)) unlinkSync(stopFile);
const serviceEnv = { ...process.env };
// Each managed installation owns its generated credential, regardless of shell env.
delete serviceEnv.VEKTOR_ACCESS_TOKEN;
const child = fork(join(directory, "api/dist/server.js"), [], {
  cwd: directory,
  windowsHide: true,
  env: {
    ...serviceEnv,
    PLAYWRIGHT_BROWSERS_PATH: join(directory, "browsers"),
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: port,
    VEKTOR_DATA_DIR: data,
    VEKTOR_MANAGED_SERVICE: "1",
    VEKTOR_RUNTIME_ENV: "host",
    VEKTOR_ENABLE_DEV_STREAM: "0",
    VEKTOR_WEB_DIST: join(directory, "no-web"),
  },
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (child.connected) child.send("vektor:shutdown");
  setTimeout(() => child.kill("SIGKILL"), 12000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const timer = setInterval(() => {
  if (existsSync(stopFile)) {
    unlinkSync(stopFile);
    stop();
  }
}, 250);
child.on("error", () => {
  clearInterval(timer);
  process.exit(1);
});
child.on("exit", (code) => {
  clearInterval(timer);
  process.exit(stopping ? 0 : (code ?? 1));
});
