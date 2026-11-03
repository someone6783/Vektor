import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  accountSecrets,
  discoverNativeRunners,
  nativeAuthPath,
  readNativeAccount,
  refreshedNativeAccount,
  stageNativeAccount,
} from "./native.js";
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "vektor-native-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const env = { PATH: "/nonexistent", SHELL: "/nonexistent-shell" };
it("discovers common user installs without running them", async () => {
  await mkdir(join(home, ".local/bin"), { recursive: true });
  await writeFile(join(home, ".local/bin/codex"), "fake native executable", { mode: 0o700 });
  expect(await discoverNativeRunners(home, env)).toEqual([
    { name: "codex", command: join(home, ".local/bin/codex") },
  ]);
});
it("resolves the native binary behind an npm Codex launcher", async () => {
  const root = join(home, "package");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(
    join(root, "bin/codex.js"),
    "#!/usr/bin/env node\nthrow new Error('never execute');",
    { mode: 0o700 },
  );
  const binary = join(
    root,
    "vendor",
    process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl",
    "codex/codex",
  );
  await mkdir(join(binary, ".."), { recursive: true });
  await writeFile(binary, "native", { mode: 0o700 });
  await mkdir(join(home, "bin"));
  await symlink(join(root, "bin/codex.js"), join(home, "bin/codex"));
  expect(await discoverNativeRunners(home, env)).toEqual([{ name: "codex", command: binary }]);
});
it("imports Codex sign-in, stages only account data, and registers nested tokens for redaction", async () => {
  const auth = {
    tokens: { access_token: "test-access-token", refresh_token: "test-refresh-token" },
  };
  await mkdir(join(home, ".codex"));
  await writeFile(join(home, ".codex/auth.json"), JSON.stringify(auth));
  const account = await readNativeAccount("codex", home, env);
  const stage = join(home, "isolated");
  await stageNativeAccount(stage, account);
  expect(JSON.parse(await readFile(nativeAuthPath(stage, "codex"), "utf8"))).toEqual(auth);
  expect((await stat(nativeAuthPath(stage, "codex"))).mode & 0o777).toBe(0o600);
  expect(accountSecrets(JSON.stringify(account))).toContain("test-refresh-token");
  expect(account.hosts).toContain("chatgpt.com");
});
it("uses OpenCode provider accounts without requiring OpenRouter or copying executable config", async () => {
  await mkdir(join(home, ".local/share/opencode"), { recursive: true });
  await writeFile(
    join(home, ".local/share/opencode/auth.json"),
    JSON.stringify({
      anthropic: { type: "api", key: "test-anthropic-key" },
      custom: { type: "api", key: "unapproved-key" },
    }),
  );
  const account = await readNativeAccount("opencode", home, env);
  expect(account.auth).toEqual({ anthropic: { type: "api", key: "test-anthropic-key" } });
  expect(account.hosts).not.toContain("openrouter.ai");
  const stage = join(home, "stage");
  await stageNativeAccount(stage, account);
  expect(JSON.parse(await readFile(join(stage, ".config/opencode/opencode.json"), "utf8"))).toEqual(
    { enabled_providers: ["opencode", "anthropic"] },
  );
});
it("reports missing sign-in and rejects oversized account files", async () => {
  await expect(readNativeAccount("codex", home, env)).rejects.toThrow("codex login");
  await mkdir(join(home, ".codex"));
  await writeFile(join(home, ".codex/auth.json"), " ".repeat(65537));
  await expect(readNativeAccount("codex", home, env)).rejects.toThrow("codex login");
});
it("refuses account refresh through links outside the isolated home", async () => {
  const account = { runner: "codex" as const, auth: {}, hosts: ["api.openai.com"] };
  const outside = join(home, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "auth.json"), '{"secret":"never-import"}');
  const stage = join(home, "stage");
  await mkdir(stage);
  await symlink(outside, join(stage, ".codex"));
  await expect(refreshedNativeAccount(stage, account)).rejects.toThrow("Invalid account location");
});

it("finds a shell-only installation despite a minimal desktop service PATH", async () => {
  const bin = join(home, "custom-tools");
  await mkdir(bin);
  await writeFile(join(bin, "opencode"), "native fixture", { mode: 0o700 });
  const shell = join(home, "login-shell");
  await writeFile(
    shell,
    `#!/bin/sh
[ "$1" = "-ilc" ] || exit 1
printf 'startup noise\\n'
export PATH="${bin}"
exec /bin/sh -c "$2"
`,
    { mode: 0o700 },
  );
  expect(await discoverNativeRunners(home, { ...env, SHELL: shell })).toEqual([
    { name: "opencode", command: join(bin, "opencode") },
  ]);
});
it("falls back to user bins if the login shell fails", async () => {
  await mkdir(join(home, ".bun/bin"), { recursive: true });
  await writeFile(join(home, ".bun/bin/opencode"), "native fixture", { mode: 0o700 });
  expect(await discoverNativeRunners(home, env)).toEqual([
    { name: "opencode", command: join(home, ".bun/bin/opencode") },
  ]);
});

it("connects OpenCode without an account file and stages its free model provider", async () => {
  const account = await readNativeAccount("opencode", home, env);
  expect(account).toEqual({ runner: "opencode", auth: {}, hosts: ["opencode.ai"] });
  const stage = join(home, "free-model-session");
  await stageNativeAccount(stage, account);
  expect(JSON.parse(await readFile(nativeAuthPath(stage, "opencode"), "utf8"))).toEqual({});
  expect(JSON.parse(await readFile(join(stage, ".config/opencode/opencode.json"), "utf8"))).toEqual(
    { enabled_providers: ["opencode"] },
  );
  expect(accountSecrets(JSON.stringify(account))).toEqual([]);
});
it("keeps free OpenCode models available with an empty or unsupported account file", async () => {
  const authPath = nativeAuthPath(home, "opencode");
  await mkdir(join(authPath, ".."), { recursive: true });
  for (const auth of [{}, { custom: { type: "api", key: "unimported-custom-key" } }]) {
    await writeFile(authPath, JSON.stringify(auth));
    expect(await readNativeAccount("opencode", home, env)).toEqual({
      runner: "opencode",
      auth: {},
      hosts: ["opencode.ai"],
    });
  }
});
