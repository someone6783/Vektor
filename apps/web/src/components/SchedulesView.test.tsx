import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, JobRun, Profile, ScheduledJob, SchedulerState } from "@vektor/shared";
import { ApiClient } from "../lib/api";
import { SchedulesView } from "./SchedulesView";

const date = "2026-11-02T01:00:00.000Z";
const profile: Profile = {
  id: "profile",
  name: "Assistant",
  color: "emerald",
  systemPrompt: "",
  model: "test",
  temperature: 0.7,
  maxTokens: 2048,
  terminalMode: "no-terminal",
  tools: [],
  createdAt: date,
  updatedAt: date,
  archivedAt: null,
};
const channel: Channel = {
  id: "channel",
  name: "Reports",
  topic: "",
  kind: "channel",
  profileId: "profile",
  createdAt: date,
  updatedAt: date,
  archivedAt: null,
};
const initialJob: ScheduledJob = {
  id: "job",
  name: "Daily report",
  schedule: "weekdays at 9am",
  cron: "0 9 * * 1-5",
  timezone: "Australia/Perth",
  prompt: "Write a report",
  profileId: "profile",
  channelId: "channel",
  enabled: true,
  catchUp: false,
  includeHistory: false,
  allowTruncation: false,
  mcpServers: [],
  nextRunAt: date,
  lastStatus: null,
  lastError: null,
  createdAt: date,
  updatedAt: date,
  deletedAt: null,
};
let client: ApiClient;
let jobs: ScheduledJob[];
let state: SchedulerState;
beforeEach(() => {
  client = new ApiClient("test");
  jobs = [{ ...initialJob }];
  state = { enabled: true, paused: false, emergencyStopped: false, tickMs: 1000 };
  vi.spyOn(client, "listJobs").mockImplementation(async (includeDeleted) =>
    jobs.filter((job) => includeDeleted || !job.deletedAt),
  );
  vi.spyOn(client, "schedulerState").mockImplementation(async () => state);
  vi.spyOn(client, "previewSchedule").mockImplementation(async (schedule, timezone) => {
    if (schedule === "invalid") throw new Error("Invalid schedule");
    return {
      cron: "0 9 * * 1-5",
      timezone,
      nextRuns: [date],
      explanation: "Preview in the chosen time zone",
    };
  });
  vi.spyOn(client, "createJob").mockImplementation(async (input) => {
    const created = { ...initialJob, ...input, id: "new-job" };
    jobs = [...jobs, created];
    return created;
  });
  vi.spyOn(client, "updateJob").mockImplementation(async (id, input) => {
    const updated = {
      ...jobs.find((job) => job.id === id)!,
      ...input,
      ...(input.enabled === false ? { nextRunAt: null } : {}),
    };
    jobs = jobs.map((job) => (job.id === id ? updated : job));
    return updated;
  });
  vi.spyOn(client, "deleteJob").mockImplementation(async (id) => {
    jobs = jobs.map((job) =>
      job.id === id ? { ...job, deletedAt: date, enabled: false, nextRunAt: null } : job,
    );
  });
  vi.spyOn(client, "pauseScheduler").mockImplementation(async () => {
    state = { ...state, paused: true };
    return state;
  });
  vi.spyOn(client, "resumeScheduler").mockImplementation(async () => {
    state = { ...state, paused: false };
    return state;
  });
  vi.spyOn(client, "runJob").mockResolvedValue({
    id: 1,
    jobId: "job",
    runId: "run",
    scheduledFor: date,
    startedAt: date,
    endedAt: null,
    source: "manual",
    status: "running",
    error: null,
    awaitingApproval: false,
  });
  vi.spyOn(client, "jobHistory").mockResolvedValue({ executions: [], nextBefore: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function setup(onOpenChannel = vi.fn()) {
  return render(
    <SchedulesView
      client={client}
      profiles={[profile]}
      channels={[channel]}
      onOpenChannel={onOpenChannel}
    />,
  );
}

describe("scheduling workspace", () => {
  it("previews a local schedule and saves explicit profile, channel and context choices", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "New job" }));
    fireEvent.change(screen.getByLabelText("Job name"), { target: { value: "Morning briefing" } });
    fireEvent.change(screen.getByLabelText("Job prompt"), {
      target: { value: "Summarize today's work" },
    });
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Australia/Perth" } });
    await screen.findByText(/Next runs in Australia\/Perth/);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Catch up missed runs once after downtime" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save job" }));
    await waitFor(() =>
      expect(client.createJob).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Morning briefing",
          schedule: "weekdays at 9am",
          timezone: "Australia/Perth",
          profileId: "profile",
          channelId: "channel",
          includeHistory: false,
          allowTruncation: false,
          catchUp: true,
        }),
      ),
    );
    await screen.findByRole("heading", { name: "Morning briefing" });
  });

  it("edits, pauses a job and pauses/resumes the global scheduler", async () => {
    setup();
    await screen.findByRole("heading", { name: "Daily report" });
    fireEvent.click(screen.getByRole("button", { name: "Pause job" }));
    await waitFor(() => expect(client.updateJob).toHaveBeenCalledWith("job", { enabled: false }));
    await screen.findByRole("button", { name: "Resume job" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Job prompt"), { target: { value: "Updated report" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include recent channel history" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Allow older history/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save job" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save job" }));
    await waitFor(() =>
      expect(client.updateJob).toHaveBeenLastCalledWith(
        "job",
        expect.objectContaining({
          prompt: "Updated report",
          includeHistory: true,
          allowTruncation: true,
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause scheduler" }));
    await screen.findByRole("button", { name: "Resume scheduler" });
    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Resume scheduler" }));
    await waitFor(() => expect(client.resumeScheduler).toHaveBeenCalled());
  });

  it("rejects invalid schedules and blocks manual execution during emergency stop", async () => {
    state.emergencyStopped = true;
    setup();
    await screen.findByText(/Emergency stop is active/);
    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "invalid" } });
    await screen.findByText("Invalid schedule");
    expect(screen.getByRole("button", { name: "Save job" })).toBeDisabled();
  });

  it("shows durable failure/approval history, paginates and opens the delivery channel", async () => {
    const open = vi.fn();
    const execution: JobRun = {
      id: 2,
      jobId: "job",
      runId: "run",
      scheduledFor: date,
      startedAt: date,
      endedAt: null,
      status: "running",
      source: "schedule",
      error: null,
      awaitingApproval: true,
    };
    vi.mocked(client.jobHistory).mockImplementation(async (_id, before) => ({
      executions: before
        ? [
            {
              ...execution,
              id: 1,
              status: "failed",
              error: "Provider unavailable",
              awaitingApproval: false,
            },
          ]
        : [execution],
      nextBefore: before ? null : 2,
    }));
    setup(open);
    await screen.findByRole("heading", { name: "Daily report" });
    fireEvent.click(screen.getByRole("button", { name: "Inspect history" }));
    await screen.findByText(/Waiting for approval/);
    fireEvent.click(screen.getByRole("button", { name: "Earlier executions" }));
    await screen.findByText("Provider unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Open delivery channel" }));
    expect(open).toHaveBeenCalledWith("channel");
  });

  it("runs on demand and retains history after deleting the schedule", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setup();
    await screen.findByRole("heading", { name: "Daily report" });
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(client.runJob).toHaveBeenCalledWith("job"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete job" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Delete job" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Daily report" })).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Show deleted jobs and their history" }));
    await screen.findByRole("heading", { name: "Daily report" });
    expect(screen.getByText("Deleted")).toBeInTheDocument();
  });
});
