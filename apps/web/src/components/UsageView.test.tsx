import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageReport, UsageSummary } from "@vektor/shared";
import { ApiClient } from "../lib/api";
import { UsageView } from "./UsageView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const totals: UsageSummary = {
  runs: 2,
  completed: 1,
  failed: 1,
  cancelled: 0,
  running: 0,
  runsWithUsage: 1,
  runsWithoutUsage: 1,
  promptTokens: 12,
  completionTokens: 3,
  totalTokens: 15,
  providerCalls: 2,
  reportedCalls: 1,
  pricedCalls: 1,
  incompleteCostRuns: 1,
  knownCostUsd: 0.002,
};
const report: UsageReport = {
  from: "2026-01-01T00:00:00Z",
  to: "2027-01-01T00:00:00Z",
  generatedAt: "2026-11-01T00:00:00Z",
  provider: "openrouter",
  totals,
  byProfile: [{ id: "profile", name: "Research profile", usage: totals }],
  byJob: [{ id: "job", name: "Daily briefing", usage: totals }],
};
describe("usage reporting UI", () => {
  it("loads an explicit UTC period and shows incomplete reported costs and attribution", async () => {
    const client = new ApiClient("test");
    const load = vi.spyOn(client, "usageReport").mockResolvedValue(report);
    render(<UsageView client={client} />);
    expect(load).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Usage from date"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Usage through date"), {
      target: { value: "2026-10-31" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load usage report" }));
    await screen.findByText("Research profile");
    expect(load).toHaveBeenCalledWith(
      "2026-10-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
      "openrouter",
    );
    expect(screen.getByText("Daily briefing")).toBeInTheDocument();
    expect(screen.getAllByText(/\$0\.002000 \+ unreported/)).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Usage provider"), { target: { value: "unknown" } });
    expect(screen.queryByText("Research profile")).not.toBeInTheDocument();
    load.mockResolvedValue({
      ...report,
      totals: { ...totals, knownCostUsd: null },
      byProfile: [],
      byJob: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Load usage report" }));
    await screen.findByText(/tokens · Unreported/);
    expect(load).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), "unknown");
  });
  it("shows provider errors without leaving a stale cost report", async () => {
    const client = new ApiClient("test");
    vi.spyOn(client, "usageReport").mockRejectedValue(new Error("Backend offline"));
    render(<UsageView client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Load usage report" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Backend offline"));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
