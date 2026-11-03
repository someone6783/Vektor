import { useEffect, useRef, useState } from "react";
import type { SendMessageResponse, ReasoningEffort, RunnerId } from "@vektor/shared";
import { ApiError, type ApiClient } from "./api";

export interface QueuedMessage {
  id: string;
  channelId: string;
  content: string;
  attachmentIds: string[];
  allowTruncation: boolean;
  profileId?: string;
  model?: string;
  reasoning?: ReasoningEffort;
  runner?: RunnerId;
  resumeFromRunId?: string;
  mcpContextIds?: string[];
  error?: string;
  errorCode?: string;
  retry: number;
  steer?: boolean;
}
export function useMessageQueue(
  client: ApiClient | null,
  paused: boolean,
  onSent: (item: QueuedMessage, response: SendMessageResponse) => void,
) {
  const [items, setItems] = useState<QueuedMessage[]>([]);
  const [tick, setTick] = useState(0);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const processing = useRef(false);
  const nextId = useRef(0);
  const interrupted = useRef(new Set<string>());
  const callback = useRef(onSent);
  callback.current = onSent;
  const head = items[0];
  // Locking or changing the backend must not send queued work under a new session.
  useEffect(() => {
    setItems([]);
    interrupted.current.clear();
  }, [client]);
  useEffect(() => {
    if (!client || paused || !head || head.error || processing.current) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    processing.current = true;
    void (async () => {
      try {
        const page = await client.listMessages(head.channelId);
        if (!active) return;
        if (page.activeRun) {
          if (head.steer && !interrupted.current.has(head.id)) {
            setSendingId(head.id);
            await client.cancelRun(page.activeRun.id);
            interrupted.current.add(head.id);
          }
          timer = setTimeout(() => setTick((value) => value + 1), 750);
          return;
        }
        setSendingId(head.id);
        const response = await client.sendMessage(
          head.channelId,
          head.content,
          head.profileId,
          head.attachmentIds,
          head.allowTruncation,
          head.model,
          head.reasoning,
          head.runner,
          head.resumeFromRunId,
          ...(head.mcpContextIds?.length ? ([head.mcpContextIds] as [string[]]) : ([] as [])),
        );
        setItems((value) => value.filter((item) => item.id !== head.id));
        interrupted.current.delete(head.id);
        if (active) callback.current(head, response);
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiError && error.code === "run_active") {
          timer = setTimeout(() => setTick((value) => value + 1), 750);
        } else {
          setItems((value) =>
            value.map((item) =>
              item.id === head.id
                ? {
                    ...item,
                    error: error instanceof Error ? error.message : "Unable to send message.",
                    errorCode: error instanceof ApiError ? error.code : undefined,
                  }
                : item,
            ),
          );
        }
      } finally {
        setSendingId(null);
        processing.current = false;
        if (!active) setTick((value) => value + 1);
      }
    })();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, paused, head?.id, head?.retry, head?.error, head?.steer, tick]);
  return {
    items,
    sendingId,
    steer: (id: string) => {
      if (paused || sendingId) return;
      setItems((value) => {
        const selected = value.find((item) => item.id === id);
        if (!selected) return value;
        return [
          {
            ...selected,
            steer: true,
            error: undefined,
            errorCode: undefined,
            retry: selected.retry + 1,
          },
          ...value.filter((item) => item.id !== id),
        ];
      });
    },
    enqueue: (item: Omit<QueuedMessage, "id" | "retry">) => {
      // These identifiers are local UI keys, not server UUIDs. Build them before
      // updating state so browser capabilities cannot throw during React rendering.
      const queued = { ...item, id: `queued-${Date.now()}-${++nextId.current}`, retry: 0 };
      setItems((value) => [...value, queued]);
    },
    remove: (id: string) => setItems((value) => value.filter((item) => item.id !== id)),
    retry: (id: string, allowTruncation: boolean) =>
      setItems((value) =>
        value.map((item) =>
          item.id === id
            ? {
                ...item,
                error: undefined,
                errorCode: undefined,
                allowTruncation,
                retry: item.retry + 1,
              }
            : item,
        ),
      ),
  };
}
