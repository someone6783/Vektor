import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export async function registerWebApp(app: FastifyInstance, webDistDir: string): Promise<boolean> {
  if (!existsSync(join(webDistDir, "index.html"))) {
    return false;
  }

  await app.register(fastifyStatic, {
    root: webDistDir,
    wildcard: false,
    index: false,
  });

  app.get("/*", async (request, reply) => {
    const wildcard = (request.params as Record<string, string | undefined>)["*"] ?? "";

    if (wildcard === "healthz" || wildcard.startsWith("api/") || wildcard.includes("..")) {
      return reply.callNotFound();
    }

    if (extname(wildcard)) {
      try {
        return await reply.sendFile(wildcard);
      } catch {
        return reply.callNotFound();
      }
    }

    return reply.sendFile("index.html");
  });

  return true;
}
