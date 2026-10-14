/** Synthetic, read-only UI fixture. Never contacts a hosted site or ad service. */
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { workspaceStore, TEST_EMAIL } from '../tests/support/test-workspace-store.mjs';
import { initializeTestSchema } from '../worker/test-workspace/schema.mjs';
import { siteRuntimeSettings, changeSiteRuntime } from '../worker/site-runtime/service.mjs';
import { listUnitRules } from '../worker/unit-rules.ts';
import { listAdUnits } from '../worker/ad-units.ts';
import { listSizeMaps } from '../worker/size-maps.ts';
import { defaultOverlay } from '../worker/runtime-next/position-settings.mjs';

globalThis.fetch = () => { throw Error('External network forbidden'); };
const f = workspaceStore();
await initializeTestSchema(f.env.DB, TEST_EMAIL);
for (const [i, code, type, enabled] of [[2,'InText_1','BTF',1],[3,'InText_2','BTF',1],[4,'InText_3','BTF',1],[5,'TakeOver','ATF',1],[6,'OffUnit','BTF',0]]) {
  f.sqlite.prepare('INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,enabled,sort_order) VALUES (?,?,?,?,?,?,?)')
    .run(`unit-${i}`, 'test-site', code, type, 'display', enabled, i);
}
const config = JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);
config.runtimeControls.adPositions = { TakeOver: defaultOverlay() };
config.advancedUnitRules = {
  InText_2: { lazy: { enabled: false, fetchMarginPx: 500, renderMarginPx: 0 } },
  InText_3: { lazy: { enabled: true, fetchMarginPx: 500, renderMarginPx: 100 } },
};
f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
const settings = await siteRuntimeSettings(f.env, 'test-site');
await changeSiteRuntime(f.env, 'test-site', TEST_EMAIL, { action:'version', revision:settings.revision, runtime:settings.runtimes[0].pin, allowPreview:true });
const snapshot = () => JSON.stringify(['publisher_configs','ad_units','size_maps','unit_rules','audit_log'].map(t => f.sqlite.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));
const before = snapshot();
const bundle = await build({stdin:{contents:`
 import {createRoot} from 'react-dom/client';
 import UnitRulesPanel from './src/components/UnitRulesPanel';
 import './src/dashboard-styles';
 createRoot(document.getElementById('root')).render(<UnitRulesPanel publisherId="test-site"/>);
`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:'.generated/loading-summary',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
console.log(JSON.stringify({ready:true}));
for await (const line of createInterface({input:process.stdin})) {
  try {
    const request = JSON.parse(line); let response;
    if (request.method !== 'GET') throw Error('This review must not write settings');
    const path = request.path;
    if (path === '/') response = new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body{height:auto;overflow:auto}#root{padding:24px;min-width:0}</style><div id="root"></div><script src="/fixture.js"></script>',{headers:{'content-type':'text/html'}});
    else if (path === '/fixture.js' || path === '/fixture.css') {
      const ext = path.endsWith('.js') ? '.js' : '.css';
      response = new Response(bundle.outputFiles.find(f=>f.path.endsWith(ext)).text,{headers:{'content-type':ext==='.js'?'application/javascript':'text/css'}});
    } else if (path.endsWith('/builtin-site-settings')) response = Response.json(await siteRuntimeSettings(f.env,'test-site'));
    else if (path.endsWith('/unit-rules')) response = await listUnitRules(f.env,'test-site');
    else if (path.endsWith('/ad-units')) response = await listAdUnits(f.env,'test-site');
    else if (path.endsWith('/size-maps')) response = await listSizeMaps(f.env,'test-site');
    else if (path === '/unchanged') response = Response.json({unchanged:before===snapshot()});
    else throw Error('Unexpected fixture request: '+path);
    console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
  } catch(e) { console.log(JSON.stringify({error:e.message})); }
}
f.close();
