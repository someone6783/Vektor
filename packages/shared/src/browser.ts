import { z } from "zod";

const originSchema = z
  .string()
  .max(300)
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  }, "Use an exact http(s) origin without paths or credentials.")
  .transform((value) => new URL(value).origin);
export const browserPermissionsSchema = z
  .object({
    mode: z.enum(["off", "observe", "interactive"]).default("off"),
    session: z.enum(["default", "separate"]).default("separate"),
    display: z.enum(["headless", "window"]).default("headless"),
    allowedOrigins: z
      .array(z.union([z.literal("*"), originSchema]))
      .max(20)
      .default([])
      .transform((origins) => (origins.length ? origins : ["*"])),
    localOrigins: z
      .array(
        originSchema.refine(
          (value) =>
            URL.canParse(value) &&
            ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname),
          "Local testing grants must name a loopback origin and port.",
        ),
      )
      .max(10)
      .default([]),
  })
  .strict();
export type BrowserPermissions = z.infer<typeof browserPermissionsSchema>;
export const browserInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: z.string().url().max(2000) }).strict(),
  z.object({ action: z.literal("snapshot") }).strict(),
  z.object({ action: z.literal("screenshot") }).strict(),
  z.object({ action: z.literal("tabs") }).strict(),
  z.object({ action: z.literal("new_tab"), url: z.string().url().max(2000) }).strict(),
  z.object({ action: z.literal("select_tab"), tabId: z.string().max(80) }).strict(),
  z.object({ action: z.literal("close_tab"), tabId: z.string().max(80) }).strict(),
  z.object({ action: z.literal("click"), ref: z.string().max(80) }).strict(),
  z
    .object({
      action: z.literal("fill"),
      ref: z.string().max(80),
      text: z.string().max(4000),
      privateInput: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("scroll"),
      direction: z.enum(["up", "down"]),
      amount: z.number().int().min(1).max(1500).default(600),
    })
    .strict(),
  z.object({ action: z.literal("wait"), ms: z.number().int().min(0).max(2000) }).strict(),
  z
    .object({
      action: z.literal("upload"),
      ref: z.string().max(80),
      attachmentId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("download"),
      url: z.string().url().max(2000),
      filename: z.string().min(1).max(150),
    })
    .strict(),
]);
export type BrowserInput = z.infer<typeof browserInputSchema>;
export const browserStateSchema = z.object({
  display: z.enum(["headless", "window"]).optional(),
  phase: z.enum(["idle", "starting", "active", "closed", "failed"]).optional(),
  error: z.string().nullable().optional(),
  session: z.enum(["default", "separate"]).optional(),
  mode: z.enum(["off", "observe", "interactive"]).optional(),
  active: z.boolean(),
  paused: z.boolean(),
  sensitive: z.boolean(),
  url: z.string(),
  tabs: z.array(z.object({ id: z.string(), url: z.string() })),
  actions: z.number(),
  snapshot: z.string(),
});
export type BrowserState = z.infer<typeof browserStateSchema>;
export const browserArtifactSchema = z.object({
  id: z.string(),
  runId: z.string(),
  origin: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  size: z.number(),
});
export type BrowserArtifact = z.infer<typeof browserArtifactSchema>;
export const defaultBrowserProfileSchema = z.object({
  configured: z.boolean(),
  inUse: z.boolean(),
  runId: z.string().nullable(),
  savedAt: z.string().nullable(),
  error: z.enum(["save_failed"]).nullable(),
});
export type DefaultBrowserProfile = z.infer<typeof defaultBrowserProfileSchema>;
export const browserCapabilitiesSchema = z.object({
  visibleWindowAvailable: z.boolean(),
  reason: z.string().nullable(),
  windowLocation: z.literal("backend"),
});
export type BrowserCapabilities = z.infer<typeof browserCapabilitiesSchema>;
