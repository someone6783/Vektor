import { z } from "zod";

export const computerAppSchema = z
  .object({
    name: z.string().min(1).max(80),
    command: z.string().min(1).max(500).startsWith("/", "Use an absolute executable path."),
    args: z.array(z.string().max(500)).max(32).default([]),
  })
  .strict();
export type ComputerApp = z.infer<typeof computerAppSchema>;

export const computerPermissionsSchema = z
  .object({
    mode: z.enum(["off", "observe", "control"]).default("off"),
    session: z.literal("isolated").default("isolated"),
    width: z.number().int().min(640).max(2560).default(1280),
    height: z.number().int().min(480).max(1600).default(800),
    apps: z.array(computerAppSchema).max(5).default([]),
    maxActions: z.number().int().min(1).max(200).default(60),
    maxDurationMs: z.number().int().min(1000).max(1_800_000).default(300_000),
    artifactDays: z.number().int().min(0).max(30).default(7),
  })
  .strict();
export type ComputerPermissions = z.infer<typeof computerPermissionsSchema>;

const coordinate = z.number().int().min(0).max(10_000);
const keyName = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[A-Za-z0-9+_-]+$/, "Use an X11 key name or chord such as Return or ctrl+a.");

export const computerInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("screenshot") }).strict(),
  z.object({ action: z.literal("windows") }).strict(),
  z.object({ action: z.literal("takeover") }).strict(),
  z.object({ action: z.literal("launch"), appIndex: z.number().int().min(0).max(4) }).strict(),
  z
    .object({
      action: z.literal("focus"),
      windowId: z.string().regex(/^\d+$/).max(20),
    })
    .strict(),
  z.object({ action: z.literal("move"), x: coordinate, y: coordinate }).strict(),
  z
    .object({
      action: z.literal("click"),
      x: coordinate,
      y: coordinate,
      button: z.enum(["left", "middle", "right"]).default("left"),
      count: z.number().int().min(1).max(2).default(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("drag"),
      fromX: coordinate,
      fromY: coordinate,
      toX: coordinate,
      toY: coordinate,
      durationMs: z.number().int().min(100).max(3000).default(400),
    })
    .strict(),
  z
    .object({
      action: z.literal("scroll"),
      x: coordinate,
      y: coordinate,
      direction: z.enum(["up", "down"]),
      amount: z.number().int().min(1).max(15).default(3),
    })
    .strict(),
  z
    .object({
      action: z.literal("type"),
      text: z.string().min(1).max(4000),
    })
    .strict(),
  z.object({ action: z.literal("key"), key: keyName }).strict(),
  z.object({ action: z.literal("wait"), ms: z.number().int().min(0).max(2000) }).strict(),
]);
export type ComputerInput = z.infer<typeof computerInputSchema>;

export const computerStateSchema = z.object({
  active: z.boolean(),
  paused: z.boolean(),
  sensitive: z.boolean(),
  phase: z.enum(["idle", "starting", "active", "closed", "failed"]).optional(),
  error: z.string().nullable().optional(),
  mode: z.enum(["off", "observe", "control"]).optional(),
  session: z.literal("isolated").optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  app: z.string().nullable().optional(),
  windows: z.array(z.object({ id: z.string(), title: z.string() })),
  cursor: z.object({ x: z.number().int(), y: z.number().int() }),
  actions: z.number().int().nonnegative(),
  remainingActions: z.number().int().nonnegative().optional(),
  expiresAt: z.number().optional(),
  apps: z.array(z.string()).optional(),
  target: z.string().nullable().optional(),
});
export type ComputerState = z.infer<typeof computerStateSchema>;

export const computerCapabilitiesSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  location: z.literal("backend-isolated"),
});
export type ComputerCapabilities = z.infer<typeof computerCapabilitiesSchema>;

export const computerArtifactSchema = z.object({
  id: z.string(),
  runId: z.string(),
  actionId: z.string(),
  action: z.string(),
  stage: z.enum(["before", "after"]),
  createdAt: z.string(),
  expiresAt: z.string(),
  size: z.number(),
});
export type ComputerArtifact = z.infer<typeof computerArtifactSchema>;
