import type { FastifyInstance } from "fastify";
import { makeApiError, sshConnectionInputObjectSchema, sshSecretSchema } from "@vektor/shared";
import type { SshService } from "../ssh/service.js";

export function registerSshRoutes(app: FastifyInstance, ssh: SshService): void {
  app.get("/api/ssh", async () => ssh.setup());

  app.post("/api/ssh", async (request) => {
    const input = sshConnectionInputObjectSchema.parse(request.body);
    const connection = ssh.create(input);
    return { connection };
  });

  app.put("/api/ssh/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = sshConnectionInputObjectSchema.partial().parse(request.body);
    const connection = ssh.update(id, input);
    return { connection };
  });

  app.delete("/api/ssh/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    ssh.remove(id);
    return reply.code(204).send();
  });

  // Write-only: credentials never round-trip to the client.
  app.put("/api/ssh/:id/credentials", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { password, passphrase } = sshSecretSchema.parse(request.body);
    try {
      ssh.credentials(id, { password, passphrase });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not store SSH credentials.";
      return reply
        .code(400)
        .send(makeApiError("ssh_credentials_error", message, { requestId: request.id }));
    }
    return reply.code(204).send();
  });

  app.post("/api/ssh/:id/test", async (request) => {
    const { id } = request.params as { id: string };
    return await ssh.test(id);
  });
}
