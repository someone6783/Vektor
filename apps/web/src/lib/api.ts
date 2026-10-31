import {
  apiErrorSchema,
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
} from "@vektor/shared";
import { createSseParser } from "./sse";

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

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
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
  ): Promise<SendMessageResponse> {
    return sendMessageResponseSchema.parse(
      await this.request<unknown>(`/api/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content, ...(profileId ? { profileId } : {}) }),
      }),
    );
  }

  async retryRun(runId: string): Promise<Run> {
    const body = await this.request<{ run: unknown }>(`/api/runs/${runId}/retry`, {
      method: "POST",
    });
    return runSchema.parse(body.run);
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
    const response = await fetch(`/api/runs/${runId}/events${query}`, {
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
