import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
await build({absWorkingDir:fileURLToPath(root),entryPoints:['worker/test-workspace/csv-preview.ts'],bundle:true,outfile:'.generated/inventory-preview.mjs',format:'esm',platform:'neutral',target:'es2022'});
