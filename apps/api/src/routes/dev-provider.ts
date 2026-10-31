import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { SSE_HEARTBEAT } from "@vektor/shared";
import type { ProviderService } from "../providers/service.js";
import type { StreamRegistry } from "../stream-registry.js";

const HEARTBEAT_MS = 15_000;

export function registerDevProviderRoutes(
  app: FastifyInstance,
  providerService: ProviderService,
  streams: StreamRegistry,
): void {
  app.get("/api/dev/provider", async (request, reply) => {
    const query = request.query as { prompt?: string };
    const prompt = (query.prompt ?? "Say hello in five words.").slice(0, 500);
    const controller = new AbortController();
    const stream = new Readable({ read() {} });

    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (closed) {
        return;
      }

      closed = true;
      unregister();
      controller.abort();
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
      try {
        for await (const event of providerService.getChatProvider().streamChat({
          ...(!providerService.isConfigured()
            ? {
                tools: [
                  {
                    type: "function" as const,
                    function: {
                      name: "read_file",
                      description: "Synthetic development fixture; never executed.",
                      parameters: {},
                    },
                  },
                ],
              }
            : {}),
          model: providerService.getDefaultModel(),
          messages: [{ role: "user", content: prompt }],
          signal: controller.signal,
        })) {
          if (closed) {
            return;
          }

          stream.push(`event: provider.${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch (error) {
        if (!closed) {
          const message = error instanceof Error ? error.message : "Provider stream failed.";
          stream.push(
            `event: provider.error\ndata: ${JSON.stringify({ type: "error", message })}\n\n`,
          );
        }
      } finally {
        cleanup();
      }
    })();

    return reply
      .type("text/event-stream; charset=utf-8")
      .header("Cache-Control", "no-cache, no-transform")
      .header("Connection", "keep-alive")
      .header("X-Accel-Buffering", "no")
      .send(stream);
  });
}
