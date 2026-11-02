import { z } from "zod";

export const MCP_PROTOCOL_VERSION = "2025-11-25" as const;
export const mcpIdSchema = z.string().uuid();
const boundedName = z.string().min(1).max(200);
export const mcpServerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    transport: z.enum(["stdio", "http"]),
    command: z.string().max(4096).default(""),
    args: z.array(z.string().max(4096)).max(32).default([]),
    environment: z
      .record(z.string().max(4000))
      .refine((value) => Object.keys(value).length <= 20)
      .default({}),
    workingDirectory: z.string().max(2000).default("."),
    url: z.string().max(2000).default(""),
    allowLoopback: z.boolean().default(false),
    hostBinaryAcknowledged: z.boolean().default(false),
    networkHosts: z
      .array(z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/))
      .max(5)
      .default([]),
  })
  .strict();
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;
export const mcpToolSchema = z.object({
  name: boundedName,
  description: z.string().max(4000).default(""),
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()).optional(),
  annotations: z.record(z.unknown()).optional(),
  execution: z
    .object({ taskSupport: z.enum(["forbidden", "optional", "required"]).optional() })
    .optional()
    .refine((v) => v?.taskSupport !== "required", "Background MCP tasks are unsupported."),
});
export const mcpResourceSchema = z.object({
  name: boundedName,
  uri: z.string().min(1).max(2000),
  description: z.string().max(4000).optional(),
  mimeType: z.string().max(200).optional(),
});
export const mcpTemplateSchema = mcpResourceSchema
  .omit({ uri: true })
  .extend({ uriTemplate: z.string().min(1).max(2000) });
export const mcpPromptSchema = z.object({
  name: boundedName,
  description: z.string().max(4000).optional(),
  arguments: z
    .array(
      z.object({
        name: boundedName,
        description: z.string().max(2000).optional(),
        required: z.boolean().optional(),
      }),
    )
    .max(30)
    .optional(),
});
export const mcpDiscoverySchema = z.object({
  protocolVersion: z.literal(MCP_PROTOCOL_VERSION),
  serverInfo: z.object({ name: boundedName, version: boundedName }),
  tools: z.array(mcpToolSchema).max(100),
  resources: z.array(mcpResourceSchema).max(100),
  templates: z.array(mcpTemplateSchema).max(100),
  prompts: z.array(mcpPromptSchema).max(100),
  checkedAt: z.string(),
  hash: z.string(),
  warnings: z.array(z.string()).max(20),
});
export type McpDiscovery = z.infer<typeof mcpDiscoverySchema>;
export type McpTool = z.infer<typeof mcpToolSchema>;
export const mcpGrantSchema = z
  .object({
    tools: z
      .array(z.object({ name: boundedName, policy: z.enum(["read-only", "approval"]) }).strict())
      .max(100)
      .default([]),
    resources: z.array(z.string().min(1).max(2000)).max(100).default([]),
    templates: z.array(z.string().min(1).max(2000)).max(100).default([]),
    prompts: z.array(boundedName).max(100).default([]),
    externalRunners: z.boolean().default(false),
    scheduled: z.boolean().default(false),
  })
  .strict();
export type McpGrant = z.infer<typeof mcpGrantSchema>;
export const mcpServerSchema = mcpServerInputSchema.extend({
  id: mcpIdSchema,
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  executableHash: z.string().optional(),
  configuredSecretNames: z.array(z.string()),
  discovery: mcpDiscoverySchema.nullable(),
  health: z.object({
    state: z.enum(["untested", "healthy", "unavailable"]),
    failures: z.number(),
    retryAt: z.number(),
    message: z.string(),
    checkedAt: z.string(),
  }),
});
export type McpServer = z.infer<typeof mcpServerSchema>;
export const mcpContextSchema = z.object({
  id: mcpIdSchema,
  serverId: mcpIdSchema,
  profileId: z.string(),
  revision: z.number(),
  kind: z.enum(["resource", "template", "prompt"]),
  name: z.string(),
  createdAt: z.string(),
  preview: z.string(),
  size: z.number(),
});
export type McpContext = z.infer<typeof mcpContextSchema>;
export const mcpSetupSchema = z.object({
  servers: z.array(mcpServerSchema),
  grants: z.array(
    z.object({
      serverId: mcpIdSchema,
      profileId: z.string(),
      revision: z.number(),
      grant: mcpGrantSchema,
    }),
  ),
});
export type McpSetup = z.infer<typeof mcpSetupSchema>;
