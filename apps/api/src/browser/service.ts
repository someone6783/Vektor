import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAttachment,
  saveBrowserArtifact,
  setAttachmentIncluded,
  type VektorDatabase,
} from "@vektor/db";
import {
  browserPermissionsSchema,
  type BrowserInput,
  type BrowserPermissions,
  type BrowserState,
} from "@vektor/shared";
import type { AttachmentService } from "../attachments/service.js";
import { RuntimeError } from "../runtime/terminal.js";
import {
  PlaywrightBrowser,
  type BrowserController,
  type BrowserSessionOptions,
} from "./controller.js";

export class BrowserService {
  private readonly sessions = new Map<string, BrowserController>();
  private readonly closing = new Set<Promise<void>>();
  private readonly root: string;
  constructor(
    readonly options: {
      db: VektorDatabase;
      attachments: AttachmentService;
      dataDir: string;
      redact: (value: string) => string;
      protectedPort?: number;
      ttlDays?: number;
      factory?: (options: BrowserSessionOptions) => BrowserController;
    },
  ) {
    this.root = join(
      tmpdir(),
      `vektor-browser-${createHash("sha256").update(options.dataDir).digest("hex").slice(0, 20)}`,
    );
  }
  async initialize() {
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }
  private session(runId: string) {
    const value = this.sessions.get(runId);
    if (!value) throw new RuntimeError("No active browser session for this run.", 404);
    return value;
  }
  state(runId: string): BrowserState {
    return (
      this.sessions.get(runId)?.state() ?? {
        active: false,
        paused: false,
        sensitive: false,
        url: "about:blank",
        tabs: [],
        actions: 0,
        snapshot: "",
      }
    );
  }
  pause(runId: string, paused: boolean) {
    this.session(runId).pause(paused);
  }
  async execute(
    runId: string,
    channelId: string,
    input: BrowserInput,
    options: {
      signal: AbortSignal;
      permissions: () => BrowserPermissions;
      approve: BrowserSessionOptions["approve"];
    },
    human = false,
  ) {
    if (this.options.redact(JSON.stringify(input)) !== JSON.stringify(input))
      throw new RuntimeError("Browser input cannot contain backend credentials.", 403);
    const permissions = browserPermissionsSchema.parse(options.permissions());
    if (permissions.mode === "off")
      throw new RuntimeError("Browser access is disabled for this profile.", 403);
    let controller = this.sessions.get(runId);
    if (!controller) {
      if (human) throw new RuntimeError("Start a browser session before takeover.", 409);
      if (this.sessions.size >= 2)
        throw new RuntimeError("Two managed browser sessions are already active.", 429);
      const factory =
        this.options.factory ?? ((sessionOptions) => new PlaywrightBrowser(sessionOptions));
      controller = factory({
        ...options,
        root: this.root,
        redact: this.options.redact,
        protectedPort: this.options.protectedPort,
        artifact: (jpeg, origin) =>
          saveBrowserArtifact(
            this.options.db,
            runId,
            origin,
            jpeg,
            (this.options.ttlDays ?? 7) * 86_400_000,
          ),
        upload: async (id) => {
          const file = getAttachment(this.options.db, id);
          if (!file || file.channelId !== channelId)
            throw new RuntimeError("Choose an attachment owned by this run's channel.", 403);
          if (file.size > 2 * 1024 * 1024)
            throw new RuntimeError("Browser uploads are limited to 2 MiB.", 413);
          const directory = await lstat(join(this.options.dataDir, "files"));
          if (!directory.isDirectory() || directory.isSymbolicLink())
            throw new RuntimeError("Invalid attachment directory.", 403);
          const handle = await open(
            this.options.attachments.path(file.id),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const stat = await handle.stat();
            if (
              !stat.isFile() ||
              stat.nlink !== 1 ||
              stat.size !== file.size ||
              stat.size > 2 * 1024 * 1024
            )
              throw new RuntimeError("Attachment changed or is not a regular private file.", 403);
            return { name: file.filename, mimeType: file.mime, buffer: await handle.readFile() };
          } finally {
            await handle.close();
          }
        },
        download: async (filename, buffer) => {
          if (buffer.length > 2 * 1024 * 1024)
            throw new RuntimeError("Browser downloads are limited to 2 MiB.", 413);
          const release = this.options.attachments.reserve(channelId);
          try {
            const file = await this.options.attachments.save(channelId, filename, buffer);
            setAttachmentIncluded(this.options.db, file.id, false);
            return { id: file.id, filename: file.filename, size: file.size };
          } finally {
            release();
          }
        },
      });
      this.sessions.set(runId, controller);
    }
    return controller.execute(input, human);
  }
  close(runId: string): Promise<void> {
    const controller = this.sessions.get(runId);
    this.sessions.delete(runId);
    const pending = controller?.close() ?? Promise.resolve();
    this.closing.add(pending);
    void pending.finally(() => this.closing.delete(pending));
    return pending;
  }
  async stopAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
    await Promise.all([...this.closing]);
  }
}
