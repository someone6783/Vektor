/** Reveal complete paragraphs and fenced code blocks, retaining the unfinished tail. */
export function completedParagraphs(text: string): string {
  let boundary = 0;
  let offset = 0;
  let fence: string | null = null;
  const lines = text.split("\n");
  for (const line of lines.slice(0, -1)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/, ""));
    offset += line.length + 1;
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence[0] &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      ) {
        fence = null;
        boundary = offset;
      }
    } else if (marker) {
      fence = marker[1]!;
    } else if (!line.trim()) {
      boundary = offset;
    }
  }
  return text.slice(0, boundary);
}
