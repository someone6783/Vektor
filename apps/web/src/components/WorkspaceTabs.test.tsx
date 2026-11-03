import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "../lib/api";
import { WorkspaceTabs } from "./WorkspaceTabs";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

it("opens, reuses and closes file tabs while preserving Git and Context state", async () => {
  const client = new ApiClient("token");
  vi.spyOn(client, "gitStatus").mockResolvedValue({
    repository: true,
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [{ path: "a.txt", index: " ", worktree: "M", untracked: false }],
    filesTruncated: false,
    lastCommit: null,
  });
  vi.spyOn(client, "gitDiff").mockResolvedValue({ diff: "-old\n+new\n", truncated: false });
  vi.spyOn(client, "gitFile").mockResolvedValue({ content: "new\n", truncated: false });
  function Harness() {
    const [active, select] = useState("context");
    return (
      <WorkspaceTabs client={client} activeTab={active} onSelect={select} onClose={() => {}}>
        <input aria-label="Context draft" />
      </WorkspaceTabs>
    );
  }
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("Context draft"), { target: { value: "keep me" } });
  fireEvent.keyDown(screen.getByRole("tab", { name: "Context" }), { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "Git" })).toHaveFocus();
  fireEvent.change(screen.getByLabelText("Project directory"), { target: { value: "/repo" } });
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  fireEvent.click(await screen.findByRole("button", { name: "a.txt" }));
  expect(await screen.findByLabelText("File diff")).toHaveTextContent("+new");
  fireEvent.click(screen.getByRole("button", { name: "Raw" }));
  expect(await screen.findByLabelText("Raw file content")).toHaveTextContent("new");
  fireEvent.click(screen.getByRole("tab", { name: "Git" }));
  fireEvent.click(screen.getByRole("button", { name: "a.txt" }));
  expect(screen.getAllByRole("tab", { name: "a.txt" })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Raw" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Close a.txt" }));
  expect(screen.queryByRole("tab", { name: "a.txt" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Git" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("tab", { name: "Context" }));
  expect(screen.getByLabelText("Context draft")).toHaveValue("keep me");
  await waitFor(() => expect(client.gitStatus).toHaveBeenCalledTimes(1));
});
