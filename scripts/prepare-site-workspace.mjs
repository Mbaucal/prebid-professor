import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=new URL('../',import.meta.url);
const result=await build({absWorkingDir:fileURLToPath(root),entryPoints:['src/site-workspace/test-entry.tsx'],bundle:true,write:false,outdir:'.generated/site-workspace',format:'iife',platform:'browser',jsx:'automatic',minify:true,target:'es2022',define:{'process.env.NODE_ENV':'"production"'}});
const js=result.outputFiles.find(f=>f.path.endsWith('.js'))?.text,css=result.outputFiles.find(f=>f.path.endsWith('.css'))?.text;
if(!js||!css)throw Error('Site workspace assets missing');
writeFileSync(new URL('.generated/site-workspace.mjs',root),`export const workspaceJs=${JSON.stringify(js)};\nexport const workspaceCss=${JSON.stringify(css)};\n`);
