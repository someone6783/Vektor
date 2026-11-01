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
