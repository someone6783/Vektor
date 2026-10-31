import { describe, expect, it } from "vitest";
import { normalizeSchedule, previewSchedule } from "./schedule.js";

describe("schedule parsing and time zones", () => {
  it.each([
    ["weekdays at 9am", "0 9 * * 1-5"],
    ["daily at 14:30", "30 14 * * *"],
    ["weekly on monday at 5:15pm", "15 17 * * 1"],
    ["every 15 minutes", "*/15 * * * *"],
    ["every 6 hours", "0 */6 * * *"],
    ["every 60 minutes", "0 * * * *"],
    ["every 24 hours", "0 0 * * *"],
    ["daily at 12am", "0 0 * * *"],
    ["daily at 12pm", "0 12 * * *"],
    ["0 9 * * 1-5", "0 9 * * 1-5"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeSchedule(input)).toBe(expected);
  });
  it.each([
    "every 7 minutes",
    "every 0 hours",
    "every 25 hours",
    "daily at 13pm",
    "daily at 9:75",
    "tomorrow morning",
    "* * * * * *",
    "@reboot",
  ])("rejects unsupported/ambiguous input %s", (input) => {
    expect(() => previewSchedule(input, "UTC")).toThrow();
  });
  it("computes weekday local time independently of the backend zone", () => {
    const preview = previewSchedule(
      "weekdays at 9am",
      "Australia/Perth",
      Date.parse("2026-10-30T00:00:00Z"),
    );
    expect(preview.nextRuns.slice(0, 2)).toEqual([
      "2026-10-30T01:00:00.000Z",
      "2026-11-02T01:00:00.000Z",
    ]);
  });
  it("keeps daily wall-clock time across spring and fall DST changes", () => {
    expect(
      previewSchedule("daily at 9am", "America/New_York", Date.parse("2026-03-07T14:00:00Z"), 1)
        .nextRuns,
    ).toEqual(["2026-03-08T13:00:00.000Z"]);
    expect(
      previewSchedule("daily at 9am", "America/New_York", Date.parse("2026-10-31T13:00:00Z"), 1)
        .nextRuns,
    ).toEqual(["2026-11-01T14:00:00.000Z"]);
  });
  it("rejects impossible cron dates and invalid/ambiguous zones", () => {
    expect(() => previewSchedule("61 * * * *", "UTC")).toThrow("invalid");
    expect(() => previewSchedule("0 0 30 2 *", "UTC")).toThrow();
    expect(() => previewSchedule("hourly", "Mars/Local")).toThrow("IANA");
    expect(() => previewSchedule("hourly", "PST")).toThrow("IANA");
  });
  it("shifts a missing spring-forward time and does not repeat a fall-back local time", () => {
    expect(
      previewSchedule("daily at 2:30am", "America/New_York", Date.parse("2026-03-07T08:00:00Z"), 2)
        .nextRuns,
    ).toEqual(["2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
    expect(
      previewSchedule("daily at 1:30am", "America/New_York", Date.parse("2026-10-31T07:00:00Z"), 2)
        .nextRuns,
    ).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  });
});
