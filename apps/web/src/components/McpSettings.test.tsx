import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { mcpServerSchema, mcpGrantSchema, type Profile } from "@vektor/shared";
import { ApiClient } from "../lib/api";
import { McpSettings } from "./McpSettings";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const profile = { id: "profile", name: "Work" } as Profile;
const server = mcpServerSchema.parse({
  id: "00000000-0000-4000-8000-000000000001",
  name: "Notes service",
  transport: "http",
  url: "https://notes.example/mcp",
  revision: 1,
  enabled: false,
  configuredSecretNames: [],
  discovery: {
    protocolVersion: "2025-11-25",
    serverInfo: { name: "Notes", version: "1.0.0" },
    tools: [
      {
        name: "lookup",
        description: "Find a note",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
    ],
    resources: [],
    templates: [],
    prompts: [],
    checkedAt: "2026-11-02",
    hash: "fixture",
    warnings: [],
  },
  health: {
    state: "healthy",
    failures: 0,
    retryAt: 0,
    message: "Test passed",
    checkedAt: "2026-11-02",
  },
});
function setup() {
  const client = new ApiClient("test");
  const view = {
    servers: [server],
    grants: [
      { serverId: server.id, profileId: profile.id, revision: 1, grant: mcpGrantSchema.parse({}) },
    ],
  };
  const load = vi.spyOn(client, "mcpSetup").mockResolvedValue(view),
    test = vi.spyOn(client, "testMcp").mockResolvedValue(server),
    enable = vi.spyOn(client, "enableMcp").mockResolvedValue(undefined),
    grant = vi.spyOn(client, "grantMcp").mockResolvedValue(undefined),
    credentials = vi.spyOn(client, "mcpCredentials").mockResolvedValue(undefined),
    configure = vi.spyOn(client, "configureMcp").mockResolvedValue(server),
    preview = vi.spyOn(client, "previewMcp");
  render(<McpSettings client={client} profiles={[profile]} />);
  return { client, load, test, enable, grant, credentials, configure, preview };
}
describe("MCP settings", () => {
  it("loads cached metadata only on request and keeps test, enable and grants separate", async () => {
    const s = setup();
    expect(s.load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load MCP settings" }));
    await screen.findByText(/Notes service · http/);
    expect(s.test).not.toHaveBeenCalled();
    expect(s.enable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Test / reconnect" }));
    await waitFor(() => expect(s.test).toHaveBeenCalledWith(server.id));
    expect(s.enable).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Enable" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(s.enable).toHaveBeenCalledWith(server.id, true));
    expect(s.grant).not.toHaveBeenCalled();
    expect(s.preview).not.toHaveBeenCalled();
  });
  it("stores credentials through a write-only action and clears the password draft", async () => {
    const s = setup();
    fireEvent.click(screen.getByRole("button", { name: "Load MCP settings" }));
    await screen.findByText(/Notes service · http/);
    fireEvent.change(screen.getByLabelText("Notes service credential name 1"), {
      target: { value: "Authorization" },
    });
    const value = screen.getByLabelText("Notes service credential value 1");
    expect(value).toHaveAttribute("type", "password");
    fireEvent.change(value, { target: { value: "Bearer own-mcp-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace protected values" }));
    await waitFor(() =>
      expect(s.credentials).toHaveBeenCalledWith(server.id, {
        Authorization: "Bearer own-mcp-key",
      }),
    );
    await waitFor(() => expect(value).toHaveValue(""));
    expect(s.test).not.toHaveBeenCalled();
  });
  it("saves explicit tool and external-runner grants without invoking the tool", async () => {
    const s = setup();
    fireEvent.click(screen.getByRole("button", { name: "Load MCP settings" }));
    await screen.findByText(/Notes service · http/);
    fireEvent.click(screen.getByLabelText("lookup"));
    fireEvent.click(screen.getByLabelText("Allow these tools in Codex / ACP runs"));
    fireEvent.click(screen.getByRole("button", { name: "Save MCP profile grants" }));
    await waitFor(() =>
      expect(s.grant).toHaveBeenCalledWith(
        "profile",
        server.id,
        expect.objectContaining({
          tools: [{ name: "lookup", policy: "approval" }],
          externalRunners: true,
          scheduled: false,
        }),
      ),
    );
    expect(s.test).not.toHaveBeenCalled();
  });
  it("editing retains configuration but never starts a server", async () => {
    const s = setup();
    fireEvent.click(screen.getByRole("button", { name: "Load MCP settings" }));
    await screen.findByText(/Notes service · http/);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("MCP endpoint")).toHaveValue(server.url);
    fireEvent.click(screen.getByRole("button", { name: "Save disabled MCP server" }));
    await waitFor(() =>
      expect(s.configure).toHaveBeenCalledWith(
        expect.objectContaining({ name: server.name, url: server.url, transport: "http" }),
        server.id,
      ),
    );
    expect(s.test).not.toHaveBeenCalled();
  });
});
