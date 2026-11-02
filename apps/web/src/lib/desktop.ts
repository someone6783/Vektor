import { invoke } from "@tauri-apps/api/core";
import { BACKEND_KEY, normalizeBackend, tokenStorageKey } from "./transport";
export interface DesktopConnection {
  baseUrl: string;
  token: string;
  mode: "local" | "docker";
}
export async function saveDesktopConnection(connection: DesktopConnection): Promise<void> {
  const base = normalizeBackend(connection.baseUrl);
  if (!connection.token) throw new Error("Automatic sign-in did not return credentials.");
  await invoke("save_backend", { connection: { ...connection, baseUrl: base } });
  localStorage.setItem(BACKEND_KEY, base);
  localStorage.setItem(tokenStorageKey(), connection.token);
}
