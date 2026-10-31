import {build} from 'esbuild';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const result=await build({absWorkingDir:fileURLToPath(root),entryPoints:['src/site-workspace/named-script-test-entry.tsx'],bundle:true,write:false,outdir:'.generated/named-script-test',format:'iife',platform:'browser',jsx:'automatic',minify:true,target:'es2022',define:{'process.env.NODE_ENV':'"production"'}});
const js=result.outputFiles.find(f=>f.path.endsWith('.js'))?.text,css=result.outputFiles.find(f=>f.path.endsWith('.css'))?.text;
if(!js||!css)throw Error('Named-script TEST assets missing.');
writeFileSync(new URL('.generated/named-script-test.mjs',root),`export const namedScriptsJs=${JSON.stringify(js)};\nexport const namedScriptsCss=${JSON.stringify(css)};\n`);
