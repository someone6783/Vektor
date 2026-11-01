import {
  browserStateSchema,
  browserArtifactSchema,
  type BrowserInput,
  updateCheckSchema,
  type UpdateCheck,
  type UpdatePreferences,
  apiErrorSchema,
  usageReportSchema,
  type UsageReport,
  backendInfoSchema,
  type BackendInfo,
  attachmentSchema,
  contextEstimateSchema,
  runtimeStateSchema,
  runDetailsSchema,
  auditEntrySchema,
  type RuntimeState,
  type RunDetails,
  type AuditEntry,
  type Attachment,
  type ContextEstimate,
  type ContextRequest,
  channelSchema,
  messagesResponseSchema,
  profileSchema,
  runEventSchema,
  runSchema,
  sendMessageResponseSchema,
  settingsSchema,
  type Channel,
  type CreateChannelInput,
  type CreateProfileInput,
  type Message,
  type MessagesResponse,
  type ModelInfo,
  type Profile,
  type Run,
  type RunEvent,
  type SendMessageResponse,
  type SettingsView,
  type UpdateChannelInput,
  type UpdateProfileInput,
  type UpdateSettingsInput,
  scheduledJobSchema,
  jobRunSchema,
  schedulePreviewSchema,
  schedulerStateSchema,
  type ScheduledJob,
  type JobRun,
  type SchedulePreview,
  type SchedulerState,
  type CreateJob,
  type UpdateJob,
} from "@vektor/shared";
import { createSseParser } from "./sse";
import { apiFetch } from "./transport";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function parseError(response: Response): Promise<ApiError> {
  try {
    const body = apiErrorSchema.parse(await response.json());
    return new ApiError(response.status, body.error.code, body.error.message);
  } catch {
    return new ApiError(response.status, "request_failed", `Request failed (${response.status}).`);
  }
}

