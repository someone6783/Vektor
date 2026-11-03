import type { Profile } from "@vektor/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerSetup } from "./RunnerSetup";
import type { ApiClient } from "../lib/api";

afterEach(cleanup);

describe("runner setup", () => {
  it("loads status without probing executables or executing registry metadata", async () => {
    const runnerSetup = vi.fn().mockResolvedValue({
      probes: [],
      registry: {
        checkedAt: new Date().toISOString(),
        source: "official",
        hash: "hash",
        agents: [
          {
            id: "agent",
            name: "Test agent",
            authors: ["Publisher"],
            version: "1.0.0",
            description: "Description",
          },
        ],
      },
    });
    const probeRunner = vi.fn();
    render(
      <RunnerSetup
        client={
          {
            runnerSetup,
            probeRunner,
            discoverRunners: vi.fn().mockResolvedValue({
              executables: [
                { name: "codex", command: "/detected/codex" },
                { name: "opencode", command: "/detected/opencode" },
              ],
            }),
          } as unknown as ApiClient
        }
      />,
    );
    expect(runnerSetup).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Load setup" }));
    expect(await screen.findByText(/Test agent · 1.0.0/)).toBeInTheDocument();
    expect(screen.getByText(/Unverified \/ unavailable/)).toBeInTheDocument();
    expect(probeRunner).not.toHaveBeenCalled();
  });
  it("requires an absolute executable path and shows probe failures without enabling execution", async () => {
    const probeRunner = vi.fn().mockRejectedValue(new Error("Unsupported agent version"));
    render(
      <RunnerSetup
        client={
          {
            probeRunner,
            runnerSetup: vi
              .fn()
              .mockResolvedValue({ probes: [], installations: [], registry: null }),
            discoverRunners: vi.fn().mockResolvedValue({
              executables: [
                { name: "codex", command: "/detected/codex" },
                { name: "opencode", command: "/detected/opencode" },
              ],
            }),
          } as unknown as ApiClient
        }
      />,
    );
    const submit = screen.getByRole("button", { name: "Probe installed agent" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Agent executable path"), {
      target: { value: "/usr/bin/agent" },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(probeRunner).toHaveBeenCalledWith({
        interface: "codex-app-server",
        command: "/usr/bin/agent",
        args: [],
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported agent version");
  });
});

it("keeps credential saving, agent enablement and profile grants as separate explicit actions", async () => {
  const entry = {
    id: "codex",
    name: "Codex",
    version: "0.166.0",
    interface: "codex-app-server",
    source: "explicit-local-codex-trust",
    sourceHash: "hash",
    executableHash: "hash",
    command: "/managed/codex",
    args: [],
    verifiedAt: "2026-11-02",
    enabled: false,
    inferenceHosts: ["api.openai.com"],
    credentialName: "OPENAI_API_KEY",
    credentialConfigured: false,
  };
  const setup = {
    probes: [],
    registry: null,
    installations: [entry],
    grants: [{ profileId: "profile", runner: "codex", workspace: false, inference: false }],
  };
  const runnerSetup = vi.fn().mockResolvedValue(setup);
  const runnerCredential = vi.fn().mockImplementation(async () => {
    entry.credentialConfigured = true;
  });
  const enableRunner = vi.fn().mockResolvedValue(undefined);
  const runnerGrant = vi.fn().mockResolvedValue(undefined);
  const profile = { id: "profile", name: "Coding" } as Profile;
  render(
    <RunnerSetup
      client={
        {
          runnerSetup,
          runnerCredential,
          enableRunner,
          runnerGrant,
          discoverRunners: vi.fn().mockResolvedValue({
            executables: [
              { name: "codex", command: "/detected/codex" },
              { name: "opencode", command: "/detected/opencode" },
            ],
          }),
        } as unknown as ApiClient
      }
      profiles={[profile]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Load setup" }));
  expect(await screen.findByRole("button", { name: "Enable agent" })).toBeDisabled();
  const credential = screen.getByLabelText("Credential for Codex");
  fireEvent.change(credential, { target: { value: "dummy-ui-agent-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
  await waitFor(() => expect(runnerCredential).toHaveBeenCalledWith("codex", "dummy-ui-agent-key"));
  expect(credential).toHaveValue("");
  expect(enableRunner).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Enable agent" })).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Enable agent" }));
  await waitFor(() => expect(enableRunner).toHaveBeenCalledWith("codex", true));
  await waitFor(() =>
    expect(screen.getByLabelText("Coding runner workspace access")).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByLabelText("Coding runner workspace access"));
  await waitFor(() =>
    expect(runnerGrant).toHaveBeenCalledWith("profile", {
      runner: "codex",
      workspace: true,
      inference: false,
    }),
  );
});

it("keeps manual OpenCode setup available without an OpenRouter default", async () => {
  const probe = {
    executableHash: "hash",
    interface: "acp-v1",
    command: "/usr/bin/opencode",
    agent: { name: "OpenCode", version: "2.2.5" },
  };
  const runnerSetup = vi
    .fn()
    .mockResolvedValue({ probes: [probe], installations: [], registry: null });
  const probeRunner = vi.fn().mockResolvedValue(probe);
  render(
    <RunnerSetup
      client={
        {
          runnerSetup,
          probeRunner,
          discoverRunners: vi.fn().mockResolvedValue({
            executables: [
              { name: "codex", command: "/detected/codex" },
              { name: "opencode", command: "/detected/opencode" },
            ],
          }),
        } as unknown as ApiClient
      }
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Set up OpenCode" }));
  expect(probeRunner).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Runner probe interface")).toHaveValue("acp-v1");
  expect(screen.getByLabelText("Agent arguments")).toHaveValue('["acp"]');
  fireEvent.change(screen.getByLabelText("Agent executable path"), {
    target: { value: "/usr/bin/opencode" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Probe installed agent" }));
  await waitFor(() =>
    expect(probeRunner).toHaveBeenCalledWith({
      interface: "acp-v1",
      command: "/usr/bin/opencode",
      args: ["acp"],
    }),
  );
  expect(await screen.findByLabelText("Agent registry identity")).toHaveValue("acp:opencode");
  expect(screen.getByLabelText("Agent credential type")).toHaveValue("OPENAI_API_KEY");
  expect(screen.getByLabelText("Agent inference hosts")).toHaveValue("api.openai.com");
});

it.each(["codex", "opencode"] as const)(
  "connects %s with one action and no credential fields",
  async (runner) => {
    const connectRunner = vi.fn().mockResolvedValue(undefined);
    const runnerSetup = vi
      .fn()
      .mockResolvedValue({ probes: [], installations: [], registry: null });
    const configureRunner = vi.fn();
    render(
      <RunnerSetup
        client={
          {
            connectRunner,
            runnerSetup,
            configureRunner,
            discoverRunners: vi.fn().mockResolvedValue({
              executables: [
                { name: "codex", command: "/detected/codex" },
                { name: "opencode", command: "/detected/opencode" },
              ],
            }),
          } as unknown as ApiClient
        }
      />,
    );
    const advanced = screen.getByText("Advanced setup").closest("details");
    expect(advanced).not.toHaveAttribute("open");
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: `Connect ${runner === "codex" ? "Codex" : "OpenCode"}`,
        }),
      ).toBeEnabled(),
    );
    expect(screen.getByTitle(`/detected/${runner}`)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: `Connect ${runner === "codex" ? "Codex" : "OpenCode"}` }),
    );
    await waitFor(() => expect(connectRunner).toHaveBeenCalledWith(runner));
    expect(await screen.findByRole("status")).toHaveTextContent("connected");
    expect(configureRunner).not.toHaveBeenCalled();
  },
);
it("shows actionable native sign-in failures without claiming connection succeeded", async () => {
  render(
    <RunnerSetup
      client={
        {
          runnerSetup: vi.fn().mockResolvedValue({ probes: [], installations: [], registry: null }),
          connectRunner: vi.fn().mockRejectedValue(new Error("Run codex login, then reconnect.")),
          discoverRunners: vi.fn().mockResolvedValue({
            executables: [
              { name: "codex", command: "/detected/codex" },
              { name: "opencode", command: "/detected/opencode" },
            ],
          }),
        } as unknown as ApiClient
      }
    />,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Connect Codex" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("codex login");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("rescans a missing executable without reading credentials or connecting", async () => {
  const discoverRunners = vi
    .fn()
    .mockResolvedValueOnce({ executables: [] })
    .mockResolvedValue({ executables: [{ name: "codex", command: "/new/tools/codex" }] });
  const connectRunner = vi.fn();
  render(
    <RunnerSetup
      client={
        {
          discoverRunners,
          connectRunner,
          runnerSetup: vi.fn().mockResolvedValue({ probes: [], installations: [], registry: null }),
        } as unknown as ApiClient
      }
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Detect executables" })).toBeEnabled(),
  );
  expect(screen.getByRole("button", { name: "Connect Codex" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Detect executables" }));
  expect(await screen.findByTitle("/new/tools/codex")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Connect Codex" })).toBeEnabled());
  expect(connectRunner).not.toHaveBeenCalled();
});
