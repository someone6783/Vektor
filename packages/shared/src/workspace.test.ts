import { describe, expect, it } from "vitest";
import {
  channelSchema,
  computerInputSchema,
  computerPermissionsSchema,
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

  it("defaults computer access off and validates isolated desktop permissions", () => {
    expect(computerPermissionsSchema.parse({})).toEqual({
      mode: "off",
      session: "isolated",
      maxActions: 60,
      maxDurationMs: 300_000,
      artifactDays: 7,
      width: 1280,
      height: 800,
      apps: [],
    });
    expect(
      computerPermissionsSchema.parse({
        mode: "control",
        apps: [{ name: "Message", command: "/usr/bin/xmessage", args: ["hello"] }],
      }),
    ).toMatchObject({ mode: "control", session: "isolated" });
    expect(() => computerPermissionsSchema.parse({ mode: "interactive" })).toThrow();
    expect(() => computerPermissionsSchema.parse({ session: "default" })).toThrow();
    expect(() => computerPermissionsSchema.parse({ width: 320 })).toThrow();
    expect(() => computerPermissionsSchema.parse({ apps: [{ name: "Only" }] })).toThrow();
    expect(() =>
      computerPermissionsSchema.parse({
        apps: [
          { name: "A", command: "a" },
          { name: "B", command: "b" },
          { name: "C", command: "c" },
          { name: "D", command: "d" },
          { name: "E", command: "e" },
          { name: "F", command: "f" },
        ],
      }),
    ).toThrow();
    expect(
      profileSchema.parse({ ...profile, computer: { mode: "observe" } }).computer,
    ).toMatchObject({ mode: "observe", width: 1280, height: 800 });
  });

  it("validates computer tool actions strictly", () => {
    expect(computerInputSchema.parse({ action: "screenshot" })).toEqual({ action: "screenshot" });
    expect(computerInputSchema.parse({ action: "click", x: 10, y: 20 })).toEqual({
      action: "click",
      x: 10,
      y: 20,
      button: "left",
      count: 1,
    });
    expect(() => computerInputSchema.parse({ action: "click", x: -1, y: 0 })).toThrow();
    expect(() => computerInputSchema.parse({ action: "click", x: 1, y: 2, extra: true })).toThrow();
    expect(() => computerInputSchema.parse({ action: "key", key: "ctrl+a; rm" })).toThrow();
    expect(() => computerInputSchema.parse({ action: "click", x: 1 })).toThrow();
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

    expect(messagesResponseSchema.parse(page)).toEqual({
      ...page,
      messages: page.messages.map((message) => ({ ...message, attachments: [] })),
      activeRun: { ...page.activeRun, context: null, terminalMode: "no-terminal" },
      lastRun: null,
    });
    expect(() => runSchema.parse({ ...page.activeRun, status: "queued" })).toThrow();
  });
});
