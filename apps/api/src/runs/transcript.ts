import { runEventSchema, type RunEvent } from "@vektor/shared";

/** Keep text/tool ordering without returning thousands of individual token events. */
export function compactTranscript(
  records: Array<{ type: string; payloadJson: string }>,
): RunEvent[] {
  const result: RunEvent[] = [];
  let text: string[] = [];
  let first: Extract<RunEvent, { type: "message.delta" | "reasoning.delta" }> | null = null;
  const flush = () => {
    if (first) result.push({ ...first, text: text.join("") });
    text = [];
    first = null;
  };
  for (const record of records) {
    if (
      record.type !== "message.delta" &&
      record.type !== "reasoning.delta" &&
      record.type !== "tool.requested"
    )
      continue;
    const event = runEventSchema.parse(JSON.parse(record.payloadJson));
    if (event.type === "message.delta" || event.type === "reasoning.delta") {
      if (first && first.type !== event.type) flush();
      first ??= event;
      text.push(event.text);
    } else {
      flush();
      result.push(event);
    }
  }
  flush();
  return result;
}
