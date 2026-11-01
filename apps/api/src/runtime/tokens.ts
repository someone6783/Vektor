import { getEncoding } from "js-tiktoken";
import type { ChatMessage } from "../providers/types.js";

const tokenizer = getEncoding("cl100k_base");
export const countTokens = (text: string) => tokenizer.encode(text, [], []).length;
export const countMessageTokens = (message: ChatMessage) =>
  6 +
  (typeof message.content === "string"
    ? countTokens(message.content)
    : message.content.reduce(
        (sum, part) => sum + (part.type === "text" ? countTokens(part.text) : 4096),
        0,
      )) +
  (message.tool_calls ? countTokens(JSON.stringify(message.tool_calls)) : 0) +
  (message.tool_call_id ? countTokens(message.tool_call_id) : 0) +
  (message.reasoning_details
    ? countTokens(JSON.stringify(message.reasoning_details))
    : message.reasoning
      ? countTokens(message.reasoning)
      : 0);
