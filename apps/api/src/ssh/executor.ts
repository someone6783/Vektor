import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { SshConnection, TerminalInput, TerminalMode } from "@vektor/shared";

export interface SshSecret {
  password?: string;
  passphrase?: string;
}

export interface SshCommand {
  /** Remote command string passed to the SSH exec channel. */
  command: string;
  remoteCwd: string | null;
  timeoutMs: number;
}

export interface SshExecutionResult {
  output: string;
  exitCode: number | null;
  isError: boolean;
  reason: string;
}

export const REMOTE_TIMEOUT_MS = 120_000;

export class SshError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** Single-quote an argument for a POSIX remote shell. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Expand a leading ~ in a key path against the backend account's home. */
export function expandHomeDir(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2).replaceAll("\\", "/"));
  return path;
}

const BASIC_OPTIONS: Record<string, RegExp[]> = {
  ls: [/^-[alh]{1,3}$/],
  wc: [/^-[lwcm]{1,4}$/],
  cat: [],
  head: [/^-n$/, /^\d{1,4}$/],
  tail: [/^-n$/, /^\d{1,4}$/],
  pwd: [],
  mkdir: [/^-p$/],
  touch: [],
};

export class SshExecutor {
  constructor(
    private readonly connection: SshConnection,
    private readonly secret: SshSecret,
    private readonly outputLimit = 64 * 1024,
  ) {}

  prepare(mode: TerminalMode, input: TerminalInput): SshCommand {
    if (mode === "no-terminal")
      throw new SshError("Terminal access is disabled for this profile.", 403);
    if ([input.command, ...input.args, input.cwd ?? ""].some((value) => value.includes("\0")))
      throw new SshError("Command arguments cannot contain NUL bytes.");

    const cwd = input.cwd && input.cwd !== "." ? input.cwd : null;
    if (mode === "basic") {
      if (!BASIC_OPTIONS[input.command])
        throw new SshError(
          "Basic mode only allows: pwd, ls, cat, head, tail, wc, mkdir, and touch. Shells and interpreters are not allowed.",
          403,
        );
      const options = BASIC_OPTIONS[input.command] ?? [];
      for (const arg of input.args) {
        if (arg.startsWith("-")) {
          if (!options.some((pattern) => pattern.test(arg)))
            throw new SshError(
              "Basic mode over SSH allows only restricted options for workspace commands.",
              403,
            );
          continue;
        }
        if (isAbsolute(arg) || arg.split("/").includes(".."))
          throw new SshError(
            "Basic mode over SSH requires remote paths relative to the login directory.",
            403,
          );
      }
      if (input.command === "pwd" && input.args.length)
        throw new SshError("pwd does not accept arguments in basic mode.");
      if (!["pwd", "ls"].includes(input.command) && !input.args.some((arg) => !arg.startsWith("-")))
        throw new SshError("This basic command requires at least one remote file path.");
    } else if (cwd && !isAbsolute(cwd) && cwd.split("/").includes("..")) {
      throw new SshError("Remote working directory cannot traverse outside the login directory.");
    }

    return {
      command: buildRemoteCommand(input, cwd),
      remoteCwd: cwd,
      timeoutMs: Math.min(input.timeoutMs, REMOTE_TIMEOUT_MS),
    };
  }

  async execute(spec: SshCommand, signal: AbortSignal): Promise<SshExecutionResult> {
    const privateKey = await this.readKey();
    const configuration = this.authenticationConfig(privateKey);

    return await new Promise<SshExecutionResult>((resolveExecution) => {
      let settled = false;
      let reason = "completed";
      let exitCode: number | null = null;
      let outputLimitHit = false;
      let stream: ClientChannel | null = null;
      const chunks: Buffer[] = [];

      const resolveResult = (errorText = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        connection?.end();
        const body = Buffer.concat(chunks).toString("utf8") + suffix(reason) + errorText;
        resolveExecution({
          output: body.slice(0, this.outputLimit),
          exitCode: reason === "completed" ? exitCode : null,
          isError: reason !== "completed" || exitCode !== 0,
          reason,
        });
      };
      let connection: Client | null = null;
      const timer = setTimeout(() => {
        reason = "timeout";
        stream?.close();
        connection?.end();
      }, spec.timeoutMs);      const onAbort = () => {
        reason = "cancelled";
        stream?.close();
        connection?.end();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const finishError = (message: string) => {
        if (settled) return;
        reason = "error";
        resolveResult(message ? `\n${message}` : "");
      };

      const connectionFactory = () => {
        const client = new Client();
        client
          .on("error", (error: Error & { level?: string }) => {
            finishError(
              error.level === "client-timeout"
                ? "Timed out connecting to the SSH server."
                : error.message,
            );
          })
          .on("close", () => resolveResult())
          .on("keyboard-interactive", (_name, _instr, _lang, _prompts, finishAuthentication) => {
            finishAuthentication([this.secret.password ?? ""]);
          })
          .on("ready", () => {
            client.exec(spec.command, (error, channel) => {
              if (error) {
                finishError(error.message);
                return;
              }
              stream = channel;
              let outputBytes = 0;
              const capture = (chunk: Buffer) => {
                const remaining = this.outputLimit - outputBytes;
                if (remaining > 0) {
                  chunks.push(chunk.subarray(0, remaining));
                  outputBytes += chunk.length;
                }
                if (outputBytes > this.outputLimit && !outputLimitHit) {
                  outputLimitHit = true;
                  reason = "output_limit";
                  channel.close();
                }
              };
              channel.on("data", capture);
              channel.stderr.on("data", capture);
              channel.on("close", (code: number | null) => {
                exitCode = code;
                client.end();
              });
            });
          })
          .connect(configuration);
        return client;
      };

      if (signal.aborted) {
        onAbort();
        resolveResult();
        return;
      }
      connection = connectionFactory();
    });
  }

  private authenticationConfig(privateKey: Buffer | null): ConnectConfig {
    const config: ConnectConfig = {
      host: this.connection.host,
      port: this.connection.port,
      username: this.connection.username,
      readyTimeout: 10_000,
      keepaliveInterval: 5_000,
    };
    if (this.connection.authType === "password") {
      if (!this.secret.password)
        throw new SshError("This connection has no stored password. Save it under SSH settings.");
      config.password = this.secret.password;
      config.tryKeyboard = true;
      return config;
    }
    if (!privateKey && this.connection.keyPath)
      throw new SshError(
        `The SSH key file ${this.connection.keyPath} is unavailable on the backend machine.`,
      );
    config.privateKey = privateKey ?? undefined;
    if (this.secret.passphrase) config.passphrase = this.secret.passphrase;
    return config;
  }

  private async readKey(): Promise<Buffer | null> {
    if (this.connection.authType === "password" || !this.connection.keyPath) return null;
    try {
      const path = expandHomeDir(this.connection.keyPath);
      const file = await readFile(path);
      return file;
    } catch {
      return null;
    }
  }
}

function suffix(reason: string): string {
  if (reason === "timeout") return "\n[command timed out]";
  if (reason === "output_limit") return "\n[output limit reached; command stopped]";
  if (reason === "cancelled") return "\n[command cancelled]";
  return "";
}

/** Build the quoted remote exec string, assuming input has already been validated. */
export function buildRemoteCommand(input: TerminalInput, cwd: string | null): string {
  const base = [input.command, ...input.args].map(shellQuote).join(" ");
  return cwd ? `cd ${shellQuote(cwd)} && ${base}` : base;
}
