import { spawnSync } from "node:child_process";
import { sandboxBase } from "./sandbox.js";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ComputerCapabilities } from "@vektor/shared";

const required = ["Xvfb", "xdotool", "ffmpeg", "bwrap", "prlimit"] as const;

export interface ComputerDesktopCapabilities {
  capabilities: ComputerCapabilities;
}

function commandAvailable(command: string, env: NodeJS.ProcessEnv): boolean {
  const paths = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter);
  return paths.some((path) => {
    const candidate = join(path, command);
    return existsSync(candidate);
  });
}

let sandboxReason: string | null | undefined;

export function computerCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): ComputerCapabilities {
  if (platform !== "linux")
    return {
      available: false,
      reason:
        "Isolated computer sessions currently require Linux with Xvfb, xdotool, and ffmpeg. Host desktop control is not implemented.",
      location: "backend-isolated",
    };
  const missing = required.filter((command) => !commandAvailable(command, env));
  if (missing.length)
    return {
      available: false,
      reason: `The backend is missing ${missing.join(", ")}. Install Xvfb, xdotool, and ffmpeg to use isolated computer sessions.`,
      location: "backend-isolated",
    };
  if (sandboxReason === undefined) {
    const probe = spawnSync("/usr/bin/bwrap", [...sandboxBase(), "--", "/usr/bin/true"], {
      timeout: 2000,
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    sandboxReason =
      probe.status === 0
        ? null
        : "Desktop isolation is unavailable: Bubblewrap needs user, mount, PID and network namespaces. Enable them for this backend; computer use will not run without isolation.";
  }
  return { available: sandboxReason === null, reason: sandboxReason, location: "backend-isolated" };
}
