import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageQueue } from "./MessageQueue";
import type { useMessageQueue } from "../lib/useMessageQueue";

afterEach(cleanup);
it("offers Steer and Remove alongside the preview and disables steering while paused", () => {
  const queue: ReturnType<typeof useMessageQueue> = {
    items: [
      {
        id: "queued",
        channelId: "chat",
        content: "Change direction",
        attachmentIds: [],
        allowTruncation: false,
        retry: 0,
      },
    ],
    sendingId: null,
    enqueue: vi.fn(),
    remove: vi.fn(),
    retry: vi.fn(),
    steer: vi.fn(),
  };
  const { rerender } = render(<MessageQueue queue={queue} channels={[]} paused={false} />);
  const steer = screen.getByRole("button", { name: "Steer" });
  expect(screen.getByText("Change direction")).toHaveAttribute("title", "Change direction");
  fireEvent.click(screen.getByRole("button", { name: "Remove queued message" }));
  expect(queue.remove).toHaveBeenCalledWith("queued");
  fireEvent.click(steer);
  expect(queue.steer).toHaveBeenCalledWith("queued");
  rerender(<MessageQueue queue={queue} channels={[]} paused />);
  expect(steer).toBeDisabled();
});

it.each([
  { errorCode: "runner_permissions", error: "Codex needs approved tools." },
  {
    error:
      "External runners currently require Full access with the terminal tool enabled. No-terminal, Basic and Full Unrestricted mappings are unsupported.",
  },
  { errorCode: "runner_grants", error: "Missing agent access." },
])(
  "offers an actionable review for permission errors without unrelated history controls",
  (failure) => {
    const item = {
      id: "blocked",
      channelId: "chat",
      content: "Hello",
      attachmentIds: [],
      allowTruncation: false,
      retry: 0,
      runner: "codex" as const,
      ...failure,
    };
    const queue: ReturnType<typeof useMessageQueue> = {
      items: [item],
      sendingId: null,
      enqueue: vi.fn(),
      remove: vi.fn(),
      retry: vi.fn(),
      steer: vi.fn(),
    };
    const review = vi.fn();
    render(
      <MessageQueue queue={queue} channels={[]} paused={false} onReviewPermissions={review} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Review permissions to continue.");
    expect(screen.queryByText(/mappings are unsupported/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/omitting older history/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review permissions" }));
    expect(review).toHaveBeenCalledWith(item);
    expect(queue.retry).not.toHaveBeenCalled();
    expect(screen.getByText("Hello")).toBeInTheDocument();
  },
);
