import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { RuntimeError } from "../runtime/terminal.js";

// Deliberately expose system runtime files only. No backend data, home directory,
// host /tmp, display, D-Bus, network or attachment paths are mounted.
export function sandboxBase(): string[] {
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--clearenv",
  ];
  for (const path of [
    "/usr/bin",
    "/usr/lib",
    "/usr/lib64",
    "/usr/share",
    "/etc/fonts",
    "/etc/ld.so.cache",
  ])
    if (existsSync(path)) args.push("--ro-bind", path, path);
  for (const [path, target] of [
    ["/bin", "usr/bin"],
    ["/lib", "usr/lib"],
    ["/lib64", "usr/lib64"],
  ])
    if (existsSync(path!)) args.push("--symlink", target!, path!);
  args.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--size",
    "67108864",
    "--tmpfs",
    "/tmp",
    "--size",
    "67108864",
    "--tmpfs",
    "/home",
    "--dir",
    "/home/user",
    "--chdir",
    "/home/user",
  );
  return args;
}

export function applicationSandbox(
  directory: string,
  display: string,
  command: string,
  argv: string[],
) {
  const executable = realpathSync(command);
  if (!executable.startsWith("/usr/bin/"))
    throw new RuntimeError(
      "Computer applications must be installed in /usr/bin (or /bin). Other host paths are not shared with the desktop.",
      403,
    );
  return [
    "--as=2147483648",
    "--cpu=120",
    "--fsize=33554432",
    "--nofile=128",
    "--",
    "/usr/bin/bwrap",
    ...sandboxBase(),
    "--dir",
    "/tmp/.X11-unix",
    "--ro-bind",
    `/tmp/.X11-unix/X${display.slice(1)}`,
    `/tmp/.X11-unix/X${display.slice(1)}`,
    "--ro-bind",
    join(directory, "Xauthority"),
    "/run/Xauthority",
    "--setenv",
    "DISPLAY",
    display,
    "--setenv",
    "XAUTHORITY",
    "/run/Xauthority",
    "--setenv",
    "HOME",
    "/home/user",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--",
    executable,
    ...argv,
  ];
}
