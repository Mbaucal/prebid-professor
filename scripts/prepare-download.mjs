import {build} from 'esbuild';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const result=await build({absWorkingDir:fileURLToPath(root),entryPoints:['src/download/entry.mjs'],bundle:true,write:false,format:'iife',platform:'browser',minify:true,target:'es2022'});
writeFileSync(new URL('.generated/download.mjs',root),'export const downloadScript='+JSON.stringify(result.outputFiles[0].text)+';\n');
