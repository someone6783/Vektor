import { z } from "zod";

export const updateCheckSchema = z.object({
  currentVersion: z.string(),
  repository: z.string(),
  repositoryPrivate: z.boolean(),
  enabled: z.boolean(),
  allowed: z.boolean(),
  tokenSource: z.enum(["none", "stored", "env"]),
  status: z.enum(["disabled", "current", "available", "unavailable", "unchecked"]),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  releaseUrl: z.string().url().nullable(),
  publishedAt: z.string().nullable(),
  checkedAt: z.string().nullable(),
  nextCheckAt: z.string().nullable(),
  error: z
    .enum(["token_required", "offline", "rate_limited", "not_found", "invalid_response"])
    .nullable(),
  cached: z.boolean(),
});
export type UpdateCheck = z.infer<typeof updateCheckSchema>;
export const updatePreferencesSchema = z
  .object({
    enabled: z.boolean().optional(),
    githubToken: z
      .string()
      .min(8)
      .max(500)
      .regex(/^[\x21-\x7e]+$/)
      .nullable()
      .optional(),
  })
  .strict();
export type UpdatePreferences = z.infer<typeof updatePreferencesSchema>;
