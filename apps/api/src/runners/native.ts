import { access, mkdir, open, realpath, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, userInfo } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, join, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { RuntimeError } from "../runtime/terminal.js";

export type NativeRunner = "codex" | "opencode";
const providerHosts: Record<string, string[]> = {
  openai: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
  anthropic: ["api.anthropic.com", "console.anthropic.com"],
  opencode: ["opencode.ai"],
  openrouter: ["openrouter.ai"],
  google: ["generativelanguage.googleapis.com", "oauth2.googleapis.com"],
};
const nativeAccountSchema = z.object({
  runner: z.enum(["codex", "opencode"]),
  auth: z.record(z.unknown()),
  hosts: z.array(z.string()).min(1).max(20),
});
export type NativeAccount = z.infer<typeof nativeAccountSchema>;
export function parseNativeAccount(value: string): NativeAccount {
  return nativeAccountSchema.parse(JSON.parse(value));
}
async function boundedJson(path: string): Promise<Record<string, unknown>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024) throw new Error("Account file too large");
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 64 * 1024) throw new Error("Account file too large");
    return z.record(z.unknown()).parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } finally {
    await file.close();
  }
}
export async function readNativeAccount(
  runner: NativeRunner,
  home = homedir(),
  env = process.env,
): Promise<NativeAccount> {
  let auth: Record<string, unknown>;
  try {
    auth = await boundedJson(
      runner === "codex"
        ? join(env.CODEX_HOME ?? join(home, ".codex"), "auth.json")
        : join(env.XDG_DATA_HOME ?? join(home, ".local/share"), "opencode/auth.json"),
    );
  } catch {
    if (runner === "opencode") return { runner, auth: {}, hosts: ["opencode.ai"] };
    throw new RuntimeError(
      "Sign in with `codex login` on the backend machine, then connect again. File-based sign-in is required.",
      409,
    );
  }
  if (runner === "codex") {
    const tokens = z
      .object({ access_token: z.string().min(1), refresh_token: z.string().min(1) })
      .passthrough()
      .safeParse(auth.tokens);
    if (
      !(typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.length >= 8) &&
      !tokens.success
    )
      throw new RuntimeError("Codex has no saved sign-in. Run `codex login`, then reconnect.", 409);
    return { runner, auth, hosts: providerHosts.openai! };
  }
  const supported = Object.fromEntries(
    Object.entries(auth).filter(([provider, value]) => {
      if (!providerHosts[provider]) return false;
      return z
        .union([
          z.object({ type: z.literal("api"), key: z.string().min(1) }),
          z.object({
            type: z.literal("oauth"),
            access: z.string().min(1),
            refresh: z.string().min(1),
          }),
        ])
        .safeParse(value).success;
    }),
  );

  return {
    runner,
    auth: supported,
    hosts: [
      ...new Set(["opencode.ai", ...Object.keys(supported).flatMap((id) => providerHosts[id]!)]),
    ],
  };
}
export const nativeAuthPath = (home: string, runner: NativeRunner) =>
  join(home, runner === "codex" ? ".codex/auth.json" : ".local/share/opencode/auth.json");
