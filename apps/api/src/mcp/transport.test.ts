import { it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedRunner } from "../runners/isolation.js";
import { IsolatedStdioTransport, PinnedTransport } from "./transport.js";
import { McpClient } from "./client.js";
import { fakeMcp } from "./fixtures.test-utils.js";

it("connects the pinned client to an isolated standalone MCP server", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vektor-mcp-protocol-")),
    command = join(directory, "server");
  writeFileSync(command, fakeMcp, { mode: 0o700 });
  const isolated = await isolatedRunner({
    command,
    args: [],
    hosts: [],
    credentials: {},
    signal: AbortSignal.timeout(5000),
  });
  const client = new McpClient(
    new PinnedTransport(new IsolatedStdioTransport({ ...isolated })),
    AbortSignal.timeout(5000),
  );
  try {
    await client.connect();
    expect((await client.discover()).tools.length).toBeGreaterThan(0);
  } finally {
    await client.close();
    await isolated.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
it("keeps a fixed tool deadline despite progress and sends a cancellation notification", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vektor-mcp-timeout-")),
    command = join(directory, "server");
  writeFileSync(command, fakeMcp, { mode: 0o700 });
  const isolated = await isolatedRunner({
    command,
    args: [],
    hosts: [],
    credentials: {},
    signal: new AbortController().signal,
  });
  const transport = new PinnedTransport(new IsolatedStdioTransport({ ...isolated })),
    send = vi.spyOn(transport, "send"),
    client = new McpClient(transport, new AbortController().signal);
  try {
    await client.connect();
    const discovery = await client.discover();
    vi.useFakeTimers();
    const call = client.call(
      discovery.tools.find((t) => t.name === "wait")!,
      { text: "timeout fixture" },
      new AbortController().signal,
      () => {
        vi.advanceTimersByTime(30001);
      },
    );
    await expect(call).rejects.toThrow(/timed out|timeout/i);
    expect(
      send.mock.calls.some(
        ([message]) => "method" in message && message.method === "notifications/cancelled",
      ),
    ).toBe(true);
  } finally {
    vi.useRealTimers();
    await client.close();
    await isolated.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
