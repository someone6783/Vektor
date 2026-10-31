import { getProfile, listAttachments, listContextHistory, type VektorDatabase } from "@vektor/db";
import type { ContextEstimate, ContextRequest } from "@vektor/shared";
import type { ProviderService } from "./providers/service.js";
import type { ChatMessage } from "./providers/types.js";
import { AttachmentError } from "./attachments/extract.js";
import type { AttachmentService } from "./attachments/service.js";
import { countTokens as tokens, countMessageTokens as messageTokens } from "./runtime/tokens.js";
import { runtimeSystemPrompt, toolsForProfile } from "./runtime/policy.js";

export class ContextService {
  constructor(
    readonly db: VektorDatabase,
    readonly files: AttachmentService,
    readonly provider: ProviderService,
  ) {}

  prepare(
    channelId: string,
    input: ContextRequest,
    defaultProfileId: string | null,
    beforeMessageId?: string,
    includeHistory = true,
  ) {
    const profile = getProfile(this.db, input.profileId ?? defaultProfileId ?? "");
    if (!profile || profile.archivedAt !== null)
      throw new AttachmentError("The selected profile is not available.");
    const model = input.model ?? profile.model;
    const metadata = this.provider.getCachedModels().models.find((item) => item.id === model);
    const contextWindow = metadata?.contextLength ?? 8192;
    const reservedOutputTokens = profile.maxTokens;
    const availableInputTokens = Math.max(0, contextWindow - reservedOutputTokens);
    const allAttachments = listAttachments(this.db, channelId);
    const ids = input.attachmentIds ? new Set(input.attachmentIds) : null;
    if (ids && [...ids].some((id) => !allAttachments.some((file) => file.id === id)))
      throw new AttachmentError("Selected attachments must belong to this channel.");
    const attachments = allAttachments.filter((file) => (ids ? ids.has(file.id) : file.included));
    const documentText = attachments
      .filter((file) => file.kind !== "image")
      .map(
        (file) =>
          `\n\n<attachment name=${JSON.stringify(file.filename)}>\n${file.extractedText}\n</attachment>`,
      )
      .join("");
    const images = attachments.filter((file) => file.kind === "image");
    const currentText = input.content + documentText;
    const currentTokens = tokens(currentText) + 6 + images.length * 4096;
    const systemPrompt = runtimeSystemPrompt(profile);
    const toolDefinitions = toolsForProfile(profile);
    const systemTokens =
      (systemPrompt ? tokens(systemPrompt) + 6 : 0) +
      (toolDefinitions.length ? tokens(JSON.stringify(toolDefinitions)) + 6 : 0);
    const previous = includeHistory
      ? listContextHistory(this.db, channelId, beforeMessageId)
      : { messages: [], total: 0 };
    const history = previous.messages.map(
      (record) => ({ role: record.role, content: record.content }) satisfies ChatMessage,
    );
    const originalInputTokens =
      systemTokens + currentTokens + history.reduce((sum, item) => sum + messageTokens(item), 0);
    let inputTokens = originalInputTokens;
    let droppedMessages = previous.total - history.length;
    while (history.length && inputTokens > availableInputTokens) {
      inputTokens -= messageTokens(history.shift()!);
      droppedMessages++;
    }
    while (droppedMessages > 0 && history[0]?.role === "assistant") {
      inputTokens -= messageTokens(history.shift()!);
      droppedMessages++;
    }
    const warnings = [
      "Text tokens are estimated with cl100k_base; the provider's actual usage may differ.",
      "Context uses up to 100 recent completed messages. Excluded files can still be quoted in earlier chat messages.",
    ];
    if (!metadata?.contextLength)
      warnings.push(
        "Model context window is unknown; using a conservative 8,192-token limit. Refresh the model list in Settings.",
      );
    if (images.length)
      warnings.push(
        "Images reserve 4,096 tokens each for planning. Actual image tokens depend on the model and resolution.",
      );
    if (images.length && metadata?.supportsImages === false)
      warnings.push(
        "This model does not support images. Select a vision model or exclude the images.",
      );
    if (droppedMessages)
      warnings.push(
        `${droppedMessages} oldest history messages will be omitted. Saved conversation history is preserved.`,
      );
    const estimate: ContextEstimate = {
      model,
      contextWindow,
      windowSource: metadata?.contextLength ? "model" : "fallback",
      originalInputTokens,
      inputTokens,
      reservedOutputTokens,
      availableInputTokens,
      attachmentTokens: tokens(documentText) + images.length * 4096,
      selectedAttachments: attachments.length,
      droppedMessages,
      exceedsBudget: inputTokens > availableInputTokens || reservedOutputTokens >= contextWindow,
      requiresTruncation: droppedMessages > 0,
      warnings,
    };
    return {
      estimate,
      profile,
      model,
      attachments,
      history,
      currentText,
      images,
      supportsImages: metadata?.supportsImages,
    };
  }

  async messages(prepared: ReturnType<ContextService["prepare"]>): Promise<ChatMessage[]> {
    if (prepared.images.length && prepared.supportsImages === false)
      throw new AttachmentError(
        "This model does not support images. Select a vision model or exclude the images.",
      );
    const current: ChatMessage = { role: "user", content: prepared.currentText };
    if (prepared.images.length) {
      current.content = [{ type: "text", text: prepared.currentText }];
      for (const image of prepared.images) {
        const buffer = await this.files.read(image);
        current.content.push({
          type: "image_url",
          image_url: {
            url: `data:${image.mime};base64,${buffer.toString("base64")}`,
            detail: "auto",
          },
        });
      }
    }
    return [...prepared.history, current];
  }
}

export function checkContextBudget(estimate: ContextEstimate, allowTruncation = false): void {
  if (estimate.exceedsBudget)
    throw new AttachmentError(
      "The prompt, selected files, and output allowance exceed the model context window. Exclude files, shorten the prompt, reduce max output tokens, or choose a larger model.",
      413,
    );
  if (estimate.requiresTruncation && !allowTruncation)
    throw new AttachmentError(
      "Context requires omitting older messages. Review the estimate and confirm before sending.",
      409,
    );
}
