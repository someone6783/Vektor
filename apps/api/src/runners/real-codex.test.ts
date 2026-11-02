import { CodexSession } from "./protocol.js";
import type { RpcMessage } from "./rpc.js";
import { createServer } from "node:https";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { bootstrapStorage } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { listApprovals, getRun, listMessages, listToolCalls } from "@vektor/db";
import { InferenceProxy, isolatedRunner } from "./isolation.js";
import { fakeMcp } from "../mcp/fixtures.test-utils.js";
import { toolName } from "../mcp/store.js";

it.skipIf(!process.env.VEKTOR_CODEX_PROBE_BIN).each([false, true])(
  "runs the real Codex harness through TLS model fixtures, approval and resume (MCP=%s)",
  async (useMcp) => {
    const errors: unknown[] = [];
    const prototype = CodexSession.prototype as unknown as {
      notification: (message: RpcMessage) => void;
    };
    const original = prototype.notification;
    const diagnostic = vi.spyOn(prototype, "notification").mockImplementation(function (
      this: CodexSession,
      message,
    ) {
      if (message.method === "error") errors.push(message.params);
      original.call(this, message);
    });
    const directory = mkdtempSync(join(tmpdir(), "vektor-real-codex-"));
    const certificate = join(directory, "ca.pem");
    const key = join(directory, "ca.key");
    const openssl = spawnSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        certificate,
        "-days",
        "1",
        "-subj",
        "/CN=api.openai.com",
        "-addext",
        "subjectAltName=DNS:api.openai.com",
      ],
      { stdio: "ignore" },
    );
    expect(openssl.status).toBe(0);
    const leafKey = join(directory, "server.key");
    const leafCert = join(directory, "server.pem");
    const csr = join(directory, "server.csr");
    const extensions = join(directory, "extensions.cnf");
    writeFileSync(
      extensions,
      "subjectAltName=DNS:api.openai.com\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n",
    );
    expect(
      spawnSync(
        "/usr/bin/openssl",
        [
          "req",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          leafKey,
          "-out",
          csr,
          "-subj",
          "/CN=api.openai.com",
        ],
        { stdio: "ignore" },
      ).status,
    ).toBe(0);
    expect(
      spawnSync(
        "/usr/bin/openssl",
        [
          "x509",
          "-req",
          "-in",
          csr,
          "-CA",
          certificate,
          "-CAkey",
          key,
          "-CAcreateserial",
          "-out",
          leafCert,
          "-days",
          "1",
          "-extfile",
          extensions,
        ],
        { stdio: "ignore" },
      ).status,
    ).toBe(0);

    let requests = 0;
    let proxyConnections = 0;
    const tlsErrors: string[] = [];
    let toolManifest = "";
    let mcpName = "";
    const model = createServer(
      { key: readFileSync(leafKey), cert: readFileSync(leafCert) },
      async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools?: unknown[] };
        if (requests === 0) toolManifest = JSON.stringify(input);
        requests++;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const emit = (type: string, fields: Record<string, unknown>) =>
          response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        const responseId = `response-${requests}`;
        emit("response.created", {
          response: {
            id: responseId,
            object: "response",
            created_at: 1,
            status: "in_progress",
            output: [],
          },
        });
        let item: Record<string, unknown>;
        if (requests === 1) {
          const args = JSON.stringify(
            useMcp
              ? { text: "Real Codex MCP task confirmed" }
              : {
                  path: "real-codex.txt",
                  content: "Written through the real Codex harness",
                },
          );
          item = {
            id: "function-item",
            type: "function_call",
            call_id: "write-real-file",
            name: useMcp ? mcpName : "vektor_write_file",
            arguments: args,
            status: "completed",
          };
          emit("response.output_item.added", {
            output_index: 0,
            item: { ...item, arguments: "", status: "in_progress" },
          });
          emit("response.function_call_arguments.delta", {
            output_index: 0,
            item_id: item.id,
            delta: args,
          });
          emit("response.function_call_arguments.done", {
            output_index: 0,
            item_id: item.id,
            arguments: args,
          });
        } else {
          const text =
            requests === 2
              ? "The approved file was written."
              : "The saved session resumed without replaying its write.";
          item = {
            id: `message-${requests}`,
            type: "message",
            role: "assistant",
            phase: "final_answer",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          };
          emit("response.output_item.added", {
            output_index: 0,
            item: { ...item, content: [], status: "in_progress" },
          });
          emit("response.content_part.added", {
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            part: { type: "output_text", text: "", annotations: [] },
          });
          emit("response.output_text.delta", {
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            delta: text,
          });
          emit("response.output_text.done", {
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            text,
          });
        }
        emit("response.output_item.done", { output_index: 0, item });
        emit("response.completed", {
          response: {
            id: responseId,
            object: "response",
            created_at: 1,
            status: "completed",
            model: "gpt-6.1-sol",
            output: [item],
            usage: {
              input_tokens: 20,
              output_tokens: 10,
              total_tokens: 30,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        });
        response.end();
      },
    );
    model.on("tlsClientError", (error) => tlsErrors.push(error.message));
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const port = (model.address() as { port: number }).port;
    class ModelFixtureProxy extends InferenceProxy {
      protected override async destination() {
        proxyConnections++;
        return { address: "127.0.0.1", family: 4, port };
      }
    }
    const config = loadConfig({
      NODE_ENV: "test",
      VEKTOR_DATA_DIR: directory,
      VEKTOR_ACCESS_TOKEN: "real-codex-test-access-token",
      VEKTOR_WEB_DIST: join(directory, "missing-web"),
    });
    const storage = bootstrapStorage(config);
    const app = await buildApp({
      config,
      storage,
      logger: false,
      startScheduler: false,
      runnerIsolation: (options) =>
        isolatedRunner({
          ...options,
          caCertificate: certificate,
          proxy: new ModelFixtureProxy(options.hosts, options.signal),
        }),
    });
    const headers = { authorization: "Bearer real-codex-test-access-token" };
    async function api(url: string, payload?: unknown, method?: "PUT" | "PATCH") {
      const response = await app.inject({
        method: method ?? (payload === undefined ? "GET" : "POST"),
        url,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, response.payload).toBeLessThan(400);
      return response.json();
    }
    try {
      const profileId = (await api("/api/profiles")).profiles[0].id;
      const probe = await api("/api/runners/probe", {
        interface: "codex-app-server",
        command: process.env.VEKTOR_CODEX_PROBE_BIN,
      });
      await api("/api/runners/installations", {
        id: "codex",
        executableHash: probe.executableHash,
        trustLocalCodex: true,
        inferenceHosts: ["api.openai.com"],
        credentialName: "OPENAI_API_KEY",
      });
      await api(
        "/api/runners/installations/codex/credential",
        { key: "dummy-test-key-not-a-real-openai-key" },
        "PUT",
      );
      await api("/api/runners/installations/codex", { enabled: true }, "PATCH");
      if (useMcp) {
        const command = join(directory, "mcp-fixture");
        writeFileSync(command, fakeMcp, { mode: 0o700 });
        const server = (
          await api("/api/mcp/servers", {
            name: "Real Codex MCP",
            transport: "stdio",
            command,
            hostBinaryAcknowledged: true,
          })
        ).server;
        await api(`/api/mcp/servers/${server.id}/test`, {});
        await api(`/api/mcp/servers/${server.id}`, { enabled: true }, "PATCH");
        await api(
          `/api/mcp/profiles/${profileId}/servers/${server.id}`,
          { tools: [{ name: "echo", policy: "read-only" }], externalRunners: true },
          "PUT",
        );
        mcpName = toolName(server.id, "echo");
      }
      await api(
        `/api/profiles/${profileId}/runner-grant`,
        { runner: "codex", workspace: true, inference: true },
        "PUT",
      );
      await api(
        `/api/profiles/${profileId}`,
        { runner: "codex", model: "gpt-6.1-sol", terminalMode: "full-access", tools: ["terminal"] },
        "PATCH",
      );
      const channelId = (await api("/api/channels", { name: "Real Codex", profileId })).channel.id;
      const runId = (
        await api(`/api/channels/${channelId}/messages`, {
          content: "Write a reviewed file using the Vektor tool.",
        })
      ).run.id as string;
      await vi.waitFor(
        () => {
          const run = getRun(storage.db, runId);
          expect(
            run?.status,
            `${run?.error ?? "No approval"} ${JSON.stringify(errors)} proxy=${proxyConnections} requests=${requests} tls=${JSON.stringify(tlsErrors)}`,
          ).toBe("running");
          expect(
            listApprovals(storage.db, runId).filter((item) => item.status === "pending"),
          ).toHaveLength(1);
        },
        { timeout: 15_000 },
      );
      const approval = listApprovals(storage.db, runId)[0]!;
      await api(`/api/approvals/${approval.id}`, { approved: true });
      await vi.waitFor(
        () =>
          expect(
            getRun(storage.db, runId)?.status,
            getRun(storage.db, runId)?.error ?? "Still running",
          ).toBe("completed"),
        { timeout: 15_000 },
      );
      if (useMcp) {
        expect(listToolCalls(storage.db, runId).find((t) => t.name === mcpName)?.output).toContain(
          "Real Codex MCP task confirmed",
        );
        expect(toolManifest).toContain(mcpName);
      } else
        expect(readFileSync(join(directory, "workspace/real-codex.txt"), "utf8")).toBe(
          "Written through the real Codex harness",
        );
      expect(requests).toBe(2);
      expect(toolManifest).toContain("vektor_write_file");
      expect(toolManifest).not.toMatch(
        /"name":"(?:exec_command|write_stdin|shell|shell_command|terminal)"/,
      );
      const resumed = (
        await api(`/api/channels/${channelId}/messages`, {
          content: "Confirm the existing saved session.",
          resumeFromRunId: runId,
        })
      ).run.id as string;
      await vi.waitFor(
        () =>
          expect(
            getRun(storage.db, resumed)?.status,
            getRun(storage.db, resumed)?.error ?? "Still running",
          ).toBe("completed"),
        { timeout: 15_000 },
      );
      expect(requests).toBe(3);
      expect(getRun(storage.db, resumed)?.usage).toMatchObject({
        promptTokens: 20,
        completionTokens: 10,
        totalTokens: 30,
      });
      expect(
        listToolCalls(storage.db, resumed).filter(
          (tool) => tool.name === "workspace_write" || tool.name.startsWith("vektor_mcp_"),
        ),
      ).toHaveLength(0);
      expect(
        listMessages(storage.db, channelId).messages.some(
          (message) =>
            message.runId === resumed && message.content.includes("resumed without replaying"),
        ),
      ).toBe(true);
    } finally {
      diagnostic.mockRestore();
      await app.close();
      model.closeAllConnections();
      await new Promise<void>((resolve) => model.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
