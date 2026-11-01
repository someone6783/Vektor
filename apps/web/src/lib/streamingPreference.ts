import { useSyncExternalStore } from "react";

const key = "vektor.chunkedStreaming";
const event = "vektor-streaming-preference";
let fallback = true;
function read() {
  try {
    return localStorage.getItem(key) !== "false";
  } catch {
    return fallback;
  }
}
function subscribe(notify: () => void) {
  window.addEventListener(event, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(event, notify);
    window.removeEventListener("storage", notify);
  };
}
export function setChunkedStreaming(enabled: boolean) {
  fallback = enabled;
  try {
    localStorage.setItem(key, String(enabled));
  } catch {
    /* Keep the session preference. */
  }
  window.dispatchEvent(new Event(event));
}
export function useChunkedStreaming() {
  return useSyncExternalStore(subscribe, read, () => true);
}
