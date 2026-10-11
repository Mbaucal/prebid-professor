import {fileURLToPath} from 'node:url';
import {verifyIsolation} from '../scripts/verify-toolchain-isolation.mjs';
import {readFile} from 'node:fs/promises';
import {Miniflare as NativeMiniflare,convertV4MiniflareOptions,Headers} from 'miniflare';
await verifyIsolation(fileURLToPath(new URL('../',import.meta.url)));
const lock=JSON.parse(await readFile(new URL('./package-lock.json',import.meta.url),'utf8'));
const installed=JSON.parse(await readFile(new URL('./node_modules/miniflare/package.json',import.meta.url),'utf8'));
if(installed.version!==lock.packages['node_modules/miniflare'].version)throw Error('Local harness requires the exact dedicated Miniflare lock version');
// Miniflare 5's supported V4 converter retains existing fixture semantics.
// Persistence must be selected at the top level in the new API (not discarded).
export class Miniflare extends NativeMiniflare {
 constructor(options){
  const {resourcePersistencePath,...legacy}=options;
  super({...convertV4MiniflareOptions(legacy),...(Object.hasOwn(options,'resourcePersistencePath')?{resourcePersistencePath}: {})});
 }
}
export {Headers};
