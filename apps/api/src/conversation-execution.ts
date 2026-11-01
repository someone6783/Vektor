import { getSetting, type ProfileRecord, type VektorDatabase } from "@vektor/db";
import { conversationExecutionSchema } from "@vektor/shared";

export const executionKey = (channelId: string) => `channel.${channelId}.execution`;
export function conversationExecution(db: VektorDatabase, channelId: string) {
  const result = conversationExecutionSchema.safeParse(getSetting(db, executionKey(channelId)));
  return result.success ? result.data : {};
}
export function conversationProfile(
  db: VektorDatabase,
  channelId: string,
  profile: ProfileRecord,
): ProfileRecord {
  const overrides = conversationExecution(db, channelId);
  return {
    ...profile,
    ...overrides,
    tools:
      overrides.terminalMode === undefined
        ? profile.tools
        : [
            ...profile.tools.filter((tool) => tool !== "terminal"),
            ...(overrides.terminalMode === "no-terminal" ? [] : ["terminal"]),
          ],
  };
}
