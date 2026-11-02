import type { Profile } from "@vektor/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerSetup } from "./RunnerSetup";
import type { ApiClient } from "../lib/api";

afterEach(cleanup);

describe("runner setup", () => {
  it("loads only on explicit action and never executes registry metadata", async () => {
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
    render(<RunnerSetup client={{ runnerSetup, probeRunner } as unknown as ApiClient} />);
    expect(runnerSetup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load setup" }));
    expect(await screen.findByText(/Test agent · 1.0.0/)).toBeInTheDocument();
    expect(screen.getByText(/Unverified \/ unavailable/)).toBeInTheDocument();
    expect(probeRunner).not.toHaveBeenCalled();
  });
  it("requires an absolute executable path and shows probe failures without enabling execution", async () => {
    const probeRunner = vi.fn().mockRejectedValue(new Error("Unsupported agent version"));
    render(<RunnerSetup client={{ probeRunner } as unknown as ApiClient} />);
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
      client={{ runnerSetup, runnerCredential, enableRunner, runnerGrant } as unknown as ApiClient}
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
