import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath, URL } from "node:url";
import process from "node:process";
import { setTimeout } from "node:timers/promises";

const apiRoot =
  process.env.VEKTOR_API_ROOT ?? fileURLToPath(new URL("../apps/api/", import.meta.url));
const load = (name) => import(pathToFileURL(resolve(apiRoot, `dist/${name}.js`)).href);
const [{ buildApp }, { loadConfig }, { bootstrapStorage }] = await Promise.all([
  load("app"),
  load("config"),
  load("bootstrap"),
]);
const directory = await mkdtemp(join(tmpdir(), "vektor-browser-packaged-"));
const token = "browser-packaged-fixture-access-token";
const headers = { authorization: `Bearer ${token}` };
let posts = 0;
const fixture = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  if (request.method === "POST") {
    posts++;
    request.resume();
    response.end("<h1>Submitted</h1>");
  } else
    response.end(
      '<h1>Packaged browser fixture</h1><form method="post" action="/submit"><input aria-label="Name" name="name"><button>Submit</button></form>',
    );
});
await new Promise((done) => fixture.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const provider = {
  async *streamChat(request) {
    const results = request.messages.filter((message) => message.role === "tool");
    let previous = {};
    try {
      previous = JSON.parse(results.at(-1)?.content ?? "{}");
    } catch {
      /* Denied tool results are text. */
    }
    const ref = (label) =>
      String(previous.snapshot)
        .split("\n")
        .find((line) => /^e\d+_\d+:/.test(line) && line.includes(label))
        ?.split(":")[0] ?? "expired";
    const input =
      results.length === 0
        ? { action: "navigate", url: origin }
        : results.length === 1
          ? { action: "fill", ref: ref("Name"), text: "Ada" }
          : results.length === 2
            ? { action: "click", ref: ref("Submit") }
            : null;
    if (input) {
      yield {
        type: "tool_call",
        id: `fixture-${results.length}`,
        name: "browser",
        argumentsJson: JSON.stringify(input),
      };
      yield { type: "finish", reason: "tool_calls" };
    } else {
      yield { type: "text.delta", text: "Browser fixture complete." };
      yield { type: "finish", reason: "stop" };
    }
  },
};
const config = loadConfig({
  NODE_ENV: "test",
  VEKTOR_DATA_DIR: directory,
  VEKTOR_ACCESS_TOKEN: token,
  VEKTOR_WEB_DIST: join(directory, "no-web"),
});
const app = await buildApp({
  config,
  storage: bootstrapStorage(config),
  provider,
  logger: false,
  startScheduler: false,
});
async function api(url, payload, method) {
  const response = await app.inject({
    url,
    headers,
    method: method ?? (payload === undefined ? "GET" : "POST"),
    ...(payload === undefined ? {} : { payload }),
  });
  assert.equal(response.statusCode < 300, true, `${url}: ${response.body}`);
  return response.json();
}
async function until(load, accept) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await load();
    if (accept(value)) return value;
    await setTimeout(50);
  }
  throw new Error("Packaged browser fixture timed out.");
}
try {
  const profile = (await api("/api/profiles")).profiles[0];
  const channel = (await api("/api/channels", { name: "Browser fixture", profileId: profile.id }))
    .channel;
  await api(
    `/api/profiles/${profile.id}`,
    { browser: { mode: "interactive", allowedOrigins: [], localOrigins: [origin] } },
    "PATCH",
  );
  const start = async () =>
    (await api(`/api/channels/${channel.id}/messages`, { content: "Controlled form fixture" })).run
      .id;
  const approval = async () =>
    (
      await until(
        () => api("/api/runtime"),
        (state) => state.approvals.length > 0,
      )
    ).approvals[0];
  const finished = (id) =>
    until(
      () => api(`/api/runs/${id}/details`),
      (details) => details.run.status !== "running",
    );
  const denied = await start();
  const deny = await approval();
  assert.equal(posts, 0);
  await api(`/api/approvals/${deny.id}`, { approved: false });
  await finished(denied);
  assert.equal(posts, 0);
  const accepted = await start();
  await api(`/api/approvals/${(await approval()).id}`, { approved: true });
  const write = await approval();
  assert.match(write.command, /network write/);
  assert.equal(posts, 0);
  await api(`/api/approvals/${write.id}`, { approved: true });
  assert.equal((await finished(accepted)).run.status, "completed");
  assert.equal(posts, 1);
  assert.ok((await api(`/api/runs/${accepted}/browser`)).artifacts.length > 0);
  const stopped = await start();
  await approval();
  await api("/api/runtime/emergency-stop", {});
  assert.equal((await api(`/api/runs/${stopped}/details`)).run.status, "cancelled");
  assert.equal((await api(`/api/runs/${stopped}/browser`)).session.active, false);
  assert.equal(posts, 1);
  await api("/api/runtime/resume", {});
  await api(
    `/api/profiles/${profile.id}`,
    { browser: { mode: "observe", localOrigins: [origin] } },
    "PATCH",
  );
  await finished(await start());
  assert.equal(posts, 1);
  process.stdout.write(
    "PASS: packaged Chromium form inspection/fill, denied submit, approved click/payload, screenshots, observation and emergency-stop cleanup\n",
  );
} finally {
  await app.close();
  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
  await rm(directory, { recursive: true, force: true });
}
