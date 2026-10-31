import { CronExpressionParser } from "cron-parser";
import type { SchedulePreview } from "@vektor/shared";
import { RuntimeError } from "../runtime/terminal.js";

const DAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};
function time(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(value.trim());
  if (!match) throw new RuntimeError("Use a time such as 9am, 5:30pm, or 14:00.");
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23))
    throw new RuntimeError("Schedule time is outside the valid clock range.");
  if (match[3]) hour = (hour % 12) + (match[3] === "pm" ? 12 : 0);
  return { hour, minute };
}
export function normalizeSchedule(schedule: string): string {
  const value = schedule.trim().toLowerCase().replace(/\s+/g, " ");
  if (value === "hourly" || value === "@hourly") return "0 * * * *";
  if (value === "daily" || value === "@daily") return "0 0 * * *";
  if (value === "every minute") return "* * * * *";
  const interval = /^every (\d{1,2}) (minutes?|hours?)$/.exec(value);
  if (interval) {
    const count = Number(interval[1]);
    const hours = interval[2]!.startsWith("hour");
    const span = hours ? 24 : 60;
    if (count < 1 || count > span || span % count !== 0)
      throw new RuntimeError(
        `Friendly intervals must divide evenly into ${span} ${hours ? "hours" : "minutes"}; use a cron expression for other schedules.`,
      );
    return hours
      ? `0 ${count === 24 ? "0" : `*/${count}`} * * *`
      : `${count === 60 ? "0" : `*/${count}`} * * * *`;
  }
  const daily = /^(daily|every day|weekdays) at (.+)$/.exec(value);
  if (daily) {
    const clock = time(daily[2]!);
    return `${clock.minute} ${clock.hour} * * ${daily[1] === "weekdays" ? "1-5" : "*"}`;
  }
  const weekly =
    /^(?:weekly on|every) (sunday|monday|tuesday|wednesday|thursday|friday|saturday) at (.+)$/.exec(
      value,
    );
  if (weekly) {
    const clock = time(weekly[2]!);
    return `${clock.minute} ${clock.hour} * * ${DAYS[weekly[1]!]}`;
  }
  if (value.split(" ").length === 5 && /^[\d*,/\- ]+$/.test(value)) return value;
  throw new RuntimeError(
    "Use a five-field numeric cron expression, 'weekdays at 9am', 'daily at 14:00', 'weekly on monday at 9am', or 'every 15 minutes'.",
  );
}

export function previewSchedule(
  schedule: string,
  timezone: string,
  now = Date.now(),
  count = 5,
): SchedulePreview {
  try {
    if (timezone !== "UTC" && !timezone.includes("/")) throw new Error("invalid zone");
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(now);
  } catch {
    throw new RuntimeError(
      "Choose UTC or a valid IANA time zone, such as Australia/Perth or America/New_York.",
    );
  }
  const cron = normalizeSchedule(schedule);
  try {
    const expression = CronExpressionParser.parse(cron, {
      currentDate: new Date(now),
      tz: timezone,
    });
    const nextRuns = expression.take(count).map((date) => date.toDate().toISOString());
    return {
      cron,
      timezone,
      nextRuns,
      explanation: `Five-field cron ${cron}, evaluated in ${timezone}. Clock changes follow the time zone's daylight-saving rules; the preview shows actual upcoming instants.`,
    };
  } catch {
    throw new RuntimeError(
      "This cron expression is invalid or has no upcoming occurrence. Check minute/hour/day/month/weekday values.",
    );
  }
}

export function nextOccurrence(cron: string, timezone: string, now: number): number {
  return Date.parse(previewSchedule(cron, timezone, now, 1).nextRuns[0]!);
}
