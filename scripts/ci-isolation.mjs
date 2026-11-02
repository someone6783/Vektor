// Provision only the disposable GitHub runner, never a developer/user installation.
// Ubuntu's user-namespace restriction is application-specific; allow Bubblewrap
// without disabling AppArmor or changing any global namespace sysctl.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { log } from "node:console";

if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error(
    "This provisioning script is restricted to disposable Linux GitHub Actions runners.",
  );
}
const args = [
  "--unshare-all",
  "--die-with-parent",
  "--new-session",
  "--cap-drop",
  "ALL",
  "--ro-bind",
  "/usr",
  "/usr",
  "--symlink",
  "usr/bin",
  "/bin",
  "--symlink",
  "usr/lib",
  "/lib",
  "--symlink",
  "usr/lib64",
  "/lib64",
  "--",
  "/usr/bin/true",
];
const probe = () => spawnSync("/usr/bin/bwrap", args, { encoding: "utf8", timeout: 5000 });
let result = probe();
if (result.status !== 0) {
  log("Initial Bubblewrap probe:", (result.stderr || result.error?.message || "failed").trim());
  const restriction = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
  if (existsSync(restriction) && readFileSync(restriction, "utf8").trim() === "1") {
    const directory = mkdtempSync(join(tmpdir(), "vektor-ci-apparmor-"));
    try {
      const profile = join(directory, "bwrap");
      writeFileSync(
        profile,
        `abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
`,
        { mode: 0o600 },
      );
      execFileSync("sudo", ["-n", "apparmor_parser", "-r", profile], { stdio: "inherit" });
      result = probe();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
if (result.status !== 0) {
  throw new Error(
    `CI requires working Bubblewrap user/mount/PID/network namespaces: ${(result.stderr || result.error?.message || "probe failed").trim()}`,
  );
}
log("Vektor CI isolation: user/mount/PID/network namespace preflight passed.");
