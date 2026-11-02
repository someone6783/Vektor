import { RUNNER_CONTRACT_VERSION, runnerIdSchema, type RunnerDescriptor } from "@vektor/shared";
import { RuntimeError } from "../runtime/terminal.js";

// This context-free descriptor exposes Native only. ExternalRunners performs
// installation/profile admission at interactive, retry, schedule and execution
// boundaries; a bare external identity never grants execution.
export interface RunnerAdapterV1 {
  readonly descriptor: RunnerDescriptor;
  assertSupported(): void;
}

export function runnerAdapter(identity: unknown): RunnerAdapterV1 {
  const parsed = runnerIdSchema.safeParse(identity);
  if (!parsed.success) throw new RuntimeError("Unsupported runner identity.", 409);
  const id = parsed.data;
  const reason =
    id === "native"
      ? null
      : id === "codex"
        ? "Codex requires a verified installation and explicit profile grants."
        : id.startsWith("acp:")
          ? "ACP agents require a verified installation and explicit profile grants."
          : "The generic CLI runner is reserved for a future adapter.";
  return {
    descriptor: {
      contractVersion: RUNNER_CONTRACT_VERSION,
      id,
      available: reason === null,
      reason,
    },
    assertSupported() {
      if (reason) throw new RuntimeError(reason, 409);
    },
  };
}

export function assertRunnerAvailable(identity: unknown): void {
  runnerAdapter(identity).assertSupported();
}
