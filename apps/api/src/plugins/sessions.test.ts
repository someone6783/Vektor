import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerAuth } from "./auth.js";
import { BrowserSessions } from "./sessions.js";
const token = "synthetic-session-test-access-token";
const origin = "http://localhost:8788";
const headers = { host: "localhost:8788", origin, "sec-fetch-site": "same-origin" };
const apps: ReturnType<typeof Fastify>[] = [];
function create(sessions = new BrowserSessions(token)) {
  const app = Fastify();
  apps.push(app);
  registerAuth(app, token, sessions);
  sessions.register(app);
  app.post("/api/test", async () => ({ ok: true }));
  return { app, sessions };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
describe("automatic browser sign-in", () => {
  it("requires existing authentication to mint links; exchanges them once for an HttpOnly cookie", async () => {
    const { app } = create();
    expect((await app.inject({ method: "POST", url: "/api/session-link" })).statusCode).toBe(401);
    const link = await app.inject({
      method: "POST",
      url: "/api/session-link",
      headers: { authorization: `Bearer ${token}` },
    });
    const { code } = link.json<{ code: string }>();
    const signedIn = await app.inject({
      method: "POST",
      url: "/auth/session",
      headers,
      payload: { code },
    });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.headers["set-cookie"]).toContain("HttpOnly; SameSite=Strict");
    expect(signedIn.body).not.toContain(token);
    expect(
      (await app.inject({ method: "POST", url: "/auth/session", headers, payload: { code } }))
        .statusCode,
    ).toBe(401);
    const cookie = String(signedIn.headers["set-cookie"]).split(";")[0]!;
    expect(
      (await app.inject({ method: "GET", url: "/api/session", headers: { ...headers, cookie } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: "/api/test", headers: { ...headers, cookie } }))
        .statusCode,
    ).toBe(200);
    // Cookie signatures survive restarts; rotating the access token invalidates them.
    const restarted = create().app;
    expect(
      (
        await restarted.inject({
          method: "GET",
          url: "/api/session",
          headers: { ...headers, cookie },
        })
      ).statusCode,
    ).toBe(200);
    const rotated = create(new BrowserSessions("different-synthetic-access-token")).app;
    expect(
      (
        await rotated.inject({
          method: "GET",
          url: "/api/session",
          headers: { ...headers, cookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/auth/logout", headers: { ...headers, cookie } }))
        .headers["set-cookie"],
    ).toContain("Max-Age=0");
  });
  it("rejects expired links, forged cookies, cross-origin requests and DNS rebinding hosts", async () => {
    let now = Date.now();
    const { app, sessions } = create(new BrowserSessions(token, () => now));
    const expired = sessions.createLink();
    now += 120001;
    expect(sessions.exchange(expired)).toBeNull();
    const cookie = `vektor_session=${sessions.exchange(sessions.createLink())}`;
    for (const overrides of [
      { origin: "http://evil.example" },
      { host: "evil.example", origin: "http://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { cookie: cookie + "forged" },
      { authorization: "Bearer wrong" },
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/test",
            headers: { ...headers, cookie, ...overrides },
          })
        ).statusCode,
      ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/session",
          headers: { ...headers, origin: "http://evil.example" },
          payload: { code: sessions.createLink() },
        })
      ).statusCode,
    ).toBe(403);
    now += 31 * 24 * 60 * 60 * 1000;
    expect(
      (await app.inject({ method: "GET", url: "/api/session", headers: { ...headers, cookie } }))
        .statusCode,
    ).toBe(401);
  });
});