export class ApiClient {
  constructor(private readonly token: string) {}
  async browserState(runId: string) {
    const result = await this.request<{ session: unknown; artifacts: unknown[] }>(
      `/api/runs/${runId}/browser`,
    );
    return {
      session: browserStateSchema.parse(result.session),
      artifacts: result.artifacts.map((value) => browserArtifactSchema.parse(value)),
    };
  }
  async browserControl(runId: string, action: "pause" | "resume" | "close") {
    await this.request(`/api/runs/${runId}/browser/control`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
  }
  async browserInput(runId: string, input: BrowserInput) {
    return this.request(`/api/runs/${runId}/browser/input`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async browserArtifact(id: string): Promise<Blob> {
    const response = await apiFetch(`/api/browser-artifacts/${id}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw await parseError(response);
    return response.blob();
  }
  async deleteBrowserArtifacts(runId: string) {
    await this.request(`/api/runs/${runId}/browser/artifacts`, { method: "DELETE" });
  }

  async updateCheck(force = false): Promise<UpdateCheck> {
    return updateCheckSchema.parse(await this.request(`/api/update-check?force=${force}`));
  }

  async updatePreferences(patch: UpdatePreferences): Promise<UpdateCheck> {
    return updateCheckSchema.parse(
      await this.request("/api/update-check", {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    );
  }

  async usageReport(
    from: string,
    to: string,
    provider: UsageReport["provider"],
  ): Promise<UsageReport> {
    const query = new URLSearchParams({ from, to, provider });
    return usageReportSchema.parse(await this.request(`/api/usage?${query}`));
  }

  async backendInfo(): Promise<BackendInfo> {
    return backendInfoSchema.parse(await this.request("/api/backend"));
  }

  async listJobs(includeDeleted = false): Promise<ScheduledJob[]> {
    const response = await this.request<{ jobs: unknown }>(
      `/api/jobs?includeDeleted=${includeDeleted}`,
    );
    return scheduledJobSchema.array().parse(response.jobs);
  }
  async createJob(input: CreateJob): Promise<ScheduledJob> {
    const response = await this.request<{ job: unknown }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return scheduledJobSchema.parse(response.job);
  }
  async updateJob(id: string, input: UpdateJob): Promise<ScheduledJob> {
    const response = await this.request<{ job: unknown }>(`/api/jobs/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return scheduledJobSchema.parse(response.job);
  }
  async deleteJob(id: string): Promise<void> {
    await this.request(`/api/jobs/${id}`, { method: "DELETE" });
  }
  async runJob(id: string): Promise<JobRun> {
    const response = await this.request<{ execution: unknown }>(`/api/jobs/${id}/run`, {
      method: "POST",
    });
    return jobRunSchema.parse(response.execution);
  }
  async jobHistory(
    id: string,
    before?: number,
  ): Promise<{ executions: JobRun[]; nextBefore: number | null }> {
    const result = await this.request<{ executions: unknown; nextBefore: number | null }>(
      `/api/jobs/${id}/runs${before ? `?before=${before}` : ""}`,
    );
    return { ...result, executions: jobRunSchema.array().parse(result.executions) };
  }
  async previewSchedule(schedule: string, timezone: string): Promise<SchedulePreview> {
    return schedulePreviewSchema.parse(
      await this.request("/api/jobs/preview", {
        method: "POST",
        body: JSON.stringify({ schedule, timezone }),
      }),
    );
  }
  async schedulerState(): Promise<SchedulerState> {
    return schedulerStateSchema.parse(await this.request("/api/scheduler"));
  }
  async pauseScheduler(): Promise<SchedulerState> {
    return schedulerStateSchema.parse(
      await this.request("/api/scheduler/pause", { method: "POST" }),
    );
  }
  async resumeScheduler(): Promise<SchedulerState> {
    return schedulerStateSchema.parse(
      await this.request("/api/scheduler/resume", { method: "POST" }),
    );
  }

  async runtime(): Promise<RuntimeState> {
    return runtimeStateSchema.parse(await this.request("/api/runtime"));
  }
  async emergencyStop(): Promise<void> {
    await this.request("/api/runtime/emergency-stop", { method: "POST" });
  }
  async resumeRuntime(): Promise<void> {
    await this.request("/api/runtime/resume", { method: "POST" });
  }
  async decideApproval(id: string, approved: boolean): Promise<void> {
    await this.request(`/api/approvals/${id}`, {
      method: "POST",
      body: JSON.stringify({ approved }),
    });
  }
  async listRuns(
    channelId: string,
    before?: number,
  ): Promise<{ runs: Run[]; nextBefore: number | null }> {
    const query = new URLSearchParams({ channelId });
    if (before) query.set("before", String(before));
    const result = await this.request<{ runs: unknown; nextBefore: number | null }>(
      `/api/runs?${query}`,
    );
    return { runs: runSchema.array().parse(result.runs), nextBefore: result.nextBefore };
  }
  async runDetails(id: string): Promise<RunDetails> {
    return runDetailsSchema.parse(await this.request(`/api/runs/${id}/details`));
  }
  async audit(before?: number): Promise<{ entries: AuditEntry[]; nextBefore: number | null }> {
    const result = await this.request<{ entries: unknown; nextBefore: number | null }>(
      `/api/audit${before ? `?before=${before}` : ""}`,
    );
    return {
      entries: auditEntrySchema.array().parse(result.entries),
      nextBefore: result.nextBefore,
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await apiFetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw await parseError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  async getSettings(): Promise<SettingsView> {
    return settingsSchema.parse(await this.request<unknown>("/api/settings"));
  }

  async updateSettings(input: UpdateSettingsInput): Promise<SettingsView> {
    return settingsSchema.parse(
      await this.request<unknown>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    );
  }

  async testProvider(): Promise<{ ok: boolean; models: ModelInfo[] }> {
    const body = await this.request<{ ok: boolean; models: ModelInfo[] }>(
      "/api/settings/provider/test",
      { method: "POST" },
    );
    return { ok: body.ok, models: body.models };
  }

  async listProfiles(): Promise<Profile[]> {
    const body = await this.request<{ profiles: unknown }>("/api/profiles");
    return profileSchema.array().parse(body.profiles);
  }

  async createProfile(input: CreateProfileInput): Promise<Profile> {
    const body = await this.request<{ profile: unknown }>("/api/profiles", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return profileSchema.parse(body.profile);
  }

  async updateProfile(id: string, input: UpdateProfileInput): Promise<Profile> {
    const body = await this.request<{ profile: unknown }>(`/api/profiles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return profileSchema.parse(body.profile);
  }

  async archiveProfile(id: string): Promise<void> {
    await this.request<void>(`/api/profiles/${id}`, { method: "DELETE" });
  }

  async listChannels(): Promise<Channel[]> {
    const body = await this.request<{ channels: unknown }>("/api/channels");
    return channelSchema.array().parse(body.channels);
  }

  async createChannel(input: CreateChannelInput): Promise<Channel> {
    const body = await this.request<{ channel: unknown }>("/api/channels", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return channelSchema.parse(body.channel);
  }

  async updateChannel(id: string, input: UpdateChannelInput): Promise<Channel> {
    const body = await this.request<{ channel: unknown }>(`/api/channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return channelSchema.parse(body.channel);
  }

  async archiveChannel(id: string): Promise<void> {
    await this.request<void>(`/api/channels/${id}`, { method: "DELETE" });
  }

  async listMessages(channelId: string, before?: string): Promise<MessagesResponse> {
    const query = new URLSearchParams({ limit: "50" });
    if (before) {
      query.set("before", before);
    }

    return messagesResponseSchema.parse(
      await this.request<unknown>(`/api/channels/${channelId}/messages?${query.toString()}`),
    );
  }

  async sendMessage(
    channelId: string,
    content: string,
    profileId?: string,
    attachmentIds?: string[],
    allowTruncation?: boolean,
  ): Promise<SendMessageResponse> {
    return sendMessageResponseSchema.parse(
      await this.request<unknown>(`/api/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content,
          ...(profileId ? { profileId } : {}),
          attachmentIds,
          allowTruncation,
        }),
      }),
    );
  }

  async retryRun(runId: string, allowTruncation = false): Promise<Run> {
    const body = await this.request<{ run: unknown }>(`/api/runs/${runId}/retry`, {
      method: "POST",
      body: JSON.stringify({ allowTruncation }),
    });
    return runSchema.parse(body.run);
  }

  async retryContext(runId: string): Promise<ContextEstimate> {
    return contextEstimateSchema.parse(await this.request(`/api/runs/${runId}/context`));
  }

  async listAttachments(channelId: string): Promise<{
    attachments: Attachment[];
    limits: { maxFileBytes: number; channelFileBytes: number; maxFiles: number };
  }> {
    const result = await this.request<{
      attachments: unknown;
      limits: { maxFileBytes: number; channelFileBytes: number; maxFiles: number };
    }>(`/api/channels/${channelId}/attachments`);
    return { ...result, attachments: attachmentSchema.array().parse(result.attachments) };
  }

  async uploadAttachment(channelId: string, file: File): Promise<Attachment> {
    const body = new FormData();
    body.append("file", file);
    const response = await apiFetch(`/api/channels/${channelId}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body,
    });
    if (!response.ok) throw await parseError(response);
    return attachmentSchema.parse((await response.json()).attachment);
  }

  async updateAttachment(id: string, included: boolean): Promise<Attachment> {
    const response = await this.request<{ attachment: unknown }>(`/api/attachments/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ included }),
    });
    return attachmentSchema.parse(response.attachment);
  }

  async deleteAttachment(id: string): Promise<void> {
    await this.request<void>(`/api/attachments/${id}`, { method: "DELETE" });
  }

  async attachmentContent(id: string): Promise<Blob> {
    const response = await apiFetch(`/api/attachments/${id}/content`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw await parseError(response);
    return response.blob();
  }

  async estimateContext(channelId: string, input: ContextRequest): Promise<ContextEstimate> {
    return contextEstimateSchema.parse(
      await this.request<unknown>(`/api/channels/${channelId}/context`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }

  async cancelRun(runId: string): Promise<void> {
    await this.request<{ cancelled: boolean }>(`/api/runs/${runId}/cancel`, {
      method: "POST",
    });
  }

  async streamRun(
    runId: string,
    after: number,
    onEvent: (event: RunEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const query = after > 0 ? `?after=${after}` : "";
    const response = await apiFetch(`/api/runs/${runId}/events${query}`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${this.token}`,
        ...(after > 0 ? { "Last-Event-ID": String(after) } : {}),
      },
      signal,
    });

    if (!response.ok) {
      throw await parseError(response);
    }

    if (!response.body) {
      throw new Error("Streaming is not supported by this browser.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser((frame) => {
      try {
        onEvent(runEventSchema.parse(JSON.parse(frame.data)));
      } catch {
        // Ignore frames that do not match the shared contract.
      }
    });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  }
}

export type { Message };
