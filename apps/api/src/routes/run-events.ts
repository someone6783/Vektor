import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { getRun, listRunEvents, type VektorDatabase } from "@vektor/db";
import {
  formatSseFrame,
  makeApiError,
  parseStreamCursor,
  runEventSchema,
  SSE_HEARTBEAT,
  type RunEvent,
} from "@vektor/shared";
import type { RunManager } from "../runs/run-manager.js";
import type { StreamRegistry } from "../stream-registry.js";

const HEARTBEAT_MS = 15_000;
const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);

export function registerRunEventRoutes(
  app: FastifyInstance,
  db: VektorDatabase,
  runManager: RunManager,
  streams: StreamRegistry,
): void {
  app.get("/api/runs/:runId/events", async (request, reply) => {
    const { runId } = request.params as { runId: string };

    if (!getRun(db, runId)) {
      return reply
        .code(404)
        .send(makeApiError("not_found", "Run not found.", { requestId: request.id }));
    }

    const query = request.query as { after?: string };
    const lastEventId = request.headers["last-event-id"];
    const after = parseStreamCursor(typeof lastEventId === "string" ? lastEventId : query.after);
    const stream = new Readable({ read() {} });

    let closed = false;
    let lastSent = after;
    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe = () => {};
    let replaying = true;
    const buffered: RunEvent[] = [];

    function end(): void {
      if (closed) {
        return;
      }

      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      unsubscribe();
      unregisterStream();
      stream.push(null);
    }

    function send(event: RunEvent): void {
      if (closed || event.seq <= lastSent) {
        return;
      }

      lastSent = event.seq;
      stream.push(formatSseFrame(event));

      if (TERMINAL_EVENTS.has(event.type)) {
        end();
      }
    }

    const onLive = (event: RunEvent): void => {
      if (replaying) {
        buffered.push(event);
        return;
      }

      send(event);
    };

    const subscription = runManager.subscribe(runId, after, onLive);
    unsubscribe = subscription.unsubscribe;
    const unregisterStream = streams.register(end);

    request.raw.on("close", end);
    reply.raw.on("close", end);

    heartbeat = setInterval(() => {
      if (!closed) {
        stream.push(SSE_HEARTBEAT);
      }
    }, HEARTBEAT_MS);

    for (const event of subscription.replay) {
      send(event);
    }

    for (const record of listRunEvents(db, runId, after)) {
      try {
        send(runEventSchema.parse(JSON.parse(record.payloadJson)));
      } catch {
        request.log.warn({ runId, seq: record.seq }, "skipping malformed run event");
      }
    }

    replaying = false;
    for (const event of buffered) {
      send(event);
    }
    buffered.length = 0;

    if (!subscription.active) {
      end();
    }

    return reply
      .type("text/event-stream; charset=utf-8")
      .header("Cache-Control", "no-cache, no-transform")
      .header("Connection", "keep-alive")
      .header("X-Accel-Buffering", "no")
      .send(stream);
  });
}
