// Production frontend + real API browser journey. Uses disposable data and a
// deterministic local provider; no account credentials or paid inference.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
const root = fileURLToPath(new URL("../", import.meta.url));
const apiRoot = process.env.VEKTOR_API_ROOT ?? resolve(root, "apps/api");
const load = (name) => import(pathToFileURL(resolve(apiRoot, `dist/${name}.js`)).href);
const [{ buildApp }, { loadConfig }, { bootstrapStorage }] = await Promise.all([
  load("app"),
  load("config"),
  load("bootstrap"),
]);
const { chromium } = createRequire(resolve(apiRoot, "package.json"))("playwright");
const directory = await mkdtemp(join(tmpdir(), "vektor-workspace-smoke-"));
const token = "workspace-smoke-synthetic-access-token";
const config = loadConfig({
  NODE_ENV: "test",
  VEKTOR_DATA_DIR: directory,
  VEKTOR_ACCESS_TOKEN: token,
  VEKTOR_WEB_DIST: process.env.VEKTOR_WEB_DIST ?? resolve(root, "apps/web/dist"),
  VEKTOR_UPDATE_CHECK: "0",
  VEKTOR_SCHEDULER_ENABLED: "1",
});
const { StubChatProvider } = await load("providers/stub");
const stub = new StubChatProvider();
let slowTurnStarted = false;
const provider = {
  kind: "stub",
  async *streamChat(request) {
    const prompt = String(
      request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "",
    );
    if (prompt.includes("Cancel this controlled task") && !slowTurnStarted) {
      slowTurnStarted = true;
      yield { type: "text.delta", text: "Controlled cancellation.\n\n" };
      for (let i = 0; i < 100; i++) {
        if (request.signal?.aborted) return;
        await setTimeout(100);
      }
      yield { type: "finish", reason: "stop" };
    } else yield* stub.streamChat(request);
  },
};
const app = await buildApp({
  config,
  storage: bootstrapStorage(config),
  logger: false,
  startScheduler: false,
  provider,
});
let browser;
const pageErrors = [];
const checks = [];
const api = async (path, body, method) => {
  const response = await app.inject({
    method: method ?? (body === undefined ? "GET" : "POST"),
    url: path,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body }),
  });
  assert.ok(response.statusCode < 300, `${path}: ${response.statusCode} ${response.body}`);
  return response.json();
};
const until = async (get, accept) => {
  for (let i = 0; i < 150; i++) {
    const value = await get();
    if (accept(value)) return value;
    await setTimeout(100);
  }
  throw new Error("Workspace journey condition did not become ready.");
};
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(base);
  await page.getByText("Advanced: access token", { exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).count(), 0);
  checks.push("unauthenticated workspace stays locked");
  await page.evaluate(() =>
    globalThis.localStorage.setItem("vektor.accessToken", "obsolete-synthetic-token"),
  );
  const signIn = async () => {
    const { code } = await api("/api/session-link", {});
    await page.goto(`${base}/?signin=1#setup=${code}`);
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, "");
    assert.equal(new URL(page.url()).search, "");
    assert.equal(
      (await context.cookies()).find((cookie) => cookie.name === "vektor_session")?.httpOnly,
      true,
    );
  };
  await signIn();
  checks.push("automatic sign-in supersedes stale credentials and scrubs the URL");
  const toggle = page.getByRole("button", { name: "Toggle conversations" });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByTitle("New channel", { exact: true }).click();
  await page.getByPlaceholder("research", { exact: true }).fill("Regression room");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("heading", { name: /Regression room/ }).waitFor();
  const channel = (await api("/api/channels")).channels.find(
    (item) => item.name === "Regression room",
  );
  assert.ok(channel);
  checks.push("create and select a channel");
  await page.getByLabel("Upload attachments").setInputFiles({
    name: "regression.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("A controlled regression attachment."),
  });
  const included = page.getByRole("checkbox", { name: "Include regression.txt in context" });
  await included.waitFor();
  await included.click();
  await until(
    () => included.isChecked(),
    (checked) => !checked,
  );
  await until(
    () => api(`/api/channels/${channel.id}/attachments`),
    (data) => data.attachments[0]?.included === false,
  );
  await included.click();
  await until(
    () => included.isChecked(),
    (checked) => checked,
  );
  await page.getByLabel("Actions for regression.txt", { exact: true }).click();
  await page.getByRole("button", { name: "Preview regression.txt", exact: true }).click();
  await page.getByText("A controlled regression attachment.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close preview" }).click();
  checks.push("upload, include/exclude and preview an attachment");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Exercise the full production workspace.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await until(
    () => api(`/api/channels/${channel.id}/messages`),
    (data) => data.messages.some((message) => message.role === "assistant") && !data.activeRun,
  );
  await page
    .getByRole("log", { name: "Conversation" })
    .getByText("streamed", { exact: true })
    .waitFor();
  checks.push("stream a reply, render Markdown and persist history");
  await page.reload();
  await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  await page
    .getByRole("log", { name: "Conversation" })
    .getByText("streamed", { exact: true })
    .waitFor();
  checks.push("reload preserves sign-in, channel and conversation");
  await page.getByRole("button", { name: "Terminal settings", exact: true }).click();
  await page.getByLabel("Terminal access", { exact: true }).selectOption("basic");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  assert.equal(
    (await api("/api/channels")).channels.find((item) => item.id === channel.id).execution
      .terminalMode,
    "basic",
  );
  await page.getByRole("button", { name: "Browser settings", exact: true }).click();
  await page.getByRole("combobox", { name: /Browser access/ }).selectOption("observe");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  assert.equal(
    (await api("/api/channels")).channels.find((item) => item.id === channel.id).execution.browser
      .mode,
    "observe",
  );
  checks.push("conversation terminal and browser permissions persist");
  const navigate = async (name) => {
    const back = page.getByRole("button", { name: "Back to chat", exact: true });
    if (await back.isVisible()) await back.click();
    await page.getByLabel("Workspace actions", { exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
  };
  await navigate("Settings");
  await page.getByRole("heading", { name: "Providers, models, and profiles" }).waitFor();
  for (const heading of ["Agent runner setup", "MCP plugins", "About Vektor", "Usage and costs"])
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Stream replies by paragraph" }).check();
  const newProfile = page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: "New profile", exact: true }) })
    .last();
  await newProfile.getByPlaceholder("Name", { exact: true }).fill("Regression profile");
  await newProfile.getByPlaceholder("Model", { exact: true }).fill("stub/model");
  await newProfile.getByRole("button", { name: "Create", exact: true }).click();
  await until(
    () => api("/api/profiles"),
    (data) => data.profiles.some((profile) => profile.name === "Regression profile"),
  );
  checks.push("settings, profile creation, runner/MCP/about panels and usage load");
  await navigate("Schedules");
  await page.getByRole("button", { name: "New job", exact: true }).click();
  await page.getByLabel("Job name", { exact: true }).fill("Regression scheduled job");
  await page.getByLabel("Schedule", { exact: true }).fill("daily at 9am");
  await page.getByLabel("Time zone", { exact: true }).fill("Australia/Perth");
  await page.getByLabel("Delivery channel", { exact: true }).selectOption(channel.id);
  await page.getByLabel("Job prompt", { exact: true }).fill("Run this controlled recurring task.");
  await page.getByRole("button", { name: "Save job", exact: true }).click();
  await page.getByRole("heading", { name: "Regression scheduled job", exact: true }).waitFor();
  await page.getByRole("button", { name: "Run now", exact: true }).click();
  await until(
    () => api("/api/jobs"),
    (data) =>
      data.jobs.find((job) => job.name === "Regression scheduled job")?.lastStatus === "completed",
  );
  await page.getByRole("button", { name: "Pause job", exact: true }).click();
  await page.getByRole("button", { name: "Resume job", exact: true }).waitFor();
  checks.push("create, manually run and pause a recurring job");
  await navigate("Audit log");
  await page.getByRole("heading", { name: "Audit log", exact: true, level: 1 }).waitFor();
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await page.getByRole("button", { name: "Emergency stop", exact: true }).click();
  await until(
    () => api("/api/runtime"),
    (state) => state.emergencyStopped === true,
  );
  await api("/api/runtime/resume", {});
  checks.push("audit view and emergency-stop latch");
  await navigate("Lock workspace");
  await page.getByText("Advanced: access token", { exact: true }).waitFor();
  await until(
    () => context.request.get(`${base}/api/session`),
    (response) => response.status() === 401,
  );
  assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).count(), 0);
  await signIn();
  checks.push("locking stays locked and a fresh sign-in link restores access");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle conversations" }).click();
  await page.getByTitle("New direct conversation", { exact: true }).click();
  const dm = await until(
    () => api("/api/channels"),
    (data) => data.channels.some((item) => item.kind === "dm"),
  );
  const direct = dm.channels.find((item) => item.kind === "dm");
  const sidebar = page.getByRole("button", { name: "Toggle conversations" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await page.getByRole("heading", { name: /New conversation 1/ }).waitFor();
  assert.equal((await api(`/api/channels/${direct.id}/attachments`)).attachments.length, 0);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Cancel this controlled task");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByRole("log", { name: "Conversation" })
    .getByText("Controlled cancellation.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await until(
    () => api(`/api/channels/${direct.id}/messages`),
    (data) => data.lastRun?.status === "cancelled",
  );
  await page.getByLabel("Message actions", { exact: true }).click();
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await until(
    () => api(`/api/channels/${direct.id}/messages`),
    (data) => data.lastRun?.status === "completed",
  );
  checks.push("mobile navigation, isolated direct conversation, stop and regenerate");
  assert.deepEqual(pageErrors, [], "Browser must not raise uncaught application errors");
  process.stdout.write(JSON.stringify({ status: "passed", checks }, null, 2) + "\n");
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      status: "failed",
      completedChecks: checks,
      browserErrors: pageErrors,
      message: error.message,
    }) + "\n",
  );
  throw error;
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
