export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

export interface SseParser {
  push(chunk: string): void;
  reset(): void;
}

export function createSseParser(onFrame: (frame: SseFrame) => void): SseParser {
  let buffer = "";

  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const frame: SseFrame = { data: "" };
        let hasData = false;

        for (const line of rawFrame.split("\n")) {
          if (line === "" || line.startsWith(":")) {
            continue;
          }

          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");

          if (field === "id") {
            frame.id = value;
          } else if (field === "event") {
            frame.event = value;
          } else if (field === "data") {
            frame.data = frame.data === "" ? value : `${frame.data}\n${value}`;
            hasData = true;
          }
        }

        if (hasData) {
          onFrame(frame);
        }

        boundary = buffer.indexOf("\n\n");
      }
    },

    reset() {
      buffer = "";
    },
  };
}
