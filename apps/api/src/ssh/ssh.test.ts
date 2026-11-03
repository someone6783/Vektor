import { afterEach, describe, expect, it } from "vitest";
import { getSetting } from "@vektor/db";
import { terminalInputSchema } from "@vektor/shared";
import { harness } from "../mcp/fixtures.test-utils.js";
import { SshService } from "./service.js";
import { buildRemoteCommand, expandHomeDir, shellQuote } from "./executor.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const keyConnection = {
  name: "Build server",
  host: "203.0.113.10",
  port: 2022,
  username: "deploy",
  authType: "key",
  keyPath: "~/.ssh/id_ed25519",
} as const;

const passwordConnection = {
  name: "NAS",
  host: "127.0.0.1",
  port: 9,
  username: "backup",
  authType: "password",
};

async function setup() {
  const h = await harness();
  cleanups.push(h.close);
  return h;
}

describe("ssh connection storage and routes", () => {
  it("stores connections with write-only encrypted credentials and audit trail", async () => {
    const h = await setup();
    const created = (
      await h.api("/api/ssh", {
        ...keyConnection,
      })
    ).connection;
    expect(created.id).toBeTruthy();
    expect(created).toMatchObject({
      name: "Build server",
      port: 2022,
      authType: "key",
      keyPath: "~/.ssh/id_ed25519",
      hasPassword: false,
    });
    expect(created).not.toHaveProperty("password");

    const password = "super-login-secret-9701";
    await h.api(`/api/ssh/${created.id}/credentials`, { password }, "PUT");
    const view = JSON.stringify(await h.api("/api/ssh"));
    expect(view).not.toContain(password);
    expect(String(getSetting(h.storage.db, `ssh.secrets.${created.id}`))).not.toContain(password);
    const encryptedRecord = getSetting(h.storage.db, `ssh.secrets.${created.id}`);
    expect(typeof encryptedRecord).toBe("string");
    const service = new SshService(h.storage.db, h.storage.secretsKey);
    expect(service.secrets()).toContain(password);

    const updated = (
      await h.api(`/api/ssh/${created.id}`, { name: "Build server 2", port: 2200 }, "PUT")
    ).connection;
    expect(updated).toMatchObject({ name: "Build server 2", port: 2200, hasPassword: true });
  });

  it("rejects invalid inputs and missing references", async () => {
    const h = await setup();
    const invalid = await h.app.inject({
      method: "POST",
      url: "/api/ssh",
      headers: h.headers,
      payload: { ...keyConnection, host: 'bad "host"' },
    });
    expect(invalid.statusCode).toBe(400);
    const missingKey = await h.app.inject({
      method: "POST",
      url: "/api/ssh",
      headers: h.headers,
      payload: { ...keyConnection, keyPath: undefined },
    });
    expect(missingKey.statusCode).toBe(400);
    expect(JSON.stringify(missingKey.json())).toContain("SSH key path");
    const credentials = await h.app.inject({
      method: "PUT",
      url: `/api/ssh/00000000-0000-4000-8000-000000000000/credentials`,
      headers: h.headers,
      payload: { password: "not-stored-0001" },
    });
    expect(credentials.statusCode).toBe(400);
  });

  it("tests a password connection only when credentials are stored", async () => {
    const h = await setup();
    const created = (await h.api("/api/ssh", passwordConnection)).connection;
    const before = await h.api(`/api/ssh/${created.id}/test`, {});
    expect(before).toMatchObject({ ok: false });
    expect(String(before.message)).toContain("no stored password");
    await h.api(`/api/ssh/${created.id}/credentials`, { password: "ignored-network-0001" }, "PUT");
    const after = await h.api(`/api/ssh/${created.id}/test`, {});
    // No real SSH server in CI: connection must fail without leaking the password.
    expect(after.ok).toBe(false);
    expect(JSON.stringify(after)).not.toContain("ignored-network-0001");
  });

  it("removes connections and their stored secrets", async () => {
    const h = await setup();
    const created = (await h.api("/api/ssh", keyConnection)).connection;
    await h.api(`/api/ssh/${created.id}/credentials`, { passphrase: "pass-phrase-0001" }, "PUT");
    await h.api(`/api/ssh/${created.id}`, undefined, "DELETE");
    expect(getSetting(h.storage.db, `ssh.secrets.${created.id}`)).toBeUndefined();
    const list = await h.api("/api/ssh");
    expect(list.connections).toHaveLength(0);
  });
});

describe("remote command preparation", () => {
  it("quotes arguments, expands home paths and builds safe remote commands", () => {
    expect(shellQuote("safe/name-1.0")).toBe("safe/name-1.0");
    expect(shellQuote("a b; rm")).toBe("'a b; rm'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    const input = terminalInputSchema.parse({
      command: "cat",
      args: ["notes file.txt"],
      cwd: "notes",
    });
    expect(buildRemoteCommand(input, "notes")).toBe("cd notes && cat 'notes file.txt'");
    expect(expandHomeDir("~/ssh/id_ed25519").startsWith("/")).toBe(true);
  });
});
