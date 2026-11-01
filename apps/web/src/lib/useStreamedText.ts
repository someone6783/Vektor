import type { LiveRun } from "./live";
import { completedParagraphs } from "./paragraphs";

export function visibleRunBlocks(live: LiveRun, chunked: boolean): LiveRun["blocks"] {
  return live.blocks.map((block, index) => {
    if (block.type === "tool") return block;
    const complete =
      live.status !== "running" ||
      index < live.blocks.length - 1 ||
      live.phase !== (block.type === "thinking" ? "thinking" : "responding");
    return { ...block, text: !chunked || complete ? block.text : completedParagraphs(block.text) };
  });
}
export function useStreamedText(live: LiveRun | null, chunked: boolean) {
  return live
    ? visibleRunBlocks(live, chunked)
        .map((block) => (block.type !== "tool" ? block.text : ""))
        .join("\n\n")
    : "";
}
