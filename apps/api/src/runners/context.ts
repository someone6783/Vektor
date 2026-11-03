import { z } from "zod";
import { getSetting, setSetting, type VektorDatabase } from "@vektor/db";
import type { RunnerContext } from "@vektor/shared";

// `total` is cumulative billing usage; `last` describes the current model request.
export function codexContext(detail: unknown): RunnerContext | undefined {
  const parsed = z
    .object({
      tokenUsage: z.object({
        last: z.object({
          inputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
          totalTokens: z.number().int().nonnegative(),
        }),
        modelContextWindow: z.number().int().positive().nullish(),
      }),
    })
    .safeParse(detail);
  if (!parsed.success) return undefined;
  return {
    ...parsed.data.tokenUsage.last,
    contextWindow: parsed.data.tokenUsage.modelContextWindow ?? null,
  };
}
const savedWindowSchema = z.object({
  contextWindow: z.number().int().positive(),
  executableHash: z.string(),
  authVersion: z.number(),
  checkedAt: z.number(),
});
export function rememberContextWindow(
  db: VektorDatabase,
  runner: string,
  model: string,
  executableHash: string,
  context: RunnerContext,
): void {
  if (context.contextWindow === null) return;
  setSetting(db, `runner.contextWindow.${runner}.${model}`, {
    contextWindow: context.contextWindow,
    executableHash,
    authVersion: getSetting(db, `runner.authVersion.${runner}`) ?? 0,
    checkedAt: Date.now(),
  });
}
export function knownContextWindow(
  db: VektorDatabase,
  runner: string,
  model: string,
): number | null {
  const saved = savedWindowSchema.safeParse(
    getSetting(db, `runner.contextWindow.${runner}.${model}`),
  );
  if (!saved.success || Date.now() - saved.data.checkedAt > 86400000) return null;
  const installed = z
    .array(z.object({ id: z.string(), executableHash: z.string() }))
    .safeParse(getSetting(db, "runner.installations"));
  const entry = installed.success ? installed.data.find((item) => item.id === runner) : undefined;
  return entry?.executableHash === saved.data.executableHash &&
    (getSetting(db, `runner.authVersion.${runner}`) ?? 0) === saved.data.authVersion
    ? saved.data.contextWindow
    : null;
}
