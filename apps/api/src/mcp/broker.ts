import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ChatRequest } from "../providers/types.js";
import { MCP_PROTOCOL_VERSION } from "@vektor/shared";
import { z } from "zod";

// ACP stdio MCP configuration executes only this bridge inside the agent's
// namespace. The mounted Unix socket reaches this run's granted tool broker.
const relay = `import os,socket,select
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.connect('/run/vektor-mcp.sock')
while True:
 ready,_,_=select.select([0,s],[],[],60)
 if not ready:break
 for source in ready:
  data=os.read(0,65536) if source==0 else s.recv(65536)
  if not data:raise SystemExit
  if source==0:s.sendall(data)
  else:os.write(1,data)
`;
export const brokerMcpServer = {
  name: "vektor-granted-tools",
  command: "/usr/bin/python3",
  args: ["-c", relay],
  env: [],
};
export class McpBroker {
  private readonly sockets = new Set<Socket>();
  private readonly calls = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<unknown>>();
  private count = 0;
  private directory?: string;
  private readonly server = createServer((socket) => this.accept(socket));
  constructor(
    private readonly tools: NonNullable<ChatRequest["tools"]>,
    private readonly invoke: (
      name: string,
      input: unknown,
      id: string,
      signal: AbortSignal,
    ) => Promise<string>,
    private readonly signal: AbortSignal,
  ) {}
  async listen(): Promise<string> {
    this.signal.throwIfAborted();
    this.directory = await mkdtemp("/dev/shm/vektor-mcp-broker-");
    const path = join(this.directory, "broker.sock");
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(path, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    return path;
  }
  get cleanupPaths(): string[] {
    return this.directory ? [this.directory] : [];
  }
  private accept(socket: Socket) {
    if (this.sockets.size >= 2 || this.signal.aborted || this.count >= 32) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setTimeout(60_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    const owner = String(++this.count);
    let bytes = 0,
      buffer = "",
      initialized = false;
    const seen = new Set<string | number>();
    socket.setEncoding("utf8");
    socket.once("close", () => {
      this.sockets.delete(socket);
      for (const [key, controller] of this.calls)
        if (key.startsWith(`${owner}:`)) controller.abort();
    });
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      buffer += chunk;
      if (bytes > 4 * 1024 * 1024 || Buffer.byteLength(buffer) > 1024 * 1024) {
        socket.destroy();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const message = z
            .object({
              jsonrpc: z.literal("2.0"),
              id: z.union([z.string().max(200), z.number().int().safe()]).optional(),
              method: z.string(),
              params: z.record(z.unknown()).optional(),
            })
            .parse(JSON.parse(line));
          if (message.id !== undefined) {
            if (seen.has(message.id) || seen.size >= 100) throw new Error("duplicate");
            seen.add(message.id);
          }
          if (message.method === "notifications/cancelled") {
            this.calls
              .get(
                `${owner}:${typeof message.params?.requestId}:${String(message.params?.requestId)}`,
              )
              ?.abort();
            continue;
          }
          const send = (result: unknown, error = false) => {
            if (!socket.destroyed && message.id !== undefined)
              socket.write(
                `${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(error ? { error: { code: -32601, message: "MCP request denied by Vektor." } } : { result }) })}\n`,
              );
          };
          if (message.method === "initialize" && !initialized) {
            initialized = true;
            send({
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "vektor-granted-tools", version: "1.0.0" },
            });
          } else if (message.method === "notifications/initialized") continue;
          else if (message.method === "ping" && initialized) send({});
          else if (message.method === "tools/list" && initialized)
            send({
              tools: this.tools.map((t) => ({
                name: t.function.name,
                description: t.function.description,
                inputSchema: t.function.parameters,
              })),
            });
          else if (message.method === "tools/call" && initialized && message.id !== undefined) {
            const params = z
              .object({ name: z.string(), arguments: z.record(z.unknown()).default({}) })
              .parse(message.params);
            if (!this.tools.some((t) => t.function.name === params.name)) {
              send({}, true);
              continue;
            }
            const key = `${owner}:${typeof message.id}:${message.id}`,
              controller = new AbortController();
            this.calls.set(key, controller);
            const task = this.invoke(
              params.name,
              params.arguments,
              `mcp-broker-${owner}-${message.id}`,
              AbortSignal.any([this.signal, controller.signal]),
            )
              .then(
                (text) => send({ content: [{ type: "text", text }] }),
                () => send({}, true),
              )
              .finally(() => {
                this.calls.delete(key);
                this.tasks.delete(task);
              });
            this.tasks.add(task);
          } else send({}, true);
        } catch {
          socket.destroy();
          return;
        }
      }
    });
  }
  async close(): Promise<void> {
    for (const controller of this.calls.values()) controller.abort();
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>((r) => this.server.close(() => r()));
    await Promise.allSettled([...this.tasks]);
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
