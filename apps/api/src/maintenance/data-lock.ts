import { join } from "node:path";
import { lockDataDirectory } from "@vektor/db";
import { ensureDirectory } from "../bootstrap.js";

// The server and offline commands share an OS-backed lock. Never unlink this
// file: its inode is the coordination point, including after a process crash.
export async function acquireDataLock(dataDir: string): Promise<() => Promise<void>> {
  ensureDirectory(dataDir);
  try {
    const release = lockDataDirectory(join(dataDir, ".vektor-lock.db"));
    return async () => {
      release();
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "SQLITE_BUSY")
      throw new Error("The data directory is in use. Stop the backend before maintenance.");
    throw error;
  }
}
