// Real Releases UI and authenticated MAIN delete route, ephemeral SQLite/R2 only.
import {createInterface} from 'node:readline';
import {build} from 'esbuild';
import {releaseDeletionFixture, id, origin} from '../tests/support/release-deletion-fixture.mjs';
import worker from '../worker/app-builtin-runtime-preview.ts';

const f = await releaseDeletionFixture();
const names = {
  [id]: 'GAM + Prebid · 3.16.2 — Sticky desktop maximum height 100px',
  staging: 'Staging package', production: 'Production package', archived: 'Earlier archived package',
};
for (const [index, status] of ['staging', 'production', 'archived'].entries()) {
  const key = status === 'archived' ? 'legacy-release' : 'builtin-release-' + String(index + 1).repeat(64);
  f.sqlite.prepare('INSERT INTO releases(id,publisher_id,version,status,notes) VALUES(?,?,?,?,?)').run(key, 'first', key, status, names[status]);
}
f.sqlite.prepare('UPDATE releases SET notes=? WHERE id=?').run(names[id], id);
let failNext = false;
globalThis.fetch = () => { throw Error('No hosted traffic in this fixture'); };
const bundle = await build({stdin: {contents: `
 import {createRoot} from 'react-dom/client';
 import SitePackagesPanel from './src/components/SitePackagesPanel';
 import './src/dashboard-styles';
 createRoot(document.getElementById('root')).render(<main style={{maxWidth:1200,margin:'24px auto',padding:16}}><SitePackagesPanel publisherId="first"/></main>);
`, loader: 'tsx', resolveDir: process.cwd()}, bundle: true, write: false, outdir: '.generated/release-delete-ui', jsx: 'automatic', format: 'iife', define: {'process.env.NODE_ENV': '"production"'}});
console.log(JSON.stringify({ready: true, id}));
for await (const line of createInterface({input: process.stdin})) {
  try {
    const input = JSON.parse(line); let response;
    if (input.path === '/') response = new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>', {headers: {'content-type': 'text/html'}});
    else if (['/fixture.js', '/fixture.css'].includes(input.path)) {
      const ext = input.path.endsWith('.js') ? '.js' : '.css';
      response = new Response(bundle.outputFiles.find(file => file.path.endsWith(ext)).text, {headers: {'content-type': ext === '.js' ? 'application/javascript' : 'text/css'}});
    } else if (input.path === '/__fixture/fail-next') { failNext = true; response = Response.json({ok: true}); }
    else if (input.path === '/__fixture/snapshot') response = Response.json({exists: f.exists(), deleted: f.deleted, rows: f.sqlite.prepare('SELECT id,status FROM releases').all()});
    else if (input.path === '/api/publishers/first/builtin-releases') response = Response.json({site: {id: 'first', name: 'Release deletion fixture'}, runtime: {runtimeVersion: '3.16.2'}, enablePrebid: true, revision: 'fixture', channelRevision: 'fixture', ready: true, error: null, nextStep: null, testOnly: false, ...Object.fromEntries(['releases','earlierReleases'].map((field, i) => [field, f.sqlite.prepare('SELECT id,version,status,notes,created_at AS createdAt FROM releases WHERE publisher_id=? AND id '+(i ? 'NOT LIKE' : 'LIKE')+' ? ORDER BY id').all('first', 'builtin-release-%')]))});
    else if (input.method === 'DELETE') {
      f.failStorage = failNext; failNext = false;
      response = await worker.fetch(new Request(origin + input.path, {method: input.method, headers: {...input.headers, origin, cookie: f.cookie}}), f.env, {});
    } else if (input.path.endsWith('/deployment-targets')) response = Response.json({targets: [], deployments: [], orchestrator: {configured: false}});
    else if (input.path.endsWith('/ab-experiments') || input.path.endsWith('/script-library')) response = Response.json({supported: false});
    else response = Response.json({error: 'Unrelated fixture panel is not configured.'}, {status: 409});
    console.log(JSON.stringify({status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()).toString('base64')}));
  } catch (error) { console.log(JSON.stringify({error: error.message})); }
}
f.close();
