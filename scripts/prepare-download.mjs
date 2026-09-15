import {build} from 'esbuild';
import {writeFileSync} from 'node:fs';
const result=await build({entryPoints:['src/download/entry.mjs'],bundle:true,write:false,format:'iife',platform:'browser',minify:true,target:'es2022'});
writeFileSync('.generated/download.mjs','export const downloadScript='+JSON.stringify(result.outputFiles[0].text)+';\n');
