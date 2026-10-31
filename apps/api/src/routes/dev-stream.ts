import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { formatSseFrame, parseStreamCursor, SSE_HEARTBEAT, type RunEvent } from "@vektor/shared";
import type { StreamRegistry } from "../stream-registry.js";

const TOTAL_DELTAS = 20;
const HEARTBEAT_MS = 15_000;

function buildEvents(runId: string, after: number): RunEvent[] {
  const events: RunEvent[] = [
    {
      seq: 1,
      runId,
      type: "run.started",
      conversationId: null,
      profileId: null,
      runner: "native",
    },
  ];

  for (let index = 1; index <= TOTAL_DELTAS; index += 1) {
    events.push({
      seq: index + 1,
      runId,
      type: "message.delta",
      text: `token ${index} `,
    });
  }

  events.push({
    seq: TOTAL_DELTAS + 2,
    runId,
    type: "run.completed",
  });

  return events.filter((event) => event.seq > after);
}

export function registerDevStreamRoutes(
  app: FastifyInstance,
  delayMs: number,
  streams: StreamRegistry,
): void {
  app.get("/api/dev/stream", async (request, reply) => {
    const query = request.query as { after?: string };
    const lastEventId = request.headers["last-event-id"];
    const after = parseStreamCursor(typeof lastEventId === "string" ? lastEventId : query.after);
    const events = buildEvents("dev-run", after);
    const stream = new Readable({ read() {} });

    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (closed) {
        return;
      }

      closed = true;
      unregister();
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      stream.push(null);
    };

    const unregister = streams.register(cleanup);
    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);

    heartbeat = setInterval(() => {
      if (!closed) {
        stream.push(SSE_HEARTBEAT);
      }
    }, HEARTBEAT_MS);

    void (async () => {
      for (const event of events) {
        if (closed) {
          return;
        }

        stream.push(formatSseFrame(event));

        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      cleanup();
    })();

    return reply
      .type("text/event-stream; charset=utf-8")
      .header("Cache-Control", "no-cache, no-transform")
      .header("Connection", "keep-alive")
      .header("X-Accel-Buffering", "no")
      .send(stream);
  });
}
