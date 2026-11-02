import type { Duplex } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type RpcId = number | string;
export interface RpcMessage {
  jsonrpc?: "2.0";
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}
export interface RpcOptions {
  rawMessage?: (message: RpcMessage) => void;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  orphanCleanupPaths?: string[];
  maxBytes?: number;
  signal?: AbortSignal;
  failure?: () => void;
  interrupt?: () => Promise<void>;
  notification?: (message: RpcMessage) => void;
  request?: (message: RpcMessage) => Promise<unknown>;
}

// A pipe independent of the protocol stream watches the API lifetime. The child
// shares this supervisor's process group, so API death kills descendants as well.
const supervisor = `
const { spawn } = require('node:child_process');
const spec = JSON.parse(process.argv[1]);
let orphaned = false;
let normalClose = false;
function killGroup() { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } }
function orphan() {
  if (orphaned) return;
  orphaned = true;
  try {
    const children = require('node:fs').readFileSync('/proc/self/task/' + process.pid + '/children', 'utf8').trim().split(/ +/);
    for (const pid of children) if (pid) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
  } catch {}
  setTimeout(() => {
    for (const path of spec.orphanCleanupPaths || []) if (path.startsWith("/dev/shm/vektor-") && /^[a-zA-Z0-9_-]+$/.test(path.slice(9))) { try { require('node:fs').rmSync(path, { recursive:true, force:true, maxRetries:3, retryDelay:10 }); } catch {} }
    killGroup();
  }, 100);
}
function stop() { if (!orphaned) killGroup(); }
process.on('SIGTERM', stop);
require('node:fs').createReadStream(null, { fd: 3 }).on('data', () => { normalClose = true; try { require('node:fs').writeSync(3, 'ACK'); } catch {} }).on('end', orphan).on('error', orphan).resume();
const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: process.env, stdio: ['pipe','inherit','inherit'], shell: false });
process.stdin.pipe(child.stdin);
process.stdin.on('end', () => { if (!normalClose) orphan(); });
child.on('error', stop);
child.on('exit', stop);
`;

