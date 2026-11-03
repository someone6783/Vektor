import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatus } from "@vektor/shared";
import { ApiClient } from "../lib/api";
import { GitView } from "./GitView";

const status: GitStatus = {
  repository: true,
  branch: "main",
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  files: [
    { path: "a.txt", index: " ", worktree: "M", untracked: false },
    { path: "b.txt", index: "?", worktree: "?", untracked: true },
  ],
  filesTruncated: false,
  lastCommit: { hash: "abc1234", subject: "first commit", time: "2026-01-01T00:00:00.000Z" },
};

let client: ApiClient;

beforeEach(() => {
  client = new ApiClient("test-token");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function loadProject(path = "/repo") {
  fireEvent.change(screen.getByLabelText("Project directory"), {
    target: { value: path },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  return waitFor(() => expect(screen.getByRole("heading", { name: "Branch" })).toBeTruthy());
}

describe("GitView", () => {
  it("asks for an absolute path and reports non-repositories", async () => {
    render(<GitView client={client} />);
    fireEvent.change(screen.getByLabelText("Project directory"), { target: { value: "relative" } });
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("absolute path");

    vi.spyOn(client, "gitStatus").mockResolvedValue({ ...status, repository: false });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Project directory"), { target: { value: "/plain" } });
      fireEvent.click(screen.getByRole("button", { name: "Load" }));
    });
    expect(await screen.findByText("This directory is not inside a git repository.")).toBeTruthy();
  });

  it("loads changes, selects files, then commits with a message", async () => {
    const gitCommit = vi
      .spyOn(client, "gitCommit")
      .mockResolvedValue({ ok: true, commit: "def5678", branch: "main" });
    const clean: GitStatus = {
      ...status,
      ahead: 0,
      files: [],
      lastCommit: { hash: "def5678", subject: "panel commit", time: "2026-01-01T00:00:00.000Z" },
    };
    vi.spyOn(client, "gitStatus").mockResolvedValueOnce(status).mockResolvedValue(clean);
    render(<GitView client={client} />);
    await loadProject();

    expect(screen.getByText("Last commit abc1234 · first commit")).toBeTruthy();
    expect(screen.getByLabelText("Stage a.txt")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.change(screen.getByLabelText("Commit message"), {
      target: { value: "panel commit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit 2" }));

    await waitFor(() =>
      expect(gitCommit).toHaveBeenCalledWith("/repo", "panel commit", ["a.txt", "b.txt"]),
    );
    expect(await screen.findByText(/Committed def5678 on main/)).toBeTruthy();
    expect(screen.getByText("Working tree is clean.")).toBeTruthy();
  });

  it("pushes the branch to its remote", async () => {
    vi.spyOn(client, "gitStatus").mockResolvedValue(status);
    const gitPush = vi
      .spyOn(client, "gitPush")
      .mockResolvedValue({ ok: true, branch: "main", upstream: "origin/main" });
    render(<GitView client={client} />);
    await loadProject();

    fireEvent.click(screen.getByRole("button", { name: "Push to remote" }));
    await waitFor(() => expect(gitPush).toHaveBeenCalledWith("/repo"));
    expect(await screen.findByText("Pushed main to origin/main.")).toBeTruthy();
  });

  it("rejects commits while the message is empty", async () => {
    vi.spyOn(client, "gitStatus").mockResolvedValue(status);
    const gitCommit = vi.spyOn(client, "gitCommit");
    render(<GitView client={client} />);
    await loadProject();

    const commit = screen.getByRole("button", { name: /^Commit/ });
    expect(commit).toHaveProperty("disabled", true);
    expect(gitCommit).not.toHaveBeenCalled();
  });
});
