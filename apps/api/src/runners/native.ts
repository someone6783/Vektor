import { access, mkdir, open, realpath, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
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
    throw new RuntimeError(
      runner === "codex"
        ? "Sign in with `codex login` on the backend machine, then connect again. File-based sign-in is required."
        : "Open OpenCode on the backend machine and use /connect, then connect again.",
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
  if (!Object.keys(supported).length)
    throw new RuntimeError(
      "No supported OpenCode account found. Use /connect for OpenAI, Anthropic, Google, OpenCode or OpenRouter; custom providers use Advanced setup.",
      409,
    );
  return {
    runner,
    auth: supported,
    hosts: [...new Set(Object.keys(supported).flatMap((id) => providerHosts[id]!))],
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
    await writeFile(configPath, JSON.stringify({ enabled_providers: Object.keys(account.auth) }), {
      mode: 0o600,
    });
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
export async function discoverNativeRunners(
  home = homedir(),
  env = process.env,
): Promise<Array<{ name: NativeRunner; command: string }>> {
  const directories = [
    ...(env.PATH ?? "/usr/bin:/bin").split(delimiter),
    join(home, ".local/bin"),
    join(home, "bin"),
    join(home, ".opencode/bin"),
    join(home, ".npm-global/bin"),
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
        const file = await open(command, "r");
        const header = Buffer.alloc(2);
        try {
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
