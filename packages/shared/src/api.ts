import { z } from "zod";

export const healthStatusSchema = z.enum(["ok", "error"]);

export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  version: z.string().min(1),
  instanceId: z.string().min(1),
  database: healthStatusSchema,
  uptimeSeconds: z.number().nonnegative(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export function makeApiError(
  code: string,
  message: string,
  extra: { requestId?: string; details?: unknown } = {},
): ApiError {
  return {
    error: {
      code,
      message,
      ...extra,
    },
  };
}
