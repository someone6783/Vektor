import { z } from "zod";
export const reasoningEffortSchema = z.enum([
  "auto",
  "on",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export function contextReasoning(context: unknown): ReasoningEffort {
  const result = reasoningEffortSchema.safeParse(
    context && typeof context === "object" && "reasoning" in context
      ? context.reasoning
      : undefined,
  );
  return result.success ? result.data : "auto";
}
