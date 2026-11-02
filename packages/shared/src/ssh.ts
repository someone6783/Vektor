import { z } from "zod";

const isoDateSchema = z.string().min(1);

export const sshAuthTypeSchema = z.enum(["key", "password"]);

export type SshAuthType = z.infer<typeof sshAuthTypeSchema>;

/** Stored SSH connection. Secrets are never returned; only presence is reported. */
export const sshConnectionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  authType: sshAuthTypeSchema,
  /** Absolute or ~-relative path of the private key on the backend machine. */
  keyPath: z.string().max(500).nullable(),
  hasPassword: z.boolean(),
  hasPassphrase: z.boolean(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

export type SshConnection = z.infer<typeof sshConnectionSchema>;

export const sshConnectionInputObjectSchema = z
  .object({
    name: z.string().min(1).max(80),
    host: z
      .string()
      .min(1)
      .max(253)
      .refine((value) => !/[\s"\0]/.test(value), { message: "Invalid SSH host." }),
    port: z.number().int().min(1).max(65535).default(22),
    username: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => !/[\s"\0]/.test(value), { message: "Invalid SSH username." }),
    authType: sshAuthTypeSchema,
    keyPath: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => !/\0/.test(value) && !/^\/(dev|proc|sys)\//.test(value), {
        message: "Invalid SSH key path.",
      })
      .optional(),
  })
  .strict();

export const sshConnectionInputSchema = sshConnectionInputObjectSchema.refine(
  (value) => (value.authType === "key" ? typeof value.keyPath === "string" : true),
  { message: "Key authentication requires an SSH key path." },
);

export type SshConnectionInput = z.infer<typeof sshConnectionInputSchema>;

/** Write-only secret update; omitted fields keep their current value. */
export const sshSecretSchema = z
  .object({
    password: z.string().min(1).max(16000).nullable().optional(),
    passphrase: z.string().max(16000).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.password !== undefined || value.passphrase !== undefined,
    { message: "Provide a password or a key passphrase." },
  );

export type SshSecretInput = z.infer<typeof sshSecretSchema>;

export const sshSetupSchema = z.object({
  connections: z.array(sshConnectionSchema),
});

export type SshSetup = z.infer<typeof sshSetupSchema>;

export const sshTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});

export type SshTestResult = z.infer<typeof sshTestResultSchema>;
