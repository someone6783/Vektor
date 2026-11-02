import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { RuntimeError } from "../runtime/terminal.js";
const require = createRequire(import.meta.url);
// Untrusted schemas (including patterns and recursive references) are evaluated
// off the API thread with bounded memory and CPU time. No remote schema loading.
export async function validateSchemas(
  schemas: Record<string, unknown>[],
  data?: unknown,
): Promise<void> {
  const raw = JSON.stringify(schemas);
  if (
    Buffer.byteLength(raw) > 128 * 1024 ||
    schemas.some((s) => Buffer.byteLength(JSON.stringify(s)) > 32 * 1024)
  )
    throw new RuntimeError("MCP schemas exceed their size limit.", 413);
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(
      `
const {parentPort,workerData}=require('node:worker_threads');
try {
 const instances={};
 for (const schema of workerData.schemas) {
  let nodes=0;
  const walk=(v,d)=>{if(d>30||++nodes>2000)throw Error('schema complexity');if(v&&typeof v==='object'){for(const [k,x] of Object.entries(v)){if(k==='$ref'&&(typeof x!=='string'||!x.startsWith('#/')))throw Error('external reference');walk(x,d+1);}}};walk(schema,0);
  const modulePath=schema.$schema?.includes('draft-07')?workerData.ajv7:workerData.ajv2020;
  if(!instances[modulePath]){const Ajv=require(modulePath).default;instances[modulePath]=new Ajv({strict:false,allErrors:false,validateFormats:false,addUsedSchema:false,ownProperties:true});}
  const validator=instances[modulePath].compile(schema);
  if(workerData.hasData&&!validator(workerData.data))throw Error('arguments do not match the schema');
 }
 parentPort.postMessage({ok:true});
}catch{parentPort.postMessage({ok:false});}
`,
      {
        eval: true,
        execArgv: [],
        env: {},
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
        workerData: {
          schemas,
          data,
          hasData: data !== undefined,
          ajv7: require.resolve("ajv"),
          ajv2020: require.resolve("ajv/dist/2020.js"),
        },
      },
    );
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new RuntimeError("MCP schema validation exceeded its deadline.", 400));
    }, 2000);
    worker.once("message", (result: { ok: boolean }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (result.ok) resolve();
      else
        reject(
          new RuntimeError(
            "Unsupported MCP schema or arguments do not match the declared schema.",
            400,
          ),
        );
    });
    worker.once("error", () => {
      clearTimeout(timer);
      reject(new RuntimeError("MCP schema validation failed.", 400));
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new RuntimeError("MCP schema validation stopped.", 400));
      }
    });
  });
}
