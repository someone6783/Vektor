import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { createBackup, restoreBackup, verifyBackup } from "./backup.js";

const [command, path, ...extra] = process.argv.slice(2);
try {
  if (!path || extra.length || !["backup", "restore", "verify"].includes(command ?? ""))
    throw new Error("Usage: node dist/maintenance/cli.js backup|restore|verify /path/to/backup");
  const config = loadConfig();
  const target = resolve(process.env.INIT_CWD ?? process.cwd(), path);
  if (command === "backup") await createBackup(config.dataDir, target);
  if (command === "restore") await restoreBackup(target, config.dataDir);
  if (command === "verify") await verifyBackup(target);
  process.stdout.write(JSON.stringify({ ok: true, command, path: target }) + "\n");
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : "Maintenance failed.",
    }) + "\n",
  );
  process.exitCode = 1;
}
