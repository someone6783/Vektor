import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color").notNull().default("emerald"),
  systemPrompt: text("system_prompt").notNull().default(""),
  model: text("model").notNull(),
  paramsJson: text("params_json").notNull().default("{}"),
  terminalMode: text("terminal_mode").notNull().default("no-terminal"),
  toolsJson: text("tools_json").notNull().default("[]"),
  browserJson: text("browser_json")
    .notNull()
    .default('{"mode":"off","allowedOrigins":[],"localOrigins":[]}'),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
});

export const channels = sqliteTable(
  "channels",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    topic: text("topic").notNull().default(""),
    kind: text("kind").notNull().default("channel"),
    profileId: text("profile_id").references(() => profiles.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("channels_archived_idx").on(table.archivedAt)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    status: text("status").notNull().default("complete"),
    runId: text("run_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("messages_channel_created_idx").on(table.channelId, table.createdAt)],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "set null" }),
    userMessageId: text("user_message_id").notNull(),
    model: text("model").notNull(),
    runner: text("runner").notNull().default("native"),
    provider: text("provider").notNull().default("unknown"),
    providerCalls: integer("provider_calls").notNull().default(0),
    jobId: text("job_id"),
    status: text("status").notNull().default("running"),
    error: text("error"),
    usageJson: text("usage_json"),
    contextJson: text("context_json"),
    includeHistory: integer("include_history", { mode: "boolean" }).notNull().default(true),
    terminalMode: text("terminal_mode").notNull().default("no-terminal"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("runs_channel_status_idx").on(table.channelId, table.status)],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("run_events_run_seq_idx").on(table.runId, table.seq)],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    kind: text("kind").notNull(),
    included: integer("included", { mode: "boolean" }).notNull().default(true),
    extractedText: text("extracted_text").notNull().default(""),
    width: integer("width"),
    height: integer("height"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("attachments_channel_idx").on(table.channelId)],
);

export const messageAttachments = sqliteTable(
  "message_attachments",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => attachments.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("message_attachments_pair_idx").on(table.messageId, table.attachmentId)],
);

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    providerCallId: text("provider_call_id").notNull(),
    name: text("name").notNull(),
    inputJson: text("input_json").notNull(),
    output: text("output").notNull().default(""),
    status: text("status").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("tool_calls_run_idx").on(table.runId)],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id")
      .notNull()
      .references(() => toolCalls.id, { onDelete: "cascade" }),
    command: text("command").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("approvals_status_idx").on(table.status)],
);

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  action: text("action").notNull(),
  runId: text("run_id"),
  detailsJson: text("details_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const scheduledJobs = sqliteTable(
  "scheduled_jobs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    schedule: text("schedule").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    prompt: text("prompt").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    catchUp: integer("catch_up", { mode: "boolean" }).notNull().default(false),
    includeHistory: integer("include_history", { mode: "boolean" }).notNull().default(false),
    allowTruncation: integer("allow_truncation", { mode: "boolean" }).notNull().default(false),
    browserAccess: text("browser_access").notNull().default("off"),
    nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
    leaseOwner: text("lease_owner"),
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    version: integer("version").notNull().default(1),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("scheduled_jobs_due_idx").on(table.enabled, table.nextRunAt)],
);

export const jobRuns = sqliteTable(
  "job_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id")
      .notNull()
      .references(() => scheduledJobs.id),
    runId: text("run_id").references(() => runs.id),
    occurrenceKey: text("occurrence_key").notNull(),
    scheduledFor: integer("scheduled_for", { mode: "timestamp_ms" }).notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("job_runs_occurrence_idx").on(table.jobId, table.occurrenceKey),
    index("job_runs_run_idx").on(table.runId),
  ],
);

export const schedulerLease = sqliteTable("scheduler_lease", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export const browserArtifacts = sqliteTable(
  "browser_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    origin: text("origin").notNull(),
    jpeg: text("jpeg").notNull(),
    size: integer("size").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("browser_artifacts_run_idx").on(table.runId)],
);
