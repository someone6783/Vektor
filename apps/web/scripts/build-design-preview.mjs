import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { log } from "node:console";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(resolve(tmpdir(), "vektor-design-"));
try {
  await build({
    root: web,
    configFile: resolve(web, "vite.config.ts"),
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: {
        entry: resolve(web, "src/design-preview.tsx"),
        name: "VektorDesignPreview",
        formats: ["iife"],
        fileName: () => "preview.js",
        cssFileName: "preview",
      },
    },
  });
  const javascript = await readFile(resolve(output, "preview.js"), "utf8");
  const css = await readFile(resolve(output, "preview.css"), "utf8");
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vektor — Orbit × Beacon</title><style>${css}
html,body{margin:0;background:none}.preview-shell{color:var(--ui-text)}.preview-caption{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:12px 0;font-size:12px;color:var(--foreground,light-dark(#242831,#eceef1))}.preview-app{height:860px;border:1px solid var(--ui-border);border-radius:16px}.preview-footnote{font-size:11px;padding:10px 0;color:var(--foreground,light-dark(#242831,#eceef1))}@media(max-width:700px){.preview-app{height:900px}.preview-caption span:last-child{display:none}}
</style></head><body><div id="root"></div><script>${javascript.replaceAll("</script", "<\\/script")}</script></body></html>`;
  const destination = resolve(web, "../../docs/ui-designs/implemented.html");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, html);
  log(`Standalone design preview: ${destination}`);
} finally {
  await rm(output, { recursive: true, force: true });
}
