import { z } from "zod";

export const RUNNER_CONTRACT_VERSION = 1 as const;

// Registry ids are namespaced and bounded; bare "acp" is not an identity.
export const runnerIdSchema = z.union([
  z.enum(["native", "codex", "cli"]),
  z
    .string()
    .refine(
      (value): value is `acp:${string}` => /^acp:[a-z0-9][a-z0-9._-]{0,99}$/.test(value),
      "Invalid ACP runner identity",
    ),
]);
export type RunnerId = z.infer<typeof runnerIdSchema>;

export const runnerDescriptorSchema = z.object({
  contractVersion: z.literal(RUNNER_CONTRACT_VERSION),
  id: runnerIdSchema,
  available: z.boolean(),
  reason: z.string().nullable(),
});
export type RunnerDescriptor = z.infer<typeof runnerDescriptorSchema>;

export const runnerProbeSchema = z.object({
  interface: z.enum(["codex-app-server", "acp-v1"]),
  command: z.string(),
  args: z.array(z.string()),
  executableHash: z.string(),
  checkedAt: z.string(),
  protocolCompatible: z.boolean(),
  executionAvailable: z.literal(false),
  reason: z.string(),
  agent: z.object({ name: z.string(), version: z.string() }).nullable(),
});
export const runnerInstallationSchema = z.object({
  id: runnerIdSchema,
  name: z.string(),
  interface: z.enum(["codex-app-server", "acp-v1"]),
  version: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  executableHash: z.string(),
  source: z.string(),
  sourceHash: z.string(),
  verifiedAt: z.string(),
  enabled: z.boolean(),
  inferenceHosts: z.array(z.string()),
  credentialName: z.string(),
  credentialConfigured: z.boolean(),
  authKind: z.enum(["separate-api-key", "native-account"]).optional(),
  compatible: z.boolean().optional(),
  compatibilityReason: z.string().optional(),
  health: z
    .object({ state: z.string(), failures: z.number(), retryAt: z.number(), checkedAt: z.string() })
    .optional(),
});
export type RunnerInstallationView = z.infer<typeof runnerInstallationSchema>;
export const runnerSetupSchema = z.object({
  installations: z.array(runnerInstallationSchema).default([]),
  grants: z
    .array(
      z.object({
        profileId: z.string(),
        runner: runnerIdSchema.optional(),
        workspace: z.boolean(),
        inference: z.boolean(),
      }),
    )
    .default([]),
  probes: z.array(runnerProbeSchema),
  registry: z
    .object({
      source: z.string(),
      checkedAt: z.string(),
      hash: z.string(),
      agents: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          version: z.string(),
          description: z.string(),
          authors: z.array(z.string()),
          repository: z.string().optional(),
          website: z.string().optional(),
        }),
      ),
    })
    .nullable(),
});
export type RunnerSetupView = z.infer<typeof runnerSetupSchema>;

export const runnerContextSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  contextWindow: z.number().int().positive().nullable(),
});
export type RunnerContext = z.infer<typeof runnerContextSchema>;

export const harnessStateSchema = z.object({
  contractVersion: z.literal(RUNNER_CONTRACT_VERSION).default(RUNNER_CONTRACT_VERSION),
  interface: z.enum(["codex-app-server", "acp-v1"]),
  agentVersion: z.string(),
  executableHash: z.string(),
  policyHash: z.string().optional(),
  sessionId: z.string().optional(),
  turnId: z.string().nullable().optional(),
  cursor: z.number().int().nonnegative(),
  state: z.enum(["starting", "running", "completed", "failed", "cancelled", "interrupted"]),
  resumeFromRunId: z.string().optional(),
  metricsAvailable: z.boolean(),
  context: runnerContextSchema.optional(),
  contextSelection: z
    .object({
      attachmentIds: z.array(z.string()),
      mcpContextIds: z.array(z.string()).optional(),
      includeHistory: z.boolean(),
      truncated: z.boolean(),
    })
    .optional(),
  reportedUsage: z
    .object({ promptTokens: z.number(), completionTokens: z.number(), totalTokens: z.number() })
    .optional(),
});
export type HarnessState = z.infer<typeof harnessStateSchema>;
