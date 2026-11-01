import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { applyRunEvent, startLiveRun } from "../lib/live";
import { ApiClient } from "../lib/api";
import { MessageActivity, ToolActivity, RunContent } from "./MessageActivity";

afterEach(cleanup);
it("shows every call with separate status and expandable details", () => {
  render(
    <ToolActivity
      tools={[
        {
          id: "one",
          name: "browser.navigate",
          input: { url: "example.com" },
          status: "completed",
          output: "Loaded page",
        },
        { id: "two", name: "browser.navigate", input: {}, status: "waiting" },
      ]}
    />,
  );
  expect(screen.getAllByTitle("browser.navigate")).toHaveLength(2);
  expect(screen.getByText(/Awaiting approval/)).toBeInTheDocument();
  expect(screen.getByText("Loaded page")).toBeInTheDocument();
});
it("retains tool activity on saved messages", async () => {
  const client = new ApiClient("test");
  vi.spyOn(client, "runDetails").mockResolvedValue({
    tools: [
      { id: "one", name: "browser.navigate", input: {}, output: "Loaded", status: "completed" },
    ],
  } as Awaited<ReturnType<ApiClient["runDetails"]>>);
  render(<MessageActivity client={client} runId="run" />);
  expect(await screen.findByLabelText("Open page · Completed")).toBeInTheDocument();
  expect(client.runDetails).toHaveBeenCalledWith("run", true);
});

it("renders live and saved text around the tool at the original point in the reply", async () => {
  const events = [
    { runId: "run", seq: 1, type: "message.delta" as const, text: "Navigating now." },
    {
      runId: "run",
      seq: 2,
      type: "tool.requested" as const,
      toolCallId: "tool",
      name: "browser",
      input: {},
    },
    { runId: "run", seq: 3, type: "message.delta" as const, text: "Found it." },
  ];
  const live = events.reduce(applyRunEvent, startLiveRun("run"));
  const { container, unmount } = render(<RunContent live={{ ...live, status: "completed" }} />);
  expect(container.textContent).toMatch(/Navigating now\..*Browser.*Found it\./s);
  unmount();
  const client = new ApiClient("test");
  vi.spyOn(client, "runDetails").mockResolvedValue({
    transcript: events,
    tools: [{ id: "tool", name: "browser", input: {}, status: "completed", output: "Done" }],
  } as Awaited<ReturnType<ApiClient["runDetails"]>>);
  const saved = render(
    <MessageActivity client={client} runId="run" content="Navigating now.Found it." />,
  );
  await screen.findByLabelText("Browser · Completed");
  expect(saved.container.textContent).toMatch(/Navigating now\..*Browser.*Found it\./s);
});

it("shows thinking content under a collapsible Thinking title in live and saved replies", async () => {
  const events = [
    {
      runId: "run",
      seq: 1,
      type: "reasoning.delta" as const,
      text: "Compare the available options.",
    },
    { runId: "run", seq: 2, type: "message.delta" as const, text: "Choose the first option." },
  ];
  const live = events.reduce(applyRunEvent, startLiveRun("run"));
  expect(live.text).toBe("Choose the first option.");
  const { container, unmount } = render(<RunContent live={{ ...live, status: "completed" }} />);
  expect(screen.getByText("Thinking").closest("details")).toHaveAttribute("open");
  expect(container.textContent).toMatch(
    /Thinking.*Compare the available options\..*Choose the first option\./s,
  );
  unmount();
  const client = new ApiClient("test");
  vi.spyOn(client, "runDetails").mockResolvedValue({
    transcript: events,
    tools: [],
  } as unknown as Awaited<ReturnType<ApiClient["runDetails"]>>);
  render(<MessageActivity client={client} runId="run" content="Choose the first option." />);
  expect(await screen.findByText("Thinking")).toBeInTheDocument();
  expect(screen.getByText("Compare the available options.")).toBeInTheDocument();
});
