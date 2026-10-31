import type { RunEvent } from "./run-events.js";

export const SSE_HEARTBEAT = ": ping\n\n";
export const DEFAULT_SSE_RETRY_MS = 3_000;

export function formatSseFrame(event: RunEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function parseStreamCursor(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return 0;
}
