import {
  mcpSetupSchema,
  mcpServerSchema,
  mcpContextSchema,
  type McpServerInput,
  type McpGrant,
  type McpContext,
  runnerSetupSchema,
  runnerProbeSchema,
  browserCapabilitiesSchema,
  defaultBrowserProfileSchema,
  browserStateSchema,
  browserArtifactSchema,
  computerCapabilitiesSchema,
  computerStateSchema,
  computerArtifactSchema,
  type ComputerInput,
  type ComputerState,
  type BrowserInput,
  updateCheckSchema,
  updateInstallSchema,
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
  modelInfoSchema,
  type Channel,
  type CreateChannelInput,
  type CreateProfileInput,
  type Message,
  type MessagesResponse,
  type ModelInfo,
  type ReasoningEffort,
  type RunnerId,
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
  async mcpSetup() {
    return mcpSetupSchema.parse(await this.request("/api/mcp"));
  }
  async configureMcp(input: McpServerInput, id?: string) {
    const result = await this.request<{ server: unknown }>(
      id ? `/api/mcp/servers/${id}` : "/api/mcp/servers",
      { method: id ? "PUT" : "POST", body: JSON.stringify(input) },
    );
    return mcpServerSchema.parse(result.server);
  }
  async mcpCredentials(id: string, values: Record<string, string>) {
    await this.request(`/api/mcp/servers/${id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({ values }),
    });
  }
  async testMcp(id: string) {
    const result = await this.request<{ server: unknown }>(`/api/mcp/servers/${id}/test`, {
      method: "POST",
    });
    return mcpServerSchema.parse(result.server);
  }
  async enableMcp(id: string, enabled: boolean) {
    await this.request(`/api/mcp/servers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
  }
  async removeMcp(id: string) {
    await this.request(`/api/mcp/servers/${id}`, { method: "DELETE" });
  }
  async grantMcp(profileId: string, id: string, grant: McpGrant) {
    await this.request(`/api/mcp/profiles/${profileId}/servers/${id}`, {
      method: "PUT",
      body: JSON.stringify(grant),
    });
  }
  async previewMcp(
    profileId: string,
    serverId: string,
    kind: McpContext["kind"],
    name: string,
    args: Record<string, string>,
  ) {
    const result = await this.request<{ context: unknown; text: string }>(
      "/api/mcp/context/preview",
      {
        method: "POST",
        body: JSON.stringify({ profileId, serverId, kind, name, arguments: args }),
      },
    );
    return { context: mcpContextSchema.parse(result.context), text: result.text };
  }
  async mcpContexts(profileId: string) {
    const result = await this.request<{ contexts: unknown[] }>(
      `/api/mcp/context?profileId=${encodeURIComponent(profileId)}`,
    );
    return result.contexts.map((c) => mcpContextSchema.parse(c));
  }
  async mcpContext(id: string) {
    return this.request<{ text: string }>(`/api/mcp/context/${id}`);
  }
  async removeMcpContext(id: string) {
    await this.request(`/api/mcp/context/${id}`, { method: "DELETE" });
  }
  async mcpArtifact(id: string) {
    return this.request<{ runId: string; text: string }>(`/api/mcp/artifacts/${id}`);
  }
  async removeMcpArtifact(id: string) {
    await this.request(`/api/mcp/artifacts/${id}`, { method: "DELETE" });
  }
  async browserCapabilities() {
    return browserCapabilitiesSchema.parse(await this.request("/api/browser/capabilities"));
  }
  async defaultBrowserProfile() {
    return defaultBrowserProfileSchema.parse(await this.request("/api/browser/profile"));
  }
  async controlDefaultBrowserProfile(action: "disconnect" | "reset") {
    return defaultBrowserProfileSchema.parse(
      await this.request("/api/browser/profile/control", {
        method: "POST",
        body: JSON.stringify({ action }),
      }),
    );
  }
  async browserState(runId: string) {
    const result = await this.request<{ session: unknown; artifacts: unknown[] }>(
      `/api/runs/${runId}/browser`,
    );
    return {
      session: browserStateSchema.parse(result.session),
      artifacts: result.artifacts.map((value) => browserArtifactSchema.parse(value)),
    };
  }
  async browserControl(runId: string, action: "pause" | "resume" | "close" | "open" | "focus") {
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
  async computerCapabilities() {
    return computerCapabilitiesSchema.parse(await this.request("/api/computer/capabilities"));
  }
  async computerState(runId: string): Promise<ComputerState> {
    const result = await this.request<{ session: unknown }>(`/api/runs/${runId}/computer`);
    return computerStateSchema.parse(result.session);
  }
  async computerControl(runId: string, action: "pause" | "resume" | "close" | "private") {
    await this.request(`/api/runs/${runId}/computer/control`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
  }
  async computerArtifacts(runId: string) {
    const result = await this.request<{ artifacts: unknown[] }>(`/api/runs/${runId}/computer`);
    return result.artifacts.map((value) => computerArtifactSchema.parse(value));
  }
  async computerArtifact(id: string): Promise<Blob> {
    const response = await apiFetch(`/api/computer-artifacts/${id}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error("Computer screenshot is unavailable.");
    return response.blob();
  }
  async deleteComputerArtifacts(runId: string) {
    await this.request(`/api/runs/${runId}/computer/artifacts`, { method: "DELETE" });
  }
  async computerInput(runId: string, input: ComputerInput) {
    return this.request(`/api/runs/${runId}/computer/input`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async computerScreenshot(runId: string): Promise<Blob> {
    const response = await apiFetch(`/api/runs/${runId}/computer/screenshot`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw await parseError(response);
    return response.blob();
  }

  async updateInstallState() {
    return updateInstallSchema.parse(await this.request("/api/update-install"));
  }
  async installBackendUpdate() {
    return updateInstallSchema.parse(
      await this.request("/api/update-install", { method: "POST", body: "{}" }),
    );
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
  async runDetails(id: string, transcript = false): Promise<RunDetails> {
    return runDetailsSchema.parse(
      await this.request(`/api/runs/${id}/details${transcript ? "?transcript=1" : ""}`),
    );
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

  async discoverRunners() {
    return this.request<{ executables: Array<{ name: string; command: string }> }>(
      "/api/runners/discover",
    );
  }
  async configureRunner(input: {
    id: string;
    executableHash: string;
    trustLocalCodex?: true;
    inferenceHosts: string[];
    credentialName: string;
  }) {
    await this.request("/api/runners/installations", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async enableRunner(id: string, enabled: boolean) {
    await this.request(`/api/runners/installations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
  }
  async removeRunner(id: string) {
    await this.request(`/api/runners/installations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
  async runnerCredential(id: string, key: string | null) {
    await this.request(`/api/runners/installations/${encodeURIComponent(id)}/credential`, {
      method: "PUT",
      body: JSON.stringify({ key }),
    });
  }
  async runnerGrant(
    profileId: string,
    grant: { runner?: RunnerId; workspace: boolean; inference: boolean },
  ) {
    await this.request(`/api/profiles/${profileId}/runner-grant`, {
      method: "PUT",
      body: JSON.stringify(grant),
    });
  }
  async removeRunnerCheckpoint(runId: string) {
    await this.request(`/api/runs/${runId}/runner-checkpoint`, { method: "DELETE" });
  }

  async runnerSetup() {
    return runnerSetupSchema.parse(await this.request("/api/runners"));
  }
  async syncRunnerRegistry() {
    await this.request("/api/runners/registry/sync", { method: "POST", body: "{}" });
  }
  async probeRunner(input: {
    interface: "codex-app-server" | "acp-v1";
    command: string;
    args: string[];
  }) {
    return runnerProbeSchema.parse(
      await this.request("/api/runners/probe", { method: "POST", body: JSON.stringify(input) }),
    );
  }
  async removeRunnerProbe(hash: string) {
    await this.request(`/api/runners/probes/${hash}`, { method: "DELETE" });
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

  async listModels(): Promise<ModelInfo[]> {
    const response = await this.request<{ models: unknown[] }>("/api/models");
    return response.models.map((model) => modelInfoSchema.parse(model));
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

  async listChannels(includeArchived = false): Promise<Channel[]> {
    const body = await this.request<{ channels: unknown }>(
      `/api/channels${includeArchived ? "?includeArchived=1" : ""}`,
    );
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
    model?: string,
    reasoning?: ReasoningEffort,
    runner?: RunnerId,
    resumeFromRunId?: string,
    mcpContextIds?: string[],
  ): Promise<SendMessageResponse> {
    return sendMessageResponseSchema.parse(
      await this.request<unknown>(`/api/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content,
          model,
          reasoning,
          runner,
          resumeFromRunId,
          mcpContextIds,
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
