import {
  appendRunEvent,
  createMessage,
  updateRun,
  type ProfileRecord,
  type RunRecord,
  type VektorDatabase,
} from "@vektor/db";
import type { RunEvent } from "@vektor/shared";
import type { ChatMessage } from "../providers/index.js";
import type { ChatProvider } from "../providers/types.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type RunEventInput = DistributiveOmit<RunEvent, "seq" | "runId">;

interface Logger {
  info: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
}

interface ActiveRun {
  run: RunRecord;
  controller: AbortController;
  seq: number;
  events: RunEvent[];
  listeners: Set<(event: RunEvent) => void>;
  cancelled: boolean;
  finished: boolean;
}

export interface RunSubscription {
  active: boolean;
  replay: RunEvent[];
  unsubscribe: () => void;
}

export interface StartRunInput {
  run: RunRecord;
  profile: ProfileRecord;
  messages: ChatMessage[];
}

export interface RunManagerOptions {
  db: VektorDatabase;
  getChatProvider: () => ChatProvider;
  logger: Logger;
}

function parseToolInput(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return argumentsJson;
  }
}

export class RunManager {
  private readonly db: VektorDatabase;
  private readonly getChatProvider: () => ChatProvider;
  private readonly logger: Logger;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: RunManagerOptions) {
    this.db = options.db;
    this.getChatProvider = options.getChatProvider;
    this.logger = options.logger;
  }

  start(input: StartRunInput): void {
    const active: ActiveRun = {
      run: input.run,
      controller: new AbortController(),
      seq: 0,
      events: [],
      listeners: new Set(),
      cancelled: false,
      finished: false,
    };

    this.active.set(input.run.id, active);
    void this.execute(active, input.profile, input.messages);
  }

  subscribe(runId: string, after: number, listener?: (event: RunEvent) => void): RunSubscription {
    const active = this.active.get(runId);

    if (!active) {
      return { active: false, replay: [], unsubscribe: () => {} };
    }

    if (listener) {
      active.listeners.add(listener);
    }

    return {
      active: true,
      replay: active.events.filter((event) => event.seq > after),
      unsubscribe: () => {
        active.listeners.delete(listener ?? (() => {}));
      },
    };
  }

  cancel(runId: string): boolean {
    const active = this.active.get(runId);
    if (!active || active.finished) {
      return false;
    }

    active.cancelled = true;
    active.controller.abort();
    return true;
  }

  cancelAll(): void {
    for (const run of this.active.values()) {
      run.cancelled = true;
      run.controller.abort();
    }
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  private emit(active: ActiveRun, event: RunEventInput): RunEvent {
    const fullEvent = {
      ...event,
      seq: (active.seq += 1),
      runId: active.run.id,
    } as RunEvent;

    appendRunEvent(this.db, {
      runId: active.run.id,
      seq: fullEvent.seq,
      type: fullEvent.type,
      payloadJson: JSON.stringify(fullEvent),
    });

    active.events.push(fullEvent);
    for (const listener of active.listeners) {
      listener(fullEvent);
    }

    return fullEvent;
  }

  private finish(active: ActiveRun): void {
    active.finished = true;
    this.active.delete(active.run.id);
    active.listeners.clear();
  }

  private async execute(
    active: ActiveRun,
    profile: ProfileRecord,
    messages: ChatMessage[],
  ): Promise<void> {
    const { run } = active;
    const systemPrompt = profile.systemPrompt.trim();
    const chatMessages: ChatMessage[] = systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...messages]
      : messages;

    let text = "";
    let usage: Omit<Extract<RunEvent, { type: "usage" }>, "seq" | "runId"> | undefined;
    let providerError: string | undefined;
    let finishReason: "stop" | "tool_calls" | "length" | "error" | undefined;

    this.emit(active, {
      type: "run.started",
      conversationId: run.channelId,
      profileId: run.profileId,
      runner: "native",
    });

    try {
      for await (const event of this.getChatProvider().streamChat({
        model: run.model,
        messages: chatMessages,
        signal: active.controller.signal,
      })) {
        if (active.cancelled) {
          break;
        }

        if (event.type === "text.delta") {
          text += event.text;
          this.emit(active, { type: "message.delta", text: event.text });
        } else if (event.type === "tool_call") {
          this.emit(active, {
            type: "tool.requested",
            toolCallId: event.id,
            name: event.name,
            input: parseToolInput(event.argumentsJson),
          });
        } else if (event.type === "usage") {
          usage = {
            type: "usage",
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            totalTokens: event.totalTokens,
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
          };
          this.emit(active, usage);
        } else if (event.type === "error") {
          providerError = event.message;
        } else if (event.type === "finish") {
          finishReason = event.reason;
        }
      }
    } catch (error) {
      if (!active.cancelled) {
        providerError =
          error instanceof Error ? error.message : "Provider stream failed unexpectedly.";
      }
    }

    if (active.cancelled) {
      const message = createMessage(this.db, {
        channelId: run.channelId,
        role: "assistant",
        content: text,
        status: "cancelled",
        runId: run.id,
      });

      updateRun(this.db, run.id, {
        status: "cancelled",
        error: null,
        usage: usage ?? null,
        endedAt: Date.now(),
      });

      this.emit(active, {
        type: "run.cancelled",
        reason: "user",
      });
      this.logger.info({ runId: run.id, messageId: message.id }, "run cancelled");
      this.finish(active);
      return;
    }

    if (providerError || finishReason === "error") {
      const message = createMessage(this.db, {
        channelId: run.channelId,
        role: "assistant",
        content: text,
        status: "failed",
        runId: run.id,
      });

      updateRun(this.db, run.id, {
        status: "failed",
        error: providerError ?? "Provider stream failed.",
        usage: usage ?? null,
        endedAt: Date.now(),
      });

      this.emit(active, {
        type: "run.failed",
        error: providerError ?? "Provider stream failed.",
        code: "provider_error",
      });
      this.logger.error(
        { runId: run.id, messageId: message.id, error: providerError },
        "run failed",
      );
      this.finish(active);
      return;
    }

    const message = createMessage(this.db, {
      channelId: run.channelId,
      role: "assistant",
      content: text,
      status: "complete",
      runId: run.id,
    });

    updateRun(this.db, run.id, {
      status: "completed",
      error: null,
      usage: usage ?? null,
      endedAt: Date.now(),
    });

    this.emit(active, { type: "run.completed", messageId: message.id });
    this.logger.info({ runId: run.id, messageId: message.id }, "run completed");
    this.finish(active);
  }
}
