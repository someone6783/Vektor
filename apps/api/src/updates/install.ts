import { readFile, writeFile, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RELEASE_REPOSITORY } from "@vektor/shared";
import { RuntimeError } from "../runtime/terminal.js";
import { newerRelease, releaseVersion, RELEASE_API_URL, type UpdateService } from "./service.js";

const directory = () => process.env.VEKTOR_UPDATE_DIR;
const dockerStateSchema = z.object({
  heartbeat: z.number(),
  state: z.enum(["idle", "queued", "pulling", "backing_up", "installing", "complete", "failed"]),
  version: z.string().nullable(),
  message: z.string(),
});
export async function dockerUpdateState() {
  try {
    const dir = directory();
    if (!dir)
      return {
        configured: false,
        state: "unconfigured",
        message: "Docker host updater is not configured.",
      };
    const state = dockerStateSchema.parse(
      JSON.parse(await readFile(join(dir, "status.json"), "utf8")),
    );
    return { ...state, configured: Date.now() - state.heartbeat < 30_000 };
  } catch {
    return {
      configured: false,
      state: "unavailable",
      message: "Docker host updater is unavailable.",
    };
  }
}
export async function queueDockerUpdate(version: string) {
  const state = await dockerUpdateState();
  if (!state.configured) throw new RuntimeError("Docker host updater is unavailable.", 503);
  if (!["idle", "complete", "failed"].includes(state.state))
    throw new RuntimeError("A Docker update is already in progress.", 409);
  if (!releaseVersion(version)) throw new RuntimeError("Invalid update version.", 400);
  const dir = directory()!;
  const temporary = join(dir, `request-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ id: randomUUID(), version }), { mode: 0o600 });
  try {
    await link(temporary, join(dir, "request.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new RuntimeError("A Docker update is already queued.", 409);
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  return { configured: true, state: "queued", message: `Queued v${version}.` };
}

// Private release credentials stay in the backend. Only fixed GitHub API requests receive them.
export class DesktopReleases {
  private release?: { at: number; value: z.infer<typeof releaseSchema> };
  constructor(
    private updates: UpdateService,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  private async github(url: string, accept: string) {
    if (!this.updates.enabled) throw new RuntimeError("Enable update checks first.", 423);
    const token = this.updates.repositoryPrivate ? this.updates.credential.token : undefined;
    if (this.updates.repositoryPrivate && !token)
      throw new RuntimeError("Configure a GitHub release token first.", 423);
    const response = await this.fetchImpl(url, {
      redirect: "manual",
      headers: {
        Accept: accept,
        "User-Agent": "Vektor-updater",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(120_000),
    });
    // GitHub's asset API redirects to a temporary storage URL. Never forward authorization.
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = new URL(response.headers.get("location") ?? "");
      await response.body?.cancel();
      if (
        location.protocol !== "https:" ||
        !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
          location.hostname,
        )
      )
        throw new RuntimeError("Unexpected release asset redirect.", 502);
      return this.fetchImpl(location, {
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(120_000),
      });
    }
    return response;
  }
  async latest(force = false) {
    if (!this.release || force || Date.now() - this.release.at > 60_000) {
      const response = await this.github(RELEASE_API_URL, "application/vnd.github+json");
      if (!response.ok) throw new RuntimeError("Unable to load the latest desktop release.", 502);
      const text = await boundedText(response, 1024 * 1024);
      this.release = { at: Date.now(), value: releaseSchema.parse(JSON.parse(text)) };
    }
    return this.release.value;
  }
  async asset(id: number) {
    const release = await this.latest();
    if (!release.assets.some((asset) => asset.id === id))
      throw new RuntimeError("Unknown release asset.", 404);
    const response = await this.github(
      `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/assets/${id}`,
      "application/octet-stream",
    );
    if (!response.ok || !response.body)
      throw new RuntimeError("Unable to download the update.", 502);
    return response;
  }
  async manifest(current: string, origin: string, target = "linux-x86_64") {
    const release = await this.latest(true);
    const version = releaseVersion(release.tag_name);
    if (!version || release.prerelease || release.draft)
      throw new RuntimeError("Invalid stable release.", 502);
    if (!newerRelease(current, version)) return null;
    const suffix = target === "windows-x86_64" ? "-setup.exe" : ".AppImage";
    const artifact = release.assets.find((asset) => asset.name.endsWith(suffix));
    const signature = release.assets.find((asset) => asset.name === `${artifact?.name}.sig`);
    if (!artifact || !signature)
      throw new RuntimeError(
        "This release has no signed desktop update for the requested platform.",
        404,
      );
    return {
      version,
      url: `${origin}/api/desktop-update/assets/${artifact.id}`,
      signature: (await boundedText(await this.asset(signature.id), 16_384)).trim(),
    };
  }
}
const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(z.object({ id: z.number().int().positive(), name: z.string() })),
});
async function boundedText(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new RuntimeError("Empty release response.", 502);
  let bytes = 0;
  const chunks: Buffer[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new RuntimeError("Release response is too large.", 502);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function registerDesktopUpdateRoutes(app: FastifyInstance, releases: DesktopReleases) {
  app.get("/api/desktop-update/:target/:current", async (request, reply) => {
    const { current, target } = z
      .object({
        target: z.enum(["linux-x86_64", "windows-x86_64"]),
        current: z.string().refine((v) => releaseVersion(v) === v),
      })
      .parse(request.params);
    // The desktop passes its configured loopback origin; never trust arbitrary Host headers.
    const origin = z.string().url().parse(request.headers["x-vektor-backend"]);
    const url = new URL(origin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new RuntimeError("Invalid local backend origin.", 400);
    const manifest = await releases.manifest(current, url.origin, target);
    return manifest ?? reply.code(204).send();
  });
  app.get("/api/desktop-update/assets/:id", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const response = await releases.asset(id);
    reply.type("application/octet-stream");
    return reply.send(Readable.fromWeb(response.body as ReadableStream));
  });
}
