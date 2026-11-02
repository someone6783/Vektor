import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  appendAudit,
  deleteSetting,
  getSetting,
  setSetting,
  type VektorDatabase,
} from "@vektor/db";
import {
  sshConnectionInputObjectSchema,
  sshConnectionInputSchema,
  sshConnectionSchema,
  sshSecretSchema,
  type SshConnection,
  type SshConnectionInput,
  type SshSetup,
} from "@vektor/shared";
import { decryptSecret, encryptSecret } from "../secrets.js";
import { SshError, SshExecutor } from "./executor.js";

interface SshSecretRecord {
  password?: string;
  passphrase?: string;
}

const CONNECTIONS_KEY = "ssh.connections";
const MAX_CONNECTIONS = 20;

export class SshService {
  constructor(
    readonly db: VektorDatabase,
    private readonly key: Buffer,
  ) {}

  setup(): SshSetup {
    return { connections: this.list() };
  }

  list(): SshConnection[] {
    return z
      .array(sshConnectionSchema)
      .parse(getSetting(this.db, CONNECTIONS_KEY) ?? []);
  }

  /** Decrypted secret values, only used to redact logging and tool output. */
  secrets(): string[] {
    const values: string[] = [];
    for (const connection of this.list()) {
      const record = this.readSecretRecord(connection.id);
      for (const value of [record.password, record.passphrase]) {
        if (value) values.push(value);
      }
    }
    return values;
  }

  create(input: SshConnectionInput): SshConnection {
    const parsed = sshConnectionInputSchema.parse(input);
    if (parsed.authType === "key" && !parsed.keyPath)
      throw new SshError("Key authentication requires an SSH key path.");
    const existing = this.list();
    if (existing.length >= MAX_CONNECTIONS)
      throw new SshError("At most twenty SSH connections can be configured.", 409);
    const now = new Date().toISOString();
    const connection = sshConnectionSchema.parse({
      id: randomUUID(),
      ...parsed,
      keyPath: parsed.authType === "key" ? (parsed.keyPath ?? null) : null,
      hasPassword: false,
      hasPassphrase: false,
      createdAt: now,
      updatedAt: now,
    });
    setSetting(this.db, CONNECTIONS_KEY, [...existing, connection]);
    appendAudit(this.db, "ssh.connection_created", null, {
      connectionId: connection.id,
      host: connection.host,
      authType: connection.authType,
    });
    return connection;
  }

  update(id: string, input: Partial<SshConnectionInput>): SshConnection {
    const existing = this.get(id);
    const patch = sshConnectionInputObjectSchema.partial().parse(input);
    const merged = sshConnectionInputSchema.parse({
      name: patch.name ?? existing.name,
      host: patch.host ?? existing.host,
      port: patch.port ?? existing.port,
      username: patch.username ?? existing.username,
      authType: patch.authType ?? existing.authType,
      keyPath: patch.keyPath ?? existing.keyPath ?? undefined,
    });
    const next: SshConnection = {
      ...existing,
      name: merged.name,
      host: merged.host,
      port: merged.port,
      username: merged.username,
      authType: merged.authType,
      keyPath: merged.keyPath ?? null,
      updatedAt: new Date().toISOString(),
    };
    this.save(next);
    appendAudit(this.db, "ssh.connection_updated", null, { connectionId: id });
    return next;
  }

  remove(id: string): void {
    const existing = this.list();
    this.get(id);
    setSetting(
      this.db,
      CONNECTIONS_KEY,
      existing.filter((connection) => connection.id !== id),
    );
    deleteSetting(this.db, `ssh.secrets.${id}`);
    appendAudit(this.db, "ssh.connection_removed", null, { connectionId: id });
  }

  credentials(id: string, values: { password?: string | null; passphrase?: string | null }): void {
    const parsed = sshSecretSchema.parse(values);
    const connection = this.get(id);
    const current = this.readSecretRecord(id);
    const next: SshSecretRecord = {
      password: parsed.password === undefined ? current.password : (parsed.password ?? undefined),
      passphrase:
        parsed.passphrase === undefined ? current.passphrase : (parsed.passphrase ?? undefined),
    };
    setSetting(this.db, `ssh.secrets.${id}`, encryptSecret(JSON.stringify(next), this.key));
    const updated: SshConnection = {
      ...connection,
      hasPassword: next.password !== undefined,
      hasPassphrase: next.passphrase !== undefined,
      updatedAt: new Date().toISOString(),
    };
    this.save(updated);
    appendAudit(this.db, "ssh.credentials_replaced", null, { connectionId: id });
  }

  async test(id: string): Promise<{ ok: boolean; message: string }> {
    const executor = this.executor(id);
    try {
      const result = await executor.execute(
        { command: "printf vektor-ssh-ok", remoteCwd: null, timeoutMs: 15_000 },
        new AbortController().signal,
      );
      const ok = result.exitCode === 0 && result.output.trim() === "vektor-ssh-ok";
      return { ok, message: ok ? "Connected and executed a probe command." : result.output.trim() };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "SSH test failed." };
    }
  }

  /** Build a remote executor for a bound conversation. Throws when missing or unusable. */
  chatExecutor(id: string): SshExecutor {
    const connection = this.get(id);
    const secret = this.readSecretRecord(id);
    if (connection.authType === "password" && !secret.password)
      throw new SshError("This SSH connection has no stored password. Save it in SSH settings.");
    return new SshExecutor(connection, secret);
  }

  executor(id: string): SshExecutor {
    const connection = this.get(id);
    const secret = this.readSecretRecord(id);
    return new SshExecutor(connection, secret);
  }

  private readSecretRecord(id: string): SshSecretRecord {
    const encrypted = getSetting(this.db, `ssh.secrets.${id}`);
    if (typeof encrypted !== "string") return {};
    try {
      return z
        .object({ password: z.string().optional(), passphrase: z.string().optional() })
        .parse(JSON.parse(decryptSecret(encrypted, this.key)));
    } catch {
      return {};
    }
  }

  private get(id: string): SshConnection {
    const connection = this.list().find((entry) => entry.id === id);
    if (!connection) throw new SshError("SSH connection not found.", 404);
    return connection;
  }

  private save(connection: SshConnection): void {
    const list = this.list();
    const index = list.findIndex((entry) => entry.id === connection.id);
    list[index] = connection;
    setSetting(this.db, CONNECTIONS_KEY, list);
  }
}
