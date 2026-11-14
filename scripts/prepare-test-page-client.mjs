import { build } from 'esbuild';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Bundle the entire browser program before Worker compilation. Function#toString
// loses helpers/closures injected by Wrangler's keepNames or Vite minification.
export async function prepareTestPageClient(root) {
  const result=await build({absWorkingDir:root,stdin:{contents:"import {testPageClient} from './worker/site-runtime/test-page-client.mjs'; testPageClient();",resolveDir:root,sourcefile:'test-page-entry.js'},
    bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',minify:true,legalComments:'none'});
  const source=result.outputFiles[0].text;
  if(/<\/script/i.test(source))throw Error('Browser bundle contains an unsafe HTML script terminator.');
  await mkdir(resolve(root,'.generated'),{recursive:true});
  await writeFile(resolve(root,'.generated/test-page-client.mjs'),`// Complete browser bundle, preserved as data through Worker compilation.\nexport const testPageScript=${JSON.stringify(source)};\n`);
}
