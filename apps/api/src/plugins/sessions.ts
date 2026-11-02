import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

const COOKIE = "vektor_session";
const MAX_AGE = 30 * 24 * 60 * 60;
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function localOrigin(request: FastifyRequest): boolean {
  try {
    const origin = new URL(`http://${request.headers.host}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) return false;
    if (request.headers["sec-fetch-site"] === "cross-site") return false;
    const supplied = request.headers.origin;
    if (supplied && supplied !== `${request.protocol}://${request.headers.host}`) return false;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !supplied &&
      request.headers["sec-fetch-site"] !== "same-origin"
    )
      return false;
    return true;
  } catch {
    return false;
  }
}
export class BrowserSessions {
  private readonly links = new Map<string, number>();
  constructor(
    private readonly accessToken: string,
    private readonly now = Date.now,
  ) {}
  private sign(value: string): string {
    return createHmac("sha256", this.accessToken)
      .update(`vektor-browser-session:${value}`)
      .digest("base64url");
  }
  private hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
  createLink(): string {
    for (const [key, expiry] of this.links) if (expiry <= this.now()) this.links.delete(key);
    if (this.links.size >= 32) this.links.delete(this.links.keys().next().value!);
    const code = randomBytes(32).toString("base64url");
    this.links.set(this.hash(code), this.now() + 120_000);
    return code;
  }
  exchange(code: string): string | null {
    const key = this.hash(code),
      expiry = this.links.get(key);
    this.links.delete(key); // A link is single use, even on failed expiry checks.
    if (!expiry || expiry <= this.now()) return null;
    const value = `${randomBytes(24).toString("base64url")}.${this.now() + MAX_AGE * 1000}`;
    return `${value}.${this.sign(value)}`;
  }
  authenticated(request: FastifyRequest): boolean {
    if (!localOrigin(request)) return false;
    const cookie = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!cookie || cookie.length > 256) return false;
    const [nonce, expiry, signature, extra] = cookie.split(".");
    if (!nonce || !expiry || !signature || extra || !/^\d+$/.test(expiry)) return false;
    const remaining = Number(expiry) - this.now();
    return (
      remaining > 0 &&
      remaining <= MAX_AGE * 1000 &&
      equal(signature, this.sign(`${nonce}.${expiry}`))
    );
  }
  register(app: FastifyInstance): void {
    app.post("/api/session-link", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      return { code: this.createLink(), expiresInSeconds: 120 };
    });
    app.get("/api/session", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      return { authenticated: true };
    });
    app.post("/auth/session", { bodyLimit: 1024 }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!localOrigin(request))
        return reply.code(403).send({ message: "Open the sign-in link on this computer." });
      const code = (request.body as { code?: unknown } | null)?.code;
      const cookie = typeof code === "string" && code.length <= 128 ? this.exchange(code) : null;
      if (!cookie)
        return reply.code(401).send({
          message:
            "This sign-in link has expired or was already used. Run the installer with --open to get a new link.",
        });
      reply.header(
        "Set-Cookie",
        `${COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE}${request.protocol === "https" ? "; Secure" : ""}`,
      );
      return { authenticated: true };
    });
    app.post("/auth/logout", async (request, reply) => {
      if (!localOrigin(request)) return reply.code(403).send();
      reply.header("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return { authenticated: false };
    });
  }
}
