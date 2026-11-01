import { and, eq, gte, lt } from "drizzle-orm";
import type { VektorDatabase } from "./client.js";
import { runs, profiles, scheduledJobs } from "./schema.js";

export function usageRows(db: VektorDatabase, from: Date, to: Date, provider: string) {
  return db
    .select({
      id: runs.id,
      profileId: runs.profileId,
      profileName: profiles.name,
      jobId: runs.jobId,
      jobName: scheduledJobs.name,
      status: runs.status,
      usageJson: runs.usageJson,
      providerCalls: runs.providerCalls,
    })
    .from(runs)
    .leftJoin(profiles, eq(runs.profileId, profiles.id))
    .leftJoin(scheduledJobs, eq(runs.jobId, scheduledJobs.id))
    .where(
      and(
        gte(runs.startedAt, from),
        lt(runs.startedAt, to),
        provider === "all" ? undefined : eq(runs.provider, provider),
      ),
    )
    .all();
}
