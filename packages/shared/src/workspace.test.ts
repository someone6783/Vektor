import { describe, expect, it } from "vitest";
import {
  channelSchema,
  createProfileSchema,
  messagesResponseSchema,
  profileSchema,
  runSchema,
  settingsSchema,
  updateProfileSchema,
  updateSettingsSchema,
} from "./index.js";

const profile = {
  id: "profile-1",
  name: "Default",
  color: "emerald",
  systemPrompt: "Be helpful.",
  model: "openrouter/auto",
  temperature: 0.7,
  maxTokens: 2048,
  terminalMode: "no-terminal",
  tools: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
};

describe("workspace contracts", () => {
  it("parses a profile and rejects unknown colors", () => {
    expect(profileSchema.parse(profile)).toEqual(profile);
    expect(() => profileSchema.parse({ ...profile, color: "orange" })).toThrow();
  });

  it("accepts partial profile updates and rejects unknown fields", () => {
    expect(updateProfileSchema.parse({ name: "Analyst", temperature: 0.2 })).toEqual({
      name: "Analyst",
      temperature: 0.2,
    });
    expect(() => updateProfileSchema.parse({ unknown: true })).toThrow();
  });

  it("requires a model when creating a profile", () => {
    expect(createProfileSchema.parse({ name: "Research", model: "openai/gpt-4.1" })).toEqual({
      name: "Research",
      model: "openai/gpt-4.1",
    });
    expect(() => createProfileSchema.parse({ name: "Research" })).toThrow();
  });

  it("validates channel kinds", () => {
    const channel = {
      id: "channel-1",
      name: "General",
      topic: "",
      kind: "channel",
      profileId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    };

    expect(channelSchema.parse(channel)).toEqual(channel);
    expect(() => channelSchema.parse({ ...channel, kind: "thread" })).toThrow();
  });

  it("parses a settings view and write-only key updates", () => {
    const settings = {
      openRouterConfigured: false,
      openRouterSource: "none",
      defaultModel: "openrouter/auto",
      models: [{ id: "openrouter/auto", name: "OpenRouter Auto" }],
      modelsFetchedAt: null,
    };

    expect(settingsSchema.parse(settings)).toEqual(settings);
    expect(updateSettingsSchema.parse({ openRouterKey: null })).toEqual({ openRouterKey: null });
    expect(() => updateSettingsSchema.parse({ defaultModel: "" })).toThrow();
  });

  it("parses a messages page with an active run", () => {
    const page = {
      messages: [
        {
          id: "message-1",
          channelId: "channel-1",
          role: "user",
          content: "Hello",
          status: "complete",
          runId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextBefore: null,
      activeRun: {
        id: "run-1",
        channelId: "channel-1",
        profileId: "profile-1",
        userMessageId: "message-1",
        model: "openrouter/auto",
        runner: "native",
        status: "running",
        error: null,
        usage: null,
        startedAt: "2026-01-01T00:00:01.000Z",
        endedAt: null,
      },
    };

    expect(messagesResponseSchema.parse(page)).toEqual(page);
    expect(() => runSchema.parse({ ...page.activeRun, status: "queued" })).toThrow();
  });
});
