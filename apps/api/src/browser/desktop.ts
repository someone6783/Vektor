import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BrowserCapabilities } from "@vektor/shared";

export interface BrowserDesktop {
  capabilities: BrowserCapabilities;
  env: Record<string, string>;
  args: string[];
}
export function browserDesktop(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): BrowserDesktop {
  const variables: Record<string, string> = {};
  let available = platform === "darwin" || platform === "win32";
  const args: string[] = [];
  if (platform === "linux") {
    available = !!env.DISPLAY || !!(env.WAYLAND_DISPLAY && env.XDG_RUNTIME_DIR);
    for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"])
      if (env[key]) variables[key] = env[key]!;
    const authority = env.XAUTHORITY ?? (env.HOME ? join(env.HOME, ".Xauthority") : undefined);
    if (authority && existsSync(authority)) variables.XAUTHORITY = authority;
    if (!env.DISPLAY && env.WAYLAND_DISPLAY) args.push("--ozone-platform=wayland");
  }
  if (platform === "win32")
    for (const key of ["SYSTEMROOT", "WINDIR", "TEMP"]) if (env[key]) variables[key] = env[key]!;
  return {
    capabilities: {
      visibleWindowAvailable: available,
      reason: available
        ? null
        : "The backend has no desktop display. Choose Headless or run the backend in a desktop session. Docker needs an explicitly connected display.",
      windowLocation: "backend",
    },
    env: variables,
    args,
  };
}