export class StdioRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    RpcId,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
      method: string;
    }
  >();
  private readonly inbound = new Set<RpcId>();
  private sequence = 0;
  private buffer = "";
  private bytes = 0;
  private closed = false;
  private closing = false;
  private failure?: Error;
  readonly exited: Promise<void>;
  private readonly abort = () => {
    if (this.closed) return;
    if (!this.options.interrupt) {
      this.close(new Error("Runner cancelled."));
      return;
    }
    const timer = setTimeout(() => this.close(new Error("Runner cancelled.")), 250);
    void this.options
      .interrupt()
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        this.close(new Error("Runner cancelled."));
      });
  };

  constructor(private readonly options: RpcOptions) {
    if (process.platform === "win32") throw new Error("External runners require a POSIX backend.");
    if (!options.command.startsWith("/"))
      throw new Error("Runner executable must be an absolute path.");
    this.child = spawn(
      process.execPath,
      [
        "-e",
        supervisor,
        JSON.stringify({
          command: options.command,
          args: options.args,
          cwd: options.cwd,
          orphanCleanupPaths: options.orphanCleanupPaths,
        }),
      ],
      {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        shell: false,
      },
    ) as ChildProcessWithoutNullStreams;
    this.exited = new Promise((resolve) =>
      this.child.once("close", () => {
        this.close(new Error("Runner process exited."));
        resolve();
      }),
    );
    this.child.once("error", () => this.close(new Error("Runner could not start.")));
    this.child.stdin.on("error", () => this.close(new Error("Runner input disconnected.")));
    this.child.stdout.on("error", () => this.close(new Error("Runner output disconnected.")));
    this.child.stderr.on("error", () => this.close(new Error("Runner diagnostics disconnected.")));
    this.child.stdio[3]?.on("error", () => this.close(new Error("Runner watchdog disconnected.")));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      try {
        this.receive(chunk);
      } catch {
        this.close(new Error("Malformed or oversized runner protocol message."));
      }
    });
    // stderr is never logged or returned: agents can echo credentials there.
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.bytes += chunk.length;
      if (this.bytes > (options.maxBytes ?? 8 * 1024 * 1024))
        this.close(new Error("Runner output limit exceeded."));
    });
    options.signal?.addEventListener("abort", this.abort, { once: true });
    if (options.signal?.aborted) this.abort();
  }

  private send(message: RpcMessage): void {
    if (this.closed) throw this.failure ?? new Error("Runner disconnected.");
    const encoded = JSON.stringify({ jsonrpc: "2.0", ...message });
    if (Buffer.byteLength(encoded) > 1024 * 1024)
      throw new Error("Runner request exceeds size limit.");
    this.child.stdin.write(`${encoded}\n`);
  }
  sendRaw(message: RpcMessage): void {
    this.send(message);
  }
  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }
  call(
    method: string,
    params: unknown,
    timeoutMs = this.options.timeoutMs ?? 15_000,
  ): Promise<unknown> {
    if (this.closed || this.closing)
      return Promise.reject(this.failure ?? new Error("Runner disconnected."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.close(new Error(`Runner request timed out: ${method}`)),
        timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.close(error instanceof Error ? error : new Error("Runner request failed."));
      }
    });
  }
  private receive(chunk: string): void {
    this.bytes += Buffer.byteLength(chunk);
    this.buffer += chunk;
    if (
      this.bytes > (this.options.maxBytes ?? 8 * 1024 * 1024) ||
      Buffer.byteLength(this.buffer) > 1024 * 1024
    )
      throw new Error("Output limit");
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid message");
      const message = value as RpcMessage;
      if (message.jsonrpc !== undefined && message.jsonrpc !== "2.0")
        throw new Error("Protocol mismatch");
      if (this.options.rawMessage) {
        if (message.jsonrpc !== "2.0") throw new Error("Protocol mismatch");
        this.options.rawMessage(message);
        continue;
      }
      if (
        message.id !== undefined &&
        typeof message.id !== "string" &&
        typeof message.id !== "number"
      )
        throw new Error("Invalid id");
      if (message.method !== undefined) {
        if (typeof message.method !== "string") throw new Error("Invalid method");
        if (message.id === undefined) this.options.notification?.(message);
        else {
          const id = message.id;
          if (this.inbound.has(id) || this.inbound.size >= 10_000)
            throw new Error("Duplicate request");
          this.inbound.add(id);
          void this.answer(message);
        }
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        // Unknown or duplicate responses cannot create work or replay a prompt.
        if (!pending) continue;
        if ("result" in message === "error" in message) throw new Error("Invalid response");
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(
            new Error(
              `${harnessError(message.error)} [${pending.method}; code ${Number.isInteger(message.error.code) ? message.error.code : "unknown"}]`,
            ),
          );
        else pending.resolve(message.result);
      } else throw new Error("Invalid message");
    }
  }
  private async answer(message: RpcMessage): Promise<void> {
    try {
      if (!this.options.request) throw new Error("Unsupported runner request");
      const result = await this.options.request(message);
      if (!this.closed) this.send({ id: message.id, result });
    } catch {
      if (!this.closed)
        this.send({
          id: message.id,
          error: { code: -32601, message: "Request denied by Vektor." },
        });
    }
  }
  async closeGracefully(): Promise<void> {
    if (this.closed) {
      await this.exited;
      return;
    }
    this.closing = true;
    const watchdog = this.child.stdio[3] as Duplex;
    const timer = setTimeout(() => this.close(), 750);
    watchdog.once("data", () => this.child.stdin.end());
    watchdog.write("CLOSE");
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const error = reason ?? new Error("Runner connection closed.");
    this.failure = error;
    if (reason && !this.closing) this.options.failure?.();
    this.options.signal?.removeEventListener("abort", this.abort);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try {
      if (this.child.pid) process.kill(-this.child.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
    this.child.stdin.destroy();
    const watchdog = this.child.stdio[3];
    watchdog?.destroy();
  }
}

export function harnessError(value: unknown): string {
  const message =
    value && typeof value === "object" && "message" in value && typeof value.message === "string"
      ? value.message
      : "";
  if (/quota|rate.?limit|usage.?limit|insufficient_quota|429/i.test(message))
    return "The agent account reached its usage or rate limit. Check that agent account's billing and quota.";
  if (/auth|unauthori[sz]ed|expired|invalid.?key|401|403/i.test(message))
    return "The agent's separate authentication expired or was rejected. Update its credential in Settings.";
  return "Runner rejected the request.";
}
