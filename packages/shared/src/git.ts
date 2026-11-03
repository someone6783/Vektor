import { z } from "zod";

const absolutePathSchema = z
  .string()
  .refine((value) => value.length > 0 && value.length <= 2000 && !value.includes("\0"))
  .refine((value) => value.startsWith("/") || /^[a-z]:[\\/]/i.test(value));

export const gitStatusInputSchema = z.object({ path: absolutePathSchema }).strict();

export type GitStatusInput = z.infer<typeof gitStatusInputSchema>;

/** Porcelain status codes produced by `git status --porcelain=v1`. */
export const gitStatusCodeSchema = z.enum(["A", "C", "D", "M", "R", "T", "U", "?", " "]);

export type GitCode = z.infer<typeof gitStatusCodeSchema>;

const repositoryFileSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => {
    if (value.startsWith("/") || value.includes("\0") || value === ".") return false;
    return value.split("/").every((part) => part !== "" && part !== ".." && part !== ".");
  });

export const gitFileStatusSchema = z.object({
  path: repositoryFileSchema,
  index: gitStatusCodeSchema,
  worktree: gitStatusCodeSchema,
  untracked: z.boolean(),
});

export type GitFileStatus = z.infer<typeof gitFileStatusSchema>;

export const gitStatusSchema = z.object({
  repository: z.boolean(),
  branch: z.string().max(500).nullable(),
  upstream: z.string().max(500).nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(gitFileStatusSchema),
  filesTruncated: z.boolean(),
  lastCommit: z
    .object({
      hash: z.string().min(1),
      subject: z.string().max(2000),
      time: z.string(),
    })
    .nullable(),
});

export type GitStatus = z.infer<typeof gitStatusSchema>;

export const gitCommitInputSchema = z
  .object({
    path: absolutePathSchema,
    message: z.string().trim().min(1).max(1000),
    files: z.array(repositoryFileSchema).min(1).max(500),
  })
  .strict();

export type GitCommitInput = z.infer<typeof gitCommitInputSchema>;

export const gitCommitResultSchema = z.object({
  ok: z.literal(true),
  commit: z.string().min(1),
  branch: z.string().max(500).nullable(),
});

export type GitCommitResult = z.infer<typeof gitCommitResultSchema>;

export const gitPushInputSchema = z.object({ path: absolutePathSchema }).strict();

export const gitPushResultSchema = z.object({
  ok: z.literal(true),
  branch: z.string().max(500).nullable(),
  upstream: z.string().max(500).nullable(),
});

export type GitPushResult = z.infer<typeof gitPushResultSchema>;

export const gitFileInputSchema = z
  .object({ path: absolutePathSchema, file: repositoryFileSchema })
  .strict();

export type GitFileInput = z.infer<typeof gitFileInputSchema>;

export const gitDiffResultSchema = z.object({
  diff: z.string(),
  truncated: z.boolean(),
});

export type GitDiffResult = z.infer<typeof gitDiffResultSchema>;

export const gitFileResultSchema = z.object({
  content: z.string(),
  truncated: z.boolean(),
});

export type GitFileResult = z.infer<typeof gitFileResultSchema>;
