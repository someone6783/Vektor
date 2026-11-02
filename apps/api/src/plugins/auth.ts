import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { BrowserSessions } from "./sessions.js";
import { makeApiError } from "@vektor/shared";

function tokenMatches(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readBearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }

  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value : undefined;
}

export function registerAuth(
  app: FastifyInstance,
  accessToken: string,
  sessions?: BrowserSessions,
): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";

    if (path === "/healthz" || !path.startsWith("/api/")) {
      return;
    }

    const provided = readBearerToken(request.headers.authorization);

    if (provided ? !tokenMatches(provided, accessToken) : !sessions?.authenticated(request)) {
      return reply.code(401).send(
        makeApiError("unauthorized", "A valid access token is required.", {
          requestId: request.id,
        }),
      );
    }
  });
}
