import { z } from "zod";
import { runSchema } from "./workspace.js";
import { runEventSchema } from "./run-events.js";

export const terminalInputSchema = z
  .object({
    command: z.string().min(1).max(500),
    args: z.array(z.string().max(4000)).max(64).default([]),
    cwd: z.string().max(2000).optional(),
    timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
  })
  .strict();
export type TerminalInput = z.infer<typeof terminalInputSchema>;

export const toolCallSchema = z.object({
  id: z.string(),
  runId: z.string(),
  providerCallId: z.string(),
  name: z.string(),
  input: z.unknown(),
  output: z.string(),
  status: z.enum(["requested", "waiting", "running", "completed", "failed", "denied", "cancelled"]),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});
export type ToolCall = z.infer<typeof toolCallSchema>;
export const approvalSchema = z.object({
  id: z.string(),
  runId: z.string(),
  toolCallId: z.string(),
  command: z.string(),
  status: z.enum(["pending", "approved", "denied", "cancelled"]),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type Approval = z.infer<typeof approvalSchema>;
export const auditEntrySchema = z.object({
  id: z.number(),
  action: z.string(),
  runId: z.string().nullable(),
  details: z.unknown(),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const runtimeStateSchema = z.object({
  emergencyStopped: z.boolean(),
  terminalSupported: z.boolean(),
  executionEnvironment: z.enum(["container", "host"]),
  activeRuns: z.array(runSchema),
  approvals: z.array(approvalSchema),
});
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
export const runDetailsSchema = z.object({
  run: runSchema,
  tools: z.array(toolCallSchema),
  approvals: z.array(approvalSchema),
  events: z.array(runEventSchema),
});
export type RunDetails = z.infer<typeof runDetailsSchema>;
