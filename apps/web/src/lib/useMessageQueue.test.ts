import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MessagesResponse, SendMessageResponse } from "@vektor/shared";
import { ApiClient } from "./api";
import { useMessageQueue } from "./useMessageQueue";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const item = {
  channelId: "chat",
  content: "First",
  attachmentIds: ["file"],
  allowTruncation: false,
  model: "model",
  reasoning: "high" as const,
};
const page = (active: boolean) =>
  ({ activeRun: active ? { id: "running" } : null }) as MessagesResponse;
const response = { run: { id: "new" }, message: { id: "saved" } } as SendMessageResponse;
it("accepts multiple messages while busy and sends in order using each message's channel and model", async () => {
  const client = new ApiClient("test");
  const list = vi.spyOn(client, "listMessages").mockResolvedValue(page(true));
  const send = vi.spyOn(client, "sendMessage").mockResolvedValue(response);
  const sent = vi.fn();
  const { result } = renderHook(() => useMessageQueue(client, false, sent));
  act(() => {
    result.current.enqueue(item);
    result.current.enqueue({ ...item, channelId: "other", content: "Second" });
  });
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  expect(result.current.items).toHaveLength(2);
  expect(send).not.toHaveBeenCalled();
  list.mockResolvedValue(page(false));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2), { timeout: 2000 });
  expect(send.mock.calls.map((call) => [call[0], call[1], call[5]])).toEqual([
    ["chat", "First", "model"],
    ["other", "Second", "model"],
  ]);
  expect(send.mock.calls.map((call) => call[6])).toEqual(["high", "high"]);
  expect(sent).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(result.current.items).toHaveLength(0));
});
it("retains a rejected draft and retries only with explicit consent", async () => {
  const client = new ApiClient("test");
  vi.spyOn(client, "listMessages").mockResolvedValue(page(false));
  const send = vi
    .spyOn(client, "sendMessage")
    .mockRejectedValueOnce(new Error("Confirm omitting older history"))
    .mockResolvedValue(response);
  const { result } = renderHook(() => useMessageQueue(client, false, vi.fn()));
  act(() => result.current.enqueue(item));
  await waitFor(() => expect(result.current.items[0]?.error).toContain("Confirm"));
  expect(result.current.items[0]?.content).toBe("First");
  act(() => result.current.retry(result.current.items[0]!.id, true));
  await waitFor(() => expect(result.current.items).toHaveLength(0));
  expect(send.mock.calls[1]?.[4]).toBe(true);
});
it("holds submissions during emergency stop and resumes without duplicating pending requests", async () => {
  const client = new ApiClient("test");
  vi.spyOn(client, "listMessages").mockResolvedValue(page(false));
  const send = vi.spyOn(client, "sendMessage").mockResolvedValue(response);
  const { result, rerender } = renderHook(
    ({ paused }) => useMessageQueue(client, paused, vi.fn()),
    { initialProps: { paused: true } },
  );
  act(() => result.current.enqueue(item));
  expect(send).not.toHaveBeenCalled();
  rerender({ paused: false });
  await waitFor(() => expect(result.current.items).toHaveLength(0));
  expect(send).toHaveBeenCalledOnce();
});

it("does not duplicate an in-flight send when more messages arrive", async () => {
  const client = new ApiClient("test");
  vi.spyOn(client, "listMessages").mockResolvedValue(page(false));
  let finish!: (value: SendMessageResponse) => void;
  const send = vi
    .spyOn(client, "sendMessage")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(response);
  const { result } = renderHook(() => useMessageQueue(client, false, vi.fn()));
  act(() => result.current.enqueue(item));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  act(() => result.current.enqueue({ ...item, content: "Second" }));
  expect(result.current.items).toHaveLength(2);
  expect(send).toHaveBeenCalledOnce();
  await act(async () => finish(response));
  await waitFor(() => expect(result.current.items).toHaveLength(0));
  expect(send).toHaveBeenCalledTimes(2);
});

it("steers a selected message ahead of the queue, cancels once and waits for the active run to finish", async () => {
  const client = new ApiClient("test");
  const list = vi.spyOn(client, "listMessages").mockResolvedValue(page(true));
  const cancel = vi.spyOn(client, "cancelRun").mockResolvedValue(undefined);
  const send = vi.spyOn(client, "sendMessage").mockResolvedValue(response);
  const { result } = renderHook(() => useMessageQueue(client, false, vi.fn()));
  act(() => {
    result.current.enqueue(item);
    result.current.enqueue({ ...item, content: "Change direction" });
  });
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  act(() => result.current.steer(result.current.items[1]!.id));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith("running"));
  expect(result.current.items[0]?.content).toBe("Change direction");
  expect(send).not.toHaveBeenCalled();
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
  expect(cancel).toHaveBeenCalledOnce();
  list.mockResolvedValue(page(false));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2), { timeout: 2000 });
  expect(send.mock.calls.map((call) => call[1])).toEqual(["Change direction", "First"]);
});

it("retains the message if interruption fails without sending it or later messages", async () => {
  const client = new ApiClient("test");
  vi.spyOn(client, "listMessages").mockResolvedValue(page(true));
  const cancel = vi.spyOn(client, "cancelRun").mockRejectedValue(new Error("Cannot stop run"));
  const send = vi.spyOn(client, "sendMessage").mockResolvedValue(response);
  const { result, rerender } = renderHook(
    ({ paused }) => useMessageQueue(client, paused, vi.fn()),
    { initialProps: { paused: true } },
  );
  act(() => result.current.enqueue(item));
  act(() => result.current.steer(result.current.items[0]!.id));
  expect(cancel).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  rerender({ paused: false });
  act(() => result.current.steer(result.current.items[0]!.id));
  await waitFor(() => expect(result.current.items[0]?.error).toBe("Cannot stop run"));
  expect(result.current.items[0]?.content).toBe("First");
  expect(send).not.toHaveBeenCalled();
});

it("accepts and sends messages when crypto.randomUUID is unavailable", async () => {
  const original = globalThis.crypto;
  vi.stubGlobal("crypto", {});
  try {
    const client = new ApiClient("test");
    vi.spyOn(client, "listMessages").mockResolvedValue(page(false));
    const send = vi.spyOn(client, "sendMessage").mockResolvedValue(response);
    const { result } = renderHook(() => useMessageQueue(client, false, vi.fn()));
    act(() => result.current.enqueue(item));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
  } finally {
    vi.stubGlobal("crypto", original);
  }
});