export async function stageNativeAccount(home: string, account: NativeAccount): Promise<void> {
  const path = nativeAuthPath(home, account.runner);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Never load host plugins, MCP servers, commands or executable config.
  await writeFile(path, JSON.stringify(account.auth), { mode: 0o600 });
  if (account.runner === "opencode") {
    const configPath = join(home, ".config/opencode/opencode.json");
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(
      configPath,
      JSON.stringify({
        enabled_providers: [...new Set(["opencode", ...Object.keys(account.auth)])],
      }),
      {
        mode: 0o600,
      },
    );
  }
}
export function accountSecrets(value: string): string[] {
  try {
    const pending: unknown[] = [parseNativeAccount(value).auth];
    const secrets: string[] = [];
    for (let count = 0; pending.length && count < 5000; count++) {
      const entry = pending.pop();
      if (typeof entry === "string" && entry.length >= 8) secrets.push(entry);
      else if (entry && typeof entry === "object") pending.push(...Object.values(entry));
    }
    return secrets;
  } catch {
    return [];
  }
}
// Desktop services inherit a smaller PATH than interactive terminals. Like T3,
// read the user's login-shell PATH without executing a provider or importing secrets.
async function loginShellDirectories(home: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  let shell = env.SHELL;
  if (!shell && env === process.env) {
    try {
      shell = userInfo().shell ?? undefined;
    } catch {
      /* Use sh below. */
    }
  }
  shell ??= "/bin/sh";
  if (!isAbsolute(shell)) return [];
  const marker = `vektor-path-${randomUUID()}`;
  const script = /^(nu|nu.exe)$/.test(shell.split("/").pop() ?? "")
    ? `print '${marker}'; print ($env.PATH | str join ':'); print '${marker}'`
    : `printf '%s\\n' '${marker}'; /usr/bin/printenv PATH; printf '%s\\n' '${marker}'`;
  return new Promise((resolve) => {
    const child = spawn(shell, ["-ilc", script], {
      cwd: home,
      env: { ...env, HOME: home },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      detached: true,
    });
    let output = "";
    let complete = false;
    const finish = (success: boolean) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      if (!success && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      const path = success ? output.split(marker)[1]?.trim() : undefined;
      resolve(path?.split(delimiter).filter((entry) => isAbsolute(entry)) ?? []);
    };
    const timer = setTimeout(() => finish(false), 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > 128 * 1024) finish(false);
    });
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}
export async function discoverNativeRunners(
  home = homedir(),
  env = process.env,
): Promise<Array<{ name: NativeRunner; command: string }>> {
  const directories = [
    ...(env.PATH ?? "/usr/bin:/bin").split(delimiter),
    ...(await loginShellDirectories(home, env)),
    join(home, ".local/bin"),
    join(home, "bin"),
    join(home, ".opencode/bin"),
    join(home, ".npm-global/bin"),
    join(home, ".bun/bin"),
    join(home, ".local/share/pnpm"),
    join(home, ".volta/bin"),
    join(home, ".asdf/shims"),
    join(home, ".local/share/mise/shims"),
    join(home, ".codex/packages/standalone/current/bin"),
    ...(env === process.env ? ["/usr/local/bin", "/usr/bin", "/bin"] : []),
  ];
  try {
    for (const version of await readdir(join(home, ".nvm/versions/node")))
      directories.push(join(home, ".nvm/versions/node", version, "bin"));
  } catch {
    /* Optional Node installation. */
  }
  const found: Array<{ name: NativeRunner; command: string }> = [];
  for (const name of ["codex", "opencode"] as const) {
    for (const directory of [...new Set(directories)]) {
      if (!directory.startsWith("/")) continue;
      try {
        let command = await realpath(join(directory, name));
        await access(command, constants.X_OK);
        // npm entry points are JS launchers; probe the bundled native binary.
        const file = await open(command, constants.O_RDONLY | constants.O_NONBLOCK);
        const header = Buffer.alloc(2);
        try {
          if (!(await file.stat()).isFile()) continue;
          await file.read(header, 0, 2, 0);
        } finally {
          await file.close();
        }
        if (header.toString() === "#!") {
          const triple =
            process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
          const platform = process.arch === "arm64" ? "codex-linux-arm64" : "codex-linux-x64";
          const root = dirname(dirname(command));
          const candidates =
            name === "codex"
              ? [
                  join(root, "vendor", triple, "codex/codex"),
                  join(root, "node_modules/@openai", platform, "vendor", triple, "codex/codex"),
                  join(dirname(root), platform, "vendor", triple, "codex/codex"),
                ]
              : [
                  join(
                    root,
                    "node_modules",
                    `opencode-linux-${process.arch === "arm64" ? "arm64" : "x64"}`,
                    "bin/opencode",
                  ),
                  join(
                    dirname(root),
                    `opencode-linux-${process.arch === "arm64" ? "arm64" : "x64"}`,
                    "bin/opencode",
                  ),
                ];
          command = "";
          for (const candidate of candidates) {
            try {
              await access(candidate, constants.X_OK);
              command = candidate;
              break;
            } catch {
              /* Next package layout. */
            }
          }
          if (!command) continue;
        }
        found.push({ name, command });
        break;
      } catch {
        /* Not installed in this directory. */
      }
    }
  }
  return found;
}
export async function refreshedNativeAccount(
  home: string,
  previous: NativeAccount,
): Promise<string> {
  const path = nativeAuthPath(home, previous.runner);
  const resolved = await realpath(path);
  const within = relative(await realpath(home), resolved);
  if (within.startsWith("..") || isAbsolute(within)) throw new Error("Invalid account location");
  const auth = await boundedJson(path);
  return JSON.stringify({ ...previous, auth });
}
