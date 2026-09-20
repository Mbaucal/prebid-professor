import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preparePackageTemplates} from '../worker/experiments/configurable-cache-v1.mjs';
// Only repository-pinned inputs. No hosted reads or writes during a build.
await import('./prepare-tanjug-pilot.mjs');
await import('./prepare-tanjug-aa.mjs');
await import('./prepare-tanjug-compact.mjs');
await import('./prepare-tanjug-cmp.mjs');
const base = readFileSync('.generated/tanjug-pilot/ads.js');
const archive = readFileSync('.generated/tanjug-cmp/tanjug-aa-1.0.2.zip');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(base),'0faec2eccdcedbd29153357c7a94c879cdec4a8d037b16593a94a7884f242e2b');
assert.equal(sha(archive),'bd0d9a6973903a3ec585f88e4b815eefb7a061ec8a32593f671b53ce211dfb1e');
writeFileSync('.generated/site-ab-baseline.mjs',
  `export const baseReadable=${JSON.stringify(base.toString())};\nexport const previousArchiveBase64=${JSON.stringify(archive.toString('base64'))};\nexport const preparedTemplates=${JSON.stringify(preparePackageTemplates(base.toString()))};\n`);
