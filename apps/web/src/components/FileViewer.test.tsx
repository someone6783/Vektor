import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "../lib/api";
import { FileViewer } from "./FileViewer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("discards stale diff responses and refreshes raw content, with error and truncation feedback", async () => {
  const client = new ApiClient("token");
  let finishDiff!: (value: { diff: string; truncated: boolean }) => void;
  vi.spyOn(client, "gitDiff").mockReturnValue(
    new Promise((resolve) => {
      finishDiff = resolve;
    }),
  );
  vi.spyOn(client, "gitFile")
    .mockResolvedValueOnce({ content: "current", truncated: true })
    .mockRejectedValueOnce(new Error("File was removed"))
    .mockResolvedValueOnce({ content: "restored", truncated: false });
  render(<FileViewer client={client} path="/repo" file="a.txt" />);
  fireEvent.click(screen.getByRole("button", { name: "Raw" }));
  expect(await screen.findByLabelText("Raw file content")).toHaveTextContent("current");
  expect(screen.getByRole("status")).toHaveTextContent("truncated");
  finishDiff({ diff: "stale diff", truncated: false });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("File was removed");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByLabelText("Raw file content")).toHaveTextContent("restored");
  expect(screen.queryByText("stale diff")).toBeNull();
});
