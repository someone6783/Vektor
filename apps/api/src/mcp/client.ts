import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  MCP_PROTOCOL_VERSION,
  mcpDiscoverySchema,
  mcpToolSchema,
  mcpResourceSchema,
  mcpTemplateSchema,
  mcpPromptSchema,
  type McpDiscovery,
  type McpTool,
} from "@vektor/shared";
import type { PinnedTransport } from "./transport.js";
import { hash } from "./store.js";
import { validateSchemas } from "./validation.js";
import { RuntimeError } from "../runtime/terminal.js";

export class McpClient {
  private closed = false;
  readonly client = new Client(
    { name: "vektor", version: "0.1.0" },
    {
      capabilities: {},
      // Validation is performed by the bounded worker below, rather than compiling
      // untrusted output schemas synchronously on the API event loop.
      jsonSchemaValidator: {
        getValidator: () => () => ({
          valid: false,
          data: undefined,
          errorMessage: "Use bounded validation.",
        }),
      },
    },
  );
  private readonly requestOptions;
  constructor(
    readonly transport: PinnedTransport,
    signal: AbortSignal,
  ) {
    this.requestOptions = {
      signal,
      timeout: 10_000,
      maxTotalTimeout: 10_000,
      resetTimeoutOnProgress: false,
    };
    this.client.onerror = () => {}; // Untrusted protocol errors must not reach logs.
  }
  async connect(): Promise<void> {
    try {
      await this.client.connect(this.transport, this.requestOptions);
    } catch (error) {
      if (this.transport.failureReason) throw new RuntimeError(this.transport.failureReason, 409);
      throw error;
    }
  }
  async discover(): Promise<McpDiscovery> {
    const capabilities = this.client.getServerCapabilities() ?? {};
    const warnings = Object.keys(capabilities)
      .filter((k) => !["tools", "resources", "prompts", "logging"].includes(k))
      .map((k) => `Server capability ${k.slice(0, 100)} is unsupported and disabled.`)
      .slice(0, 20);
    const page = async <T>(
      request: (cursor?: string) => Promise<{ nextCursor?: string }>,
      key: string,
      schema: z.ZodType<T>,
    ): Promise<T[]> => {
      let cursor: string | undefined;
      const cursors = new Set<string>(),
        items: T[] = [];
      for (let n = 0; n < 5; n++) {
        const result = (await request(cursor)) as Record<string, unknown>;
        const parsed = z.array(schema).max(100).safeParse(result[key]);
        if (!parsed.success)
          throw new RuntimeError(
            `MCP ${key} discovery contains unsupported definitions or exceeds its limits. Task-required tools are unavailable.`,
            409,
          );
        items.push(...parsed.data);
        if (items.length > 100)
          throw new RuntimeError("MCP discovery exceeds its item limit.", 413);
        cursor = z.string().max(2000).optional().parse(result.nextCursor);
        if (!cursor) return items;
        if (cursors.has(cursor)) throw new Error("MCP pagination cursor repeated.");
        cursors.add(cursor);
      }
      throw new Error("MCP discovery exceeds its page limit.");
    };
    const tools = capabilities.tools
      ? await page(
          (cursor) => this.client.listTools(cursor ? { cursor } : {}, this.requestOptions),
          "tools",
          mcpToolSchema,
        )
      : [];
    const resources = capabilities.resources
      ? await page(
          (cursor) => this.client.listResources(cursor ? { cursor } : {}, this.requestOptions),
          "resources",
          mcpResourceSchema,
        )
      : [];
    const templates = capabilities.resources
      ? await page(
          (cursor) =>
            this.client.listResourceTemplates(cursor ? { cursor } : {}, this.requestOptions),
          "resourceTemplates",
          mcpTemplateSchema,
        )
      : [];
    const prompts = capabilities.prompts
      ? await page(
          (cursor) => this.client.listPrompts(cursor ? { cursor } : {}, this.requestOptions),
          "prompts",
          mcpPromptSchema,
        )
      : [];
    for (const [items, key] of [
      [tools, "name"],
      [resources, "uri"],
      [templates, "uriTemplate"],
      [prompts, "name"],
    ] as const) {
      const keys = items.map((i) => (i as Record<string, unknown>)[key]);
      if (new Set(keys).size !== keys.length) throw new Error("Duplicate MCP discovery identity.");
    }
    await validateSchemas(
      tools.flatMap((t) => [t.inputSchema, ...(t.outputSchema ? [t.outputSchema] : [])]),
    );
    tools.sort((a, b) => a.name.localeCompare(b.name));
    resources.sort((a, b) => a.uri.localeCompare(b.uri));
    templates.sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate));
    prompts.sort((a, b) => a.name.localeCompare(b.name));
    warnings.sort();
    const details = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: this.client.getServerVersion(),
      tools,
      resources,
      templates,
      prompts,
      warnings,
    };
    if (this.transport.changed)
      throw new Error("MCP discovery changed during testing. Test it again.");
    return mcpDiscoverySchema.parse({
      ...details,
      hash: hash(details),
      checkedAt: new Date().toISOString(),
    });
  }
  async call(
    tool: McpTool,
    input: unknown,
    signal: AbortSignal,
    progress: (detail: unknown) => void,
  ) {
    await validateSchemas([tool.inputSchema], input);
    const args = z.record(z.unknown()).parse(input);
    let updates = 0;
    const result = await this.client.request(
      { method: "tools/call", params: { name: tool.name, arguments: args } },
      CallToolResultSchema,
      {
        signal: AbortSignal.any([signal, this.requestOptions.signal]),
        timeout: 30_000,
        maxTotalTimeout: 30_000,
        resetTimeoutOnProgress: false,
        onprogress: (value) => {
          if (++updates <= 50)
            progress({
              progress: value.progress,
              ...(value.total !== undefined ? { total: value.total } : {}),
              ...(value.message ? { message: value.message.slice(0, 1000) } : {}),
            });
        },
      },
    );
    if (tool.outputSchema && !result.isError) {
      if (!result.structuredContent) throw new Error("MCP tool omitted its structured output.");
      await validateSchemas([tool.outputSchema], result.structuredContent);
    }
    if (this.transport.changed)
      throw new Error(
        "MCP definitions changed during the call. Test the server before another call.",
      );
    return result;
  }
  async resource(uri: string) {
    const result = await this.client.readResource({ uri }, this.requestOptions);
    return result.contents
      .map((item) => {
        if (!("text" in item) || typeof item.text !== "string")
          throw new RuntimeError("Only text MCP resources are supported.", 415);
        return item.text;
      })
      .join("\n\n");
  }
  async prompt(name: string, args: Record<string, string>) {
    const result = await this.client.getPrompt({ name, arguments: args }, this.requestOptions);
    return result.messages
      .map((message) => {
        if (message.content.type !== "text")
          throw new RuntimeError("Only text MCP prompts are supported.", 415);
        return `[${message.role}] ${message.content.text}`;
      })
      .join("\n\n");
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const inner = this.transport.inner as { terminateSession?: () => Promise<void> };
    if (inner.terminateSession)
      await Promise.race([
        inner.terminateSession().catch(() => {}),
        new Promise<void>((r) => {
          const t = setTimeout(r, 300);
          t.unref();
        }),
      ]);
    await this.client.close();
  }
}
