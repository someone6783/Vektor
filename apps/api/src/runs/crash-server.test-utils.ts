import { bootstrapStorage } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { buildApp } from "../app.js";
import { acquireDataLock } from "../maintenance/data-lock.js";
import type { ChatProvider } from "../providers/types.js";

const config = loadConfig();
const release = await acquireDataLock(config.dataDir);
const provider: ChatProvider = {
  kind: "openrouter",
  async *streamChat(request) {
    if (process.env.TEST_CRASH_PROVIDER === "fast") {
      yield { type: "text.delta", text: "Recovered and retryable." };
      yield { type: "usage", promptTokens: 3, completionTokens: 2, totalTokens: 5, costUsd: 0.001 };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (process.env.TEST_CRASH_PROVIDER === "mcp") {
      yield { type: "text.delta", text: "MCP started. " };
      const tool = request.tools?.find((t) => t.function.description.includes(": wait."));
      if (tool) {
        yield {
          type: "tool_call",
          id: "crash-mcp",
          name: tool.function.name,
          argumentsJson: JSON.stringify({ text: "Crash MCP fixture" }),
        };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
    }
    yield { type: "text.delta", text: "Persisted partial response. ".repeat(12) };
    yield { type: "usage", promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.002 };
    if (process.env.TEST_CRASH_PROVIDER === "computer") {
      const results = request.messages.filter((message) => message.role === "tool");
      yield {
        type: "tool_call",
        id: `desktop-${results.length}`,
        name: "computer",
        argumentsJson: JSON.stringify(
          results.length === 0 ? { action: "screenshot" } : { action: "key", key: "Return" },
        ),
      };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    if (process.env.TEST_CRASH_PROVIDER === "browser") {
      const results = request.messages.filter((message) => message.role === "tool");
      const result = results.at(-1)?.content;
      const snapshot = typeof result === "string" ? (JSON.parse(result).snapshot ?? "") : "";
      const ref = snapshot
        .split("\n")
        .find((line: string) => /^e\d+_\d+:/.test(line) && line.includes("Submit"))
        ?.split(":")[0];
      yield {
        type: "tool_call",
        id: `browser-crash-${results.length}`,
        name: "browser",
        argumentsJson: JSON.stringify(
          results.length === 0
            ? { action: "navigate", url: process.env.TEST_BROWSER_URL }
            : { action: "click", ref },
        ),
      };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    if (
      request.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("terminal"),
      )
    ) {
      yield {
        type: "tool_call",
        id: "crash-command",
        name: "terminal",
        argumentsJson: JSON.stringify({
          command: "sh",
          args: ["-c", "sleep 60 & echo $! > child.pid; wait"],
          timeoutMs: 60000,
        }),
      };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    await new Promise<void>((resolve) =>
      request.signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
  },
};
const app = await buildApp({ config, storage: bootstrapStorage(config), provider, logger: false });
await app.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ port: (app.server.address() as { port: number }).port });
process.on("SIGTERM", () => {
  void app
    .close()
    .then(release)
    .then(() => process.exit(0));
});
