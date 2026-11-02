import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { z } from "zod";
import { MCP_PROTOCOL_VERSION, type McpServer } from "@vektor/shared";
import type {
  Transport,
  FetchLike,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BrowserNetwork } from "../browser/network.js";
import { RuntimeError } from "../runtime/terminal.js";
import { StdioRpc, type RpcOptions } from "../runners/rpc.js";

export class IsolatedStdioTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  private rpc?: StdioRpc;
  constructor(private readonly options: RpcOptions) {}
  async start(): Promise<void> {
    if (this.rpc) throw new Error("MCP transport already started.");
    this.rpc = new StdioRpc({
      ...this.options,
      rawMessage: (message) => this.onmessage?.(JSONRPCMessageSchema.parse(message)),
    });
    void this.rpc.exited.then(() => this.onclose?.());
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.rpc) throw new Error("MCP transport is closed.");
    this.rpc.sendRaw(message);
  }
  async close(): Promise<void> {
    this.rpc?.close();
    await this.rpc?.exited;
  }
}

// Pin the negotiated revision even when the SDK understands older revisions.
// The client advertises no roots, sampling, elicitation or delegation capability.
export class PinnedTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  private initializeId?: string | number;
  private messages = 0;
  private readonly queue: JSONRPCMessage[] = [];
  private draining = false;
  private closed = false;
  failureReason?: string;
  changed = false;
  constructor(readonly inner: Transport) {}
  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message) => {
      try {
        if (++this.messages > 1000 || Buffer.byteLength(JSON.stringify(message)) > 1024 * 1024)
          throw new Error("MCP message limit exceeded.");
        if ("id" in message && message.id === this.initializeId && "result" in message) {
          if (
            !z
              .object({ protocolVersion: z.literal(MCP_PROTOCOL_VERSION) })
              .safeParse(message.result).success
          ) {
            this.failureReason = `This server did not negotiate the supported MCP ${MCP_PROTOCOL_VERSION} protocol.`;
            throw new Error("MCP protocol mismatch.");
          }
        }
        if (
          "method" in message &&
          /^notifications\/(tools|resources|prompts)\/list_changed$/.test(message.method)
        )
          this.changed = true;
        if (this.closed) return;
        if (this.queue.length >= 100) throw new Error("MCP dispatch queue exceeded its limit.");
        this.queue.push(message);
        void this.drain();
      } catch {
        this.onerror?.(new Error("Unsupported or oversized MCP protocol message."));
        void this.close();
      }
    };
    await this.inner.start();
  }
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    // SDK notification handlers run in microtasks. Preserve wire order so a
    // coalesced response cannot delete a progress handler before it runs.
    try {
      while (this.queue.length && !this.closed) {
        this.onmessage?.(this.queue.shift()!);
        await Promise.resolve();
      }
    } catch {
      this.onerror?.(new Error("MCP message dispatch failed."));
      await this.close();
    } finally {
      this.draining = false;
    }
  }
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (this.closed) throw new Error("MCP connection is closed.");
    if ("method" in message && message.method === "initialize" && "id" in message) {
      this.initializeId = message.id;
      message = {
        ...message,
        params: { ...message.params, protocolVersion: MCP_PROTOCOL_VERSION },
      };
    }
    await this.inner.send(message, options);
  }
  setProtocolVersion(version: string): void {
    if (version !== MCP_PROTOCOL_VERSION) throw new Error("Unsupported MCP protocol version.");
    this.inner.setProtocolVersion?.(version);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    await this.inner.close();
  }
}

export function guardedFetch(
  server: McpServer,
  credentials: Record<string, string>,
  signal: AbortSignal,
  protectedPort: number,
): FetchLike {
  const endpoint = new URL(server.url);
  let bytes = 0,
    requests = 0;
  return async (value, init = {}) => {
    const url = new URL(value);
    if (url.href !== endpoint.href || ++requests > 200)
      throw new RuntimeError(
        "MCP endpoint changes, redirects and excessive requests are blocked.",
        403,
      );
    const network = new BrowserNetwork({
      permissions: () => ({
        mode: "observe",
        session: "separate",
        display: "headless",
        allowedOrigins: [endpoint.origin],
        localOrigins: server.allowLoopback ? [endpoint.origin] : [],
      }),
      signal,
      redact: (value) => value,
      protectedPort,
    });
    const address = await network.address(url);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    for (const key of Object.keys(headers))
      if (/^(host|connection|content-length|proxy-.*|upgrade|cookie)$/i.test(key))
        delete headers[key];
    Object.assign(headers, credentials, { "accept-encoding": "identity" });
    const body = typeof init.body === "string" ? Buffer.from(init.body) : undefined;
    if (init.body && !body) throw new Error("Unsupported MCP request body.");
    if (body && body.length > 1024 * 1024)
      throw new RuntimeError("MCP request exceeds its size limit.", 413);
    const combined = AbortSignal.any([
      signal,
      ...(init.signal ? [init.signal] : []),
      AbortSignal.timeout(30_000),
    ]);
    return new Promise<Response>((resolve, reject) => {
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: init.method ?? "GET",
          headers,
          signal: combined,
          agent: false,
          family: address.family,
          lookup: (_host, _opts, done) => done(null, address.address, address.family),
        },
        (response) => {
          const status = response.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(
              new RuntimeError("MCP redirects are blocked. Configure the exact endpoint.", 403),
            );
            return;
          }
          if (
            response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity"
          ) {
            response.destroy();
            reject(new Error("Compressed MCP responses are unsupported."));
            return;
          }
          const sid = response.headers["mcp-session-id"];
          if (sid && (typeof sid !== "string" || sid.length > 200 || !/^[\x21-\x7e]+$/.test(sid))) {
            response.destroy();
            reject(new Error("Invalid MCP session identifier."));
            return;
          }
          let responseBytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            responseBytes += chunk.length;
            if (bytes > 8 * 1024 * 1024 || responseBytes > 1024 * 1024)
              response.destroy(new Error("MCP response exceeds its size limit."));
          });
          response.on("error", reject);
          const resultHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            if (
              value &&
              ![
                "transfer-encoding",
                "connection",
                "content-encoding",
                "content-length",
                "set-cookie",
              ].includes(name)
            )
              resultHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
          const stream = [204, 205, 304].includes(status)
            ? null
            : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
          if (!stream) response.resume();
          resolve(new Response(stream, { status, headers: resultHeaders }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  };
}

export function remoteTransport(
  server: McpServer,
  credentials: Record<string, string>,
  signal: AbortSignal,
  protectedPort: number,
): PinnedTransport {
  return new PinnedTransport(
    new StreamableHTTPClientTransport(new URL(server.url), {
      fetch: guardedFetch(server, credentials, signal, protectedPort),
      requestInit: { redirect: "error" },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    }),
  );
}
