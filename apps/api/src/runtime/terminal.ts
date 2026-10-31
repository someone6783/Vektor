import { spawn } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TerminalInput, TerminalMode } from "@vektor/shared";
import { BASIC_COMMANDS } from "./policy.js";

export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
export interface TerminalResult {
  output: string;
  exitCode: number | null;
  isError: boolean;
  reason: string;
}
export interface PreparedCommand {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

// The supervisor retains the API's stdin pipe. EOF (including API death) kills
// its own process group. Commands share the group; shells cannot outlive normal exit.
export const SUPERVISOR_SOURCE = `
const { spawn } = require('node:child_process');
process.umask(0o077);
function killGroup() { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } }
process.stdin.resume();
process.stdin.on('end', killGroup);
process.on('disconnect', killGroup);
const spec = JSON.parse(process.argv[1]);
const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: process.env, stdio: ['ignore', 'inherit', 'inherit'], shell: false });
function done(result) {
  if (process.connected) process.send(result, () => killGroup());
  else killGroup();
}
child.once('error', error => done({ error: error.message }));
child.once('exit', (code, signal) => done({ code, signal }));
`;

export class TerminalExecutor {
  private readonly processes = new Set<{ kill: () => void; done: Promise<TerminalResult> }>();
  constructor(
    readonly workspace: string,
    readonly redact: (text: string) => string,
    readonly outputLimit = 64 * 1024,
  ) {}
  get supported(): boolean {
    return process.platform !== "win32";
  }

  async prepare(mode: TerminalMode, input: TerminalInput): Promise<PreparedCommand> {
    if (!this.supported)
      throw new RuntimeError(
        "Terminal execution requires a POSIX backend. Use the Docker backend on Windows.",
      );
    if (mode === "no-terminal")
      throw new RuntimeError("Terminal access is disabled for this profile.", 403);
    if ([input.command, ...input.args, input.cwd ?? ""].some((value) => value.includes("\0")))
      throw new RuntimeError("Command arguments cannot contain NUL bytes.");
    await mkdir(this.workspace, { recursive: true, mode: 0o700 });
    if ((await lstat(this.workspace)).isSymbolicLink())
      throw new RuntimeError("The workspace directory cannot be a symlink.", 403);
    const root = await realpath(this.workspace);
    const cwd = resolve(root, input.cwd ?? ".");
    if (mode === "full-access") {
      if (!(await lstat(cwd)).isDirectory())
        throw new RuntimeError("Working directory must be an existing directory.");
      return { ...input, cwd };
    }
    const inside = (path: string) => {
      const rel = relative(root, path);
      return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    };
    const checkPath = async (path: string, allowMissing: boolean) => {
      if (!inside(path))
        throw new RuntimeError("Basic mode paths must stay inside the workspace.", 403);
      let current = root;
      for (const part of relative(root, path).split(sep).filter(Boolean)) {
        current = join(current, part);
        try {
          const stat = await lstat(current);
          if (stat.isSymbolicLink())
            throw new RuntimeError("Basic mode does not follow symlinks.", 403);
          if (!stat.isDirectory() && !stat.isFile())
            throw new RuntimeError("Basic mode only supports regular files and directories.", 403);
        } catch (error) {
          if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") break;
          throw error;
        }
      }
    };
    await checkPath(cwd, false);
    if (!(await lstat(cwd)).isDirectory())
      throw new RuntimeError("Working directory must be a directory.");
    if (!(BASIC_COMMANDS as readonly string[]).includes(input.command))
      throw new RuntimeError(
        `Basic mode only allows: ${BASIC_COMMANDS.join(", ")}. Shells and interpreters are not allowed.`,
        403,
      );
    const args = [...input.args];
    if (input.command === "pwd" && args.length)
      throw new RuntimeError("pwd does not accept arguments in basic mode.");
    const paths: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg.startsWith("-")) {
        if (input.command === "ls" && /^-[alh]{1,3}$/.test(arg)) continue;
        if (input.command === "wc" && /^-[lwcm]{1,4}$/.test(arg)) continue;
        if (input.command === "mkdir" && arg === "-p") continue;
        if (
          ["head", "tail"].includes(input.command) &&
          arg === "-n" &&
          /^\d{1,4}$/.test(args[index + 1] ?? "") &&
          Number(args[index + 1]) <= 1000 &&
          Number(args[index + 1]) > 0
        ) {
          index++;
          continue;
        }
        throw new RuntimeError("This option is not allowed in basic mode.", 403);
      }
      paths.push(arg);
      await checkPath(resolve(cwd, arg), ["mkdir", "touch"].includes(input.command));
    }
    if (!["pwd", "ls"].includes(input.command) && !paths.length)
      throw new RuntimeError("This basic command requires at least one workspace file path.");
    return {
      command: `/usr/bin/${input.command}`,
      args,
      cwd,
      timeoutMs: Math.min(input.timeoutMs, 15_000),
    };
  }

  execute(spec: PreparedCommand, signal: AbortSignal): Promise<TerminalResult> {
    if (signal.aborted)
      return Promise.resolve({
        output: "Command cancelled.",
        exitCode: null,
        isError: true,
        reason: "cancelled",
      });
    let kill = () => {};
    const done = new Promise<TerminalResult>((resolveResult) => {
      const child = spawn(process.execPath, ["-e", SUPERVISOR_SOURCE, JSON.stringify(spec)], {
        detached: true,
        cwd: spec.cwd,
        shell: false,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: this.workspace,
          TMPDIR: this.workspace,
          LANG: "C.UTF-8",
        },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      let bytes = 0;
      const chunks: Buffer[] = [];
      let reason = "completed";
      let result: { code?: number | null; signal?: string; error?: string } = {};
      kill = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already exited */
          }
        }
      };
      const onAbort = () => {
        reason = "cancelled";
        kill();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        reason = "timeout";
        kill();
      }, spec.timeoutMs);
      const capture = (chunk: Buffer) => {
        const remaining = this.outputLimit - bytes;
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        bytes += chunk.length;
        if (bytes > this.outputLimit) {
          reason = "output_limit";
          kill();
        }
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      child.on("message", (message) => {
        result = message as typeof result;
      });
      child.on("error", (error) => {
        result.error = error.message;
      });
      child.once("close", () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const output = this.redact(Buffer.concat(chunks).toString("utf8"));
        const suffix =
          reason === "timeout"
            ? "\n[command timed out]"
            : reason === "output_limit"
              ? "\n[output limit reached; command stopped]"
              : reason === "cancelled"
                ? "\n[command cancelled]"
                : result.error
                  ? `\n${this.redact(result.error)}`
                  : "";
        resolveResult({
          output: output + suffix,
          exitCode: result.code ?? null,
          isError: reason !== "completed" || result.code !== 0,
          reason,
        });
      });
      if (signal.aborted) onAbort();
    });
    const tracked = { kill: () => kill(), done };
    this.processes.add(tracked);
    void done.finally(() => this.processes.delete(tracked));
    return done;
  }

  async stopAll(): Promise<void> {
    const pending = [...this.processes];
    for (const item of pending) item.kill();
    await Promise.all(pending.map((item) => item.done));
  }
}
