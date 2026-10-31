import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMessage, getRun, listMessages, setSetting } from "@vektor/db";
import { buildApp } from "../app.js";
import { bootstrapStorage, type Storage } from "../bootstrap.js";
import { loadConfig, type AppConfig } from "../config.js";
import type { ChatProvider, ChatRequest } from "../providers/types.js";
import { PNG, pdfFixture } from "./fixtures.test-utils.js";

const headers = { authorization: "Bearer attachment-test-token" };
let app: FastifyInstance;
let config: AppConfig;
let storage: Storage;
let dataDir: string;
let channelId: string;
let profileId: string;
let requests: ChatRequest[];
const provider: ChatProvider = {
  async *streamChat(request) {
    requests.push(request);
    yield { type: "text.delta", text: "Context received." };
    yield { type: "usage", promptTokens: 20, completionTokens: 3, totalTokens: 23 };
    yield { type: "finish", reason: "stop" };
  },
};

async function open() {
  storage = bootstrapStorage(config);
  app = await buildApp({ config, storage, logger: false, provider });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "vektor-attachments-"));
  config = loadConfig({
    NODE_ENV: "test",
    VEKTOR_DATA_DIR: dataDir,
    VEKTOR_ACCESS_TOKEN: "attachment-test-token",
    VEKTOR_WEB_DIST: join(dataDir, "no-web"),
  });
  requests = [];
  await open();
  profileId = (await app.inject({ method: "GET", url: "/api/profiles", headers })).json()
    .profiles[0].id;
  channelId = (
    await app.inject({
      method: "POST",
      url: "/api/channels",
      headers,
      payload: { name: "Files", profileId },
    })
  ).json().channel.id;
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function upload(filename: string, contents: Buffer | string, channel = channelId) {
  const boundary = "vektor-test-boundary";
  return app.inject({
    method: "POST",
    url: `/api/channels/${channel}/attachments`,
    headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(contents),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}

async function estimate(content = "Summarize", attachmentIds?: string[]) {
  return app.inject({
    method: "POST",
    url: `/api/channels/${channelId}/context`,
    headers,
    payload: { content, attachmentIds },
  });
}

async function send(payload: object) {
  return app.inject({
    method: "POST",
    url: `/api/channels/${channelId}/messages`,
    headers,
    payload,
  });
}

describe("files and context API", () => {
  it("supports attachment-only messages but rejects empty messages without files", async () => {
    expect((await send({ content: "" })).statusCode).toBe(400);
    await upload("notes.txt", "Read this file without a typed prompt.");
    expect((await send({ content: "" })).statusCode).toBe(201);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Read this file");
  });

  it("discloses the history cap and requires consent before omitting old turns", async () => {
    for (let index = 0; index < 101; index++)
      createMessage(storage.db, { channelId, role: "user", content: `History ${index}` });
    const result = (await estimate()).json();
    expect(result).toMatchObject({ requiresTruncation: true, droppedMessages: 1 });
    expect((await send({ content: "New question" })).statusCode).toBe(409);
    expect((await send({ content: "New question", allowTruncation: true })).statusCode).toBe(201);
    expect(requests.at(-1)?.messages.find((message) => message.role === "user")?.content).toBe(
      "History 1",
    );
  });
  it("stores private files and persists files, inclusion, links and context after restart", async () => {
    const uploadResponse = await upload("notes.md", "Durable attachment contents.");
    expect(uploadResponse.statusCode).toBe(201);
    const file = uploadResponse.json().attachment;
    expect(file).not.toHaveProperty("path");
    expect(statSync(join(dataDir, "files", file.id)).mode & 0o777).toBe(0o600);
    expect(
      (await app.inject({ method: "GET", url: `/api/attachments/${file.id}/content` })).statusCode,
    ).toBe(401);
    const content = await app.inject({
      method: "GET",
      url: `/api/attachments/${file.id}/content`,
      headers,
    });
    expect(content.payload).toBe("Durable attachment contents.");
    expect(content.headers["x-content-type-options"]).toBe("nosniff");
    const preview = (await estimate()).json();
    const response = await send({ content: "Summarize" });
    expect(response.statusCode).toBe(201);
    const { run, message } = response.json();
    expect(run.context).toEqual(preview);
    expect(message.attachments.map((item: { id: string }) => item.id)).toEqual([file.id]);
    await app.inject({ method: "GET", url: `/api/runs/${run.id}/events`, headers });
    await app.inject({
      method: "PATCH",
      url: `/api/attachments/${file.id}`,
      headers,
      payload: { included: false },
    });
    await app.close();
    await open();
    const listed = (
      await app.inject({ method: "GET", url: `/api/channels/${channelId}/attachments`, headers })
    ).json();
    expect(listed.attachments[0]).toMatchObject({ id: file.id, included: false });
    const page = (
      await app.inject({ method: "GET", url: `/api/channels/${channelId}/messages`, headers })
    ).json();
    expect(
      page.messages.find((item: { id: string }) => item.id === message.id).attachments[0].id,
    ).toBe(file.id);
    expect(page.lastRun.context).toEqual(preview);
    expect(page.lastRun.usage.promptTokens).toBe(20);
    expect((await estimate()).json().selectedAttachments).toBe(0);
  });

  it("attaches a PDF and image, previews both, and sends only included context", async () => {
    const pdfResponse = await upload("report.pdf", pdfFixture());
    expect(pdfResponse.statusCode, pdfResponse.payload).toBe(201);
    const pdf = pdfResponse.json().attachment;
    const image = (await upload("pixel.png", PNG)).json().attachment;
    expect(pdf.textPreview).toContain("PDF context sample");
    expect(image).toMatchObject({ kind: "image", width: 1, height: 1 });
    expect(
      (await app.inject({ method: "GET", url: `/api/attachments/${image.id}/content`, headers }))
        .rawPayload,
    ).toEqual(PNG);
    const both = (await estimate()).json();
    await app.inject({
      method: "PATCH",
      url: `/api/attachments/${image.id}`,
      headers,
      payload: { included: false },
    });
    const one = (await estimate()).json();
    expect(one.selectedAttachments).toBe(1);
    expect(both.inputTokens - one.inputTokens).toBe(4096);
    const response = await send({ content: "Summarize" });
    expect(response.statusCode).toBe(201);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("PDF context sample");
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("data:image");
    expect(response.json().run.context.inputTokens).toBe(one.inputTokens);
    const next = await send({ content: "Describe image", attachmentIds: [image.id] });
    expect(next.statusCode).toBe(201);
    const request = requests.at(-1)!;
    expect(JSON.stringify(request.messages)).toContain(
      `data:image/png;base64,${PNG.toString("base64")}`,
    );
    expect(JSON.stringify(request.messages)).not.toContain("PDF context sample");
    expect(request.maxTokens).toBe(2048);
  }, 20_000);

  it("rejects cross-channel attachment IDs and incompatible image models before writing a message", async () => {
    const file = (await upload("pixel.png", PNG)).json().attachment;
    const other = (
      await app.inject({
        method: "POST",
        url: "/api/channels",
        headers,
        payload: { name: "Other" },
      })
    ).json().channel;
    const invalid = await app.inject({
      method: "POST",
      url: `/api/channels/${other.id}/messages`,
      headers,
      payload: { content: "read", attachmentIds: [file.id] },
    });
    expect(invalid.statusCode).toBe(400);
    setSetting(storage.db, "provider.openrouter.models", {
      fetchedAt: Date.now(),
      models: [
        { id: "openrouter/auto", name: "Text only", contextLength: 8192, supportsImages: false },
      ],
    });
    expect((await send({ content: "Describe" })).statusCode).toBe(400);
    expect(listMessages(storage.db, channelId).messages).toHaveLength(0);
  });

  it("requires truncation confirmation and never silently cuts prompt or files", async () => {
    setSetting(storage.db, "provider.openrouter.models", {
      fetchedAt: Date.now(),
      models: [{ id: "openrouter/auto", name: "Small", contextLength: 2200 }],
    });
    createMessage(storage.db, { channelId, role: "user", content: "old history ".repeat(200) });
    const preview = (await estimate("New question")).json();
    expect(preview).toMatchObject({
      requiresTruncation: true,
      exceedsBudget: false,
      droppedMessages: 1,
      windowSource: "model",
    });
    expect((await send({ content: "New question" })).statusCode).toBe(409);
    expect(listMessages(storage.db, channelId).messages).toHaveLength(1);
    const response = await send({ content: "New question", allowTruncation: true });
    expect(response.statusCode).toBe(201);
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("old history");
    await upload("large.txt", "large attachment ".repeat(300));
    expect((await estimate()).json().exceedsBudget).toBe(true);
    expect((await send({ content: "New question", allowTruncation: true })).statusCode).toBe(413);
  });

  it("retries only the original turn and respects subsequently excluded files", async () => {
    const file = (await upload("secret.txt", "Excluded content marker")).json().attachment;
    const first = (await send({ content: "First question" })).json();
    await send({ content: "Later question" });
    await app.inject({
      method: "PATCH",
      url: `/api/attachments/${file.id}`,
      headers,
      payload: { included: false },
    });
    const retry = await app.inject({
      method: "POST",
      url: `/api/runs/${first.run.id}/retry`,
      headers,
    });
    expect(retry.statusCode, retry.payload).toBe(201);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("First question");
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("Later question");
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("Excluded content marker");
    expect(getRun(storage.db, retry.json().run.id)?.context).toMatchObject({
      selectedAttachments: 0,
    });
  });

  it("enforces size and channel quotas, rejects unsupported types, and cleans up removal", async () => {
    expect((await upload("payload.svg", "<svg/>")).statusCode).toBe(415);
    expect((await upload("binary.txt", Buffer.from([0, 1, 2]))).statusCode).toBe(400);
    expect(readdirSync(join(dataDir, "files"))).toHaveLength(0);
    await app.close();
    config.maxFileBytes = 20;
    config.channelFileBytes = 25;
    await open();
    expect((await upload("large.txt", "x".repeat(21))).statusCode).toBe(413);
    const accepted = await upload("notes.txt", "x".repeat(20));
    expect(accepted.statusCode).toBe(201);
    expect((await upload("more.txt", "x".repeat(6))).statusCode).toBe(413);
    expect(readdirSync(join(dataDir, "files"))).toHaveLength(1);
    const file = accepted.json().attachment;
    expect(
      (await app.inject({ method: "DELETE", url: `/api/attachments/${file.id}`, headers }))
        .statusCode,
    ).toBe(204);
    expect(readdirSync(join(dataDir, "files"))).toHaveLength(0);
    expect(
      (await app.inject({ method: "GET", url: `/api/attachments/${file.id}/content`, headers }))
        .statusCode,
    ).toBe(404);
  });
});
