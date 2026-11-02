import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { saveComputerArtifact, pruneComputerArtifacts, type VektorDatabase } from "@vektor/db";
import { tmpdir } from "node:os";
import type { ComputerInput, ComputerPermissions, ComputerState } from "@vektor/shared";
import { RuntimeError } from "../runtime/terminal.js";
import { computerCapabilities } from "./desktop.js";
import { X11Computer, type ComputerController, type ComputerSessionOptions } from "./controller.js";

export class ComputerService {
  private readonly sessions = new Map<string, ComputerController>();
  private readonly root: string;
  private readonly closing = new Set<Promise<void>>();
  constructor(
    readonly options: {
      redact: (value: string) => string;
      db: VektorDatabase;
      dataDir: string;
      factory?: (options: ComputerSessionOptions) => ComputerController;
      maxSessions?: number;
      capabilities?: ReturnType<typeof computerCapabilities>;
    },
  ) {
    this.root = join(
      tmpdir(),
      `vektor-computer-${createHash("sha256").update(options.dataDir).digest("hex").slice(0, 20)}`,
    );
  }
  async initialize() {
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    pruneComputerArtifacts(this.options.db);
  }
  capabilities() {
    return this.options.capabilities ?? computerCapabilities();
  }
  private session(runId: string) {
    const value = this.sessions.get(runId);
    if (!value) throw new RuntimeError("No active computer session for this run.", 404);
    return value;
  }
  state(runId: string): ComputerState {
    return (
      this.sessions.get(runId)?.state() ?? {
        active: false,
        paused: false,
        sensitive: false,
        phase: "idle",
        windows: [],
        cursor: { x: 0, y: 0 },
        actions: 0,
      }
    );
  }
  async execute(
    runId: string,
    input: ComputerInput,
    options: {
      signal: AbortSignal;
      permissions: () => ComputerPermissions;
      approve: ComputerSessionOptions["approve"];
      onClosed?: () => void;
    },
    human = false,
  ) {
    if (this.options.redact(JSON.stringify(input)) !== JSON.stringify(input))
      throw new RuntimeError("Computer input cannot contain backend credentials.", 403);
    const capabilities = this.capabilities();
    if (!capabilities.available)
      throw new RuntimeError(capabilities.reason ?? "Computer use is unavailable.", 503);
    let session = this.sessions.get(runId);
    if (!session) {
      if (this.sessions.size >= (this.options.maxSessions ?? 2))
        throw new RuntimeError(
          "Two computer sessions are already running. Wait for one to finish.",
          409,
        );
      session = (this.options.factory ?? ((value) => new X11Computer(value)))({
        root: this.root,
        signal: options.signal,
        permissions: options.permissions,
        redact: this.options.redact,
        approve: options.approve,
        onClosed: options.onClosed,
        artifact: (actionId, action, stage, jpeg) =>
          saveComputerArtifact(
            this.options.db,
            runId,
            actionId,
            action,
            stage,
            jpeg,
            options.permissions().artifactDays * 86_400_000,
          ),
      });
      this.sessions.set(runId, session);
    }
    return session.execute(input, human);
  }
  async screenshot(runId: string, human = false) {
    return this.session(runId).screenshot(human);
  }
  privateTakeover(runId: string) {
    const session = this.session(runId);
    if (!session.privateTakeover)
      throw new RuntimeError("Private takeover is unavailable for this controller.", 409);
    session.privateTakeover();
  }
  pause(runId: string, paused: boolean) {
    this.sessions.get(runId)?.pause(paused);
  }
  async close(runId: string) {
    const session = this.sessions.get(runId);
    if (!session) return;
    this.sessions.delete(runId);
    const pending = session.close();
    this.closing.add(pending);
    try {
      await pending;
    } finally {
      this.closing.delete(pending);
    }
  }
  async stopAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
    await Promise.all([...this.closing]);
  }
}
