import {build} from 'esbuild';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const result=await build({absWorkingDir:fileURLToPath(root),entryPoints:['src/creative-templates/test-entry.tsx'],bundle:true,write:false,outdir:'.generated/creative-templates',format:'iife',platform:'browser',jsx:'automatic',minify:true,target:'es2022',define:{'process.env.NODE_ENV':'"production"'}});
const js=result.outputFiles.find(f=>f.path.endsWith('.js'))?.text,css=result.outputFiles.find(f=>f.path.endsWith('.css'))?.text;
if(!js||!css)throw Error('API integrations assets missing');
mkdirSync(new URL('.generated/',root),{recursive:true});
writeFileSync(new URL('.generated/creative-templates.mjs',root),`export const creativeTemplatesJs=${JSON.stringify(js)};\nexport const creativeTemplatesCss=${JSON.stringify(css)};\n`);
