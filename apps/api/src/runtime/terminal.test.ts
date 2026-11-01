import { spawn } from "node:child_process";
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalInputSchema } from "@vektor/shared";
import { makeRedactor } from "./redact.js";
import { SUPERVISOR_SOURCE, TerminalExecutor } from "./terminal.js";

let directory: string;
let terminal: TerminalExecutor;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vektor-terminal-"));
  terminal = new TerminalExecutor(
    join(directory, "workspace"),
    makeRedactor(() => ["private-test-credential"]),
    1024,
  );
  await terminal.prepare("basic", terminalInputSchema.parse({ command: "pwd" }));
});
afterEach(async () => {
  await terminal.stopAll();
  await rm(directory, { recursive: true, force: true });
});
const input = (command: string, args: string[] = [], cwd?: string) =>
  terminalInputSchema.parse({ command, args, cwd });

describe("terminal permissions and supervision", () => {
  it("rejects hard links, special files and paths replaced with symlinks after preparation", async () => {
    await writeFile(join(directory, "outside"), "private outside data");
    await link(join(directory, "outside"), join(terminal.workspace, "hard-link"));
    await expect(terminal.prepare("basic", input("cat", ["hard-link"]))).rejects.toThrow(
      "hard-linked",
    );
    await writeFile(join(terminal.workspace, "safe"), "safe");
    const prepared = await terminal.prepare("basic", input("cat", ["safe"]));
    await rm(join(terminal.workspace, "safe"));
    await symlink(join(directory, "outside"), join(terminal.workspace, "safe"));
    await expect(terminal.execute(prepared, new AbortController().signal)).rejects.toThrow(
      "symlinks",
    );
    const fifo = spawn("mkfifo", [join(terminal.workspace, "fifo")]);
    await new Promise((resolve) => fifo.once("exit", resolve));
    await expect(terminal.prepare("basic", input("cat", ["fifo"]))).rejects.toThrow(
      "regular files",
    );
  });
  it("executes basic commands inside the workspace and rejects paths, symlinks, shells, and option escapes", async () => {
    await writeFile(join(directory, "outside.txt"), "outside-private-data");
    await writeFile(join(terminal.workspace, "inside.txt"), "inside-data");
    await symlink(join(directory, "outside.txt"), join(terminal.workspace, "link.txt"));
    const spec = await terminal.prepare("basic", input("cat", ["inside.txt"]));
    expect(await terminal.execute(spec, new AbortController().signal)).toMatchObject({
      output: "inside-data",
      exitCode: 0,
      isError: false,
    });
    for (const request of [
      input("cat", ["../outside.txt"]),
      input("cat", [join(directory, "outside.txt")]),
      input("cat", ["link.txt"]),
      input("pwd", [], directory),
      input("sh", ["-c", "pwd"]),
      input("node", ["-e", "process.exit()"]),
      input("ls", ["--recursive"]),
      input("head", ["-n", "-1", "inside.txt"]),
      input("cat", ["-"]),
    ]) {
      await expect(terminal.prepare("basic", request)).rejects.toThrow();
    }
    await expect(terminal.prepare("no-terminal", input("pwd"))).rejects.toThrow("disabled");
    await terminal.execute(
      await terminal.prepare("basic", input("mkdir", ["-p", "nested/folder"])),
      new AbortController().signal,
    );
    expect(
      (
        await terminal.execute(
          await terminal.prepare("basic", input("pwd", [], "nested/folder")),
          new AbortController().signal,
        )
      ).output.trim(),
    ).toBe(join(terminal.workspace, "nested/folder"));
  });

  it("does not expand shell syntax, strips inherited credentials, and redacts output across chunks", async () => {
    vi.stubEnv("VEKTOR_TEST_SECRET", "should-not-be-inherited");
    const env = await terminal.execute(
      await terminal.prepare(
        "full-access",
        input(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"]),
      ),
      new AbortController().signal,
    );
    expect(env.output).not.toContain("should-not-be-inherited");
    expect(env.output).not.toContain("VEKTOR_TEST_SECRET");
    vi.unstubAllEnvs();
    const result = await terminal.execute(
      await terminal.prepare(
        "full-access",
        input(process.execPath, [
          "-e",
          "process.stdout.write('private-test-'); setTimeout(() => process.stdout.write('credential'), 20)",
        ]),
      ),
      new AbortController().signal,
    );
    expect(result.output).toBe("[redacted]");
    await expect(terminal.prepare("basic", input("cat", ["$(pwd)"]))).rejects.toThrow();
  });

  it("enforces output limits and deadlines", async () => {
    const overflow = await terminal.execute(
      await terminal.prepare(
        "full-access",
        input(process.execPath, [
          "-e",
          "process.stdout.write('x'.repeat(100000)); setInterval(()=>{}, 1000)",
        ]),
      ),
      new AbortController().signal,
    );
    expect(overflow).toMatchObject({ isError: true, reason: "output_limit" });
    expect(overflow.output.length).toBeLessThan(1100);
    const timeout = await terminal.execute(
      await terminal.prepare("full-access", {
        ...input(process.execPath, ["-e", "setInterval(()=>{},1000)"]),
        timeoutMs: 100,
      }),
      new AbortController().signal,
    );
    expect(timeout).toMatchObject({ isError: true, reason: "timeout" });
  });

  it("cancels the process group including shell children within a few seconds", async () => {
    const marker = join(directory, "child.pid");
    const controller = new AbortController();
    const running = terminal.execute(
      await terminal.prepare(
        "full-access",
        input("sh", ["-c", `sleep 30 & echo $! > '${marker}'; wait`]),
      ),
      controller.signal,
    );
    let pid = 0;
    await vi.waitFor(async () => {
      pid = Number((await readFile(marker, "utf8")).trim());
      expect(pid).toBeGreaterThan(0);
    });
    const started = Date.now();
    controller.abort();
    expect(await running).toMatchObject({ reason: "cancelled", isError: true });
    expect(Date.now() - started).toBeLessThan(2000);
    await vi.waitFor(async () => {
      try {
        const state = await readFile(`/proc/${pid}/stat`, "utf8");
        expect(state.split(" ")[2]).toBe("Z");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
  });

  it("kills the supervised command if the API stdin connection disappears", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        SUPERVISOR_SOURCE,
        JSON.stringify({ command: "/usr/bin/sleep", args: ["30"], cwd: directory }),
      ],
      { detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"] },
    );
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.stdin!.destroy();
    await closed;
    expect(child.signalCode).toBe("SIGKILL");
  });
});
