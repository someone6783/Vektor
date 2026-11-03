// Run on the target OS: native SQLite modules and Node must match the installer.
import {
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { log } from "node:console";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url));
if (!["linux", "win32"].includes(process.platform))
  throw new Error("Desktop service supports Windows and Linux.");
if (Number(process.versions.node.split(".")[0]) !== 22)
  throw new Error("Bundle the desktop backend with Node 22.");
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run this script with pnpm desktop:prepare.");
const run = (...args) =>
  execFileSync(process.execPath, [pnpm, ...args], { cwd: root, stdio: "inherit" });
run("build:packages");
run("--filter", "@vektor/api", "build");
const output = resolve(root, "apps/web/src-tauri/resources/backend");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
writeFileSync(
  resolve(output, "README.txt"),
  "Generated backend payload. Run pnpm desktop:prepare before building the installer.\n",
);
run(
  "--config.node-linker=hoisted",
  "--config.inject-workspace-packages=true",
  "--filter",
  "@vektor/api",
  "deploy",
  "--prod",
  resolve(output, "api"),
);
// Hoisted deployment has no directory links; dereference executable shims so
// Tauri/NSIS never needs Windows symlink privileges or package-manager junctions.
function flatten(directory) {
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const temporary = path + ".vektor-copy";
      cpSync(path, temporary, { recursive: true, dereference: true });
      unlinkSync(path);
      cpSync(temporary, path, { recursive: true });
      rmSync(temporary, { recursive: true, force: true });
    } else if (stat.isDirectory()) flatten(path);
  }
}
flatten(resolve(output, "api"));
cpSync(process.execPath, resolve(output, process.platform === "win32" ? "node.exe" : "node"));
cpSync(resolve(root, "scripts/service-launcher.mjs"), resolve(output, "service-launcher.mjs"));
// Use Playwright's normal per-platform cache so rebuilding or running desktop:dev
// does not download browsers again. Copy only the browser families used by Vektor.
run("--filter", "@vektor/api", "exec", "playwright", "install", "chromium");
const browserCache = execFileSync(
  process.execPath,
  [
    "-e",
    "const p=require('node:path');process.stdout.write(p.resolve(require('playwright').chromium.executablePath(),'../../..'))",
  ],
  {
    cwd: resolve(root, "apps/api"),
    encoding: "utf8",
  },
).trim();
for (const name of readdirSync(browserCache)) {
  if (/^(chromium-|chromium_headless_shell-|ffmpeg-|winldd-)/.test(name)) {
    cpSync(resolve(browserCache, name), resolve(output, "browsers", name), { recursive: true });
  }
}
// Same-version development builds must refresh installed API code too.
const payloadHash = createHash("sha256");
function hashTree(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = resolve(directory, name);
    if (lstatSync(path).isDirectory()) hashTree(path);
    else payloadHash.update(name).update(readFileSync(path));
  }
}
for (const directory of ["apps/api/dist", "packages/shared/dist", "packages/db/dist"])
  hashTree(resolve(root, directory));
for (const path of ["pnpm-lock.yaml", "scripts/service-launcher.mjs"])
  payloadHash.update(readFileSync(resolve(root, path)));
payloadHash.update(`${process.platform}/${process.arch}/${process.version}`);
const buildId = payloadHash.digest("hex");
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
writeFileSync(
  resolve(output, "manifest.json"),
  JSON.stringify({ version, platform: process.platform, arch: process.arch, buildId }),
);
log(`Bundled Node ${process.version} and API ${version} for ${process.platform}/${process.arch}.`);
