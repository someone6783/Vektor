import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { browserPermissionsSchema } from "@vektor/shared";
import { BrowserNetwork, browserUrl, publicAddress } from "./network.js";

describe("browser network boundary", () => {
  it("rejects malformed origin settings as validation errors without throwing", () => {
    expect(browserPermissionsSchema.safeParse({ allowedOrigins: ["invalid"] }).success).toBe(false);
    expect(browserPermissionsSchema.safeParse({ localOrigins: ["invalid"] }).success).toBe(false);
  });
  it.each([{}, { allowedOrigins: [] }, { allowedOrigins: ["*"] }])(
    "allows any website origin for empty or wildcard settings: %j",
    (input) => {
      const permissions = browserPermissionsSchema.parse(input);
      expect(permissions.allowedOrigins).toEqual(["*"]);
      for (const url of [
        "https://example.com/path",
        "https://other.example:444/",
        "http://example.org",
      ])
        expect(browserUrl(url, permissions).href).toBe(new URL(url).href);
      for (const url of [
        "file:///etc/passwd",
        "data:text/html,secret",
        "https://user:pass@example.com",
      ])
        expect(() => browserUrl(url, permissions)).toThrow();
    },
  );
  it("keeps private-network restrictions with wildcard origins", async () => {
    const network = new BrowserNetwork({
      permissions: () => browserPermissionsSchema.parse({ allowedOrigins: [] }),
      signal: new AbortController().signal,
      redact: (value) => value,
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    });
    expect(await network.address(new URL("https://any.example"))).toEqual({
      address: "8.8.8.8",
      family: 4,
    });
    await expect(network.address(new URL("http://127.0.0.1"))).rejects.toThrow(/private/);
  });
  it("pins hostname connections to the validated address instead of resolving twice", async () => {
    const server = createServer((_request, response) => response.end("pinned"));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://localhost:${(server.address() as { port: number }).port}`;
    let lookups = 0;
    const network = new BrowserNetwork({
      permissions: () =>
        browserPermissionsSchema.parse({ mode: "observe", localOrigins: [origin] }),
      signal: new AbortController().signal,
      redact: (value) => value,
      resolve: async () => {
        lookups++;
        return [{ address: "127.0.0.1", family: 4 }];
      },
    });
    try {
      expect((await network.request(origin)).body.toString()).toBe("pinned");
      expect(lookups).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "192.0.0.8",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])("blocks nonpublic address %s", (address) => expect(publicAddress(address)).toBe(false));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("accepts public address %s", (address) =>
    expect(publicAddress(address)).toBe(true),
  );
  it("pins validated DNS answers and rejects mixed public/private or rebound hosts", async () => {
    const permissions = browserPermissionsSchema.parse({
      mode: "observe",
      allowedOrigins: ["https://example.com"],
    });
    let addresses = [{ address: "8.8.8.8", family: 4 }];
    const network = new BrowserNetwork({
      permissions: () => permissions,
      signal: new AbortController().signal,
      redact: (value) => value,
      resolve: async () => addresses,
    });
    expect(await network.address(new URL("https://example.com/path"))).toEqual(addresses[0]);
    addresses = [...addresses, { address: "127.0.0.1", family: 4 }];
    await expect(network.address(new URL("https://example.com"))).rejects.toThrow(/private/);
    addresses = [{ address: "169.254.169.254", family: 4 }];
    await expect(network.address(new URL("https://example.com"))).rejects.toThrow(/private/);
  });
  it("requires a separate exact local grant and blocks the backend listener", async () => {
    let permissions = browserPermissionsSchema.parse({
      mode: "interactive",
      allowedOrigins: ["http://127.0.0.1:8787"],
    });
    const network = new BrowserNetwork({
      permissions: () => permissions,
      signal: new AbortController().signal,
      protectedPort: 8787,
      redact: (value) => value,
    });
    await expect(network.address(new URL("http://127.0.0.1:8787"))).rejects.toThrow(/private/);
    permissions = browserPermissionsSchema.parse({
      mode: "interactive",
      localOrigins: ["http://127.0.0.1:8787"],
    });
    await expect(network.address(new URL("http://127.0.0.1:8787"))).rejects.toThrow(/backend/);
    expect(
      browserPermissionsSchema.safeParse({ localOrigins: ["http://169.254.169.254"] }).success,
    ).toBe(false);
  });
  it.each([
    "file:///etc/passwd",
    "http://user:pass@example.com",
    "https://example.com.evil.test",
    "https://example.com:444",
    "http://example.com",
    "data:text/html,secret",
  ])("rejects an out-of-scope URL %s", (url) => {
    expect(() =>
      browserUrl(
        url,
        browserPermissionsSchema.parse({
          mode: "observe",
          allowedOrigins: ["https://example.com"],
        }),
      ),
    ).toThrow();
  });
});
