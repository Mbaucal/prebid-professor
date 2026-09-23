import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { brotliDecompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { assertBuildTimestamp, sha256, REFERENCE_SHA256 } from './extract-reference391.mjs';
import { runtimeReleaseHistory, assertRuntimeReleaseSource } from '../worker/runtime/runtime-release-history.mjs';

import { prepareCreativeRuntime } from './prepare-creative-runtime.mjs';
import { prepareNextRuntime } from './prepare-next-runtime.mjs';
import { prepareReportingRuntime } from './prepare-reporting-runtime.mjs';
import { prepareTestPageClient } from './prepare-test-page-client.mjs';
const currentRuntimeRelease=runtimeReleaseHistory.find(r=>r.codeSha256==='222569881b377c085f0b5d373523d092d64e2ac5dab05d421c3cc9f371078de9');

export const BUILDER_SHA256 = '2f0e5c93a9c1dc2137fac63e08d0b0f493f74b91c5df4419a8403886d28b91ec';
export const MODULE_SHA256 = '80a5e8259a579891043e0d49bb47e18fb4c3b8319cfd73af49a1461c18447639';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function decodeBuilder(parts) {
  if (!Array.isArray(parts) || parts.length !== 4) throw new Error('All four reference archive parts are required.');
  const encoded = parts.map((part) => part.trim()).join('');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length !== 47988) throw new Error('Reference archive is malformed.');
  const bytes = brotliDecompressSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 200000 });
  if (bytes.length !== 173840 || sha256(bytes) !== BUILDER_SHA256) throw new Error('Approved reference builder checksum mismatch.');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function adaptBuilder(raw) {
  const replacements = [
    ['function buildScript(st) {', 'export function buildReference391(st, options = {}) {\n    const buildTimestamp = assertBuildTimestamp(options.buildTimestamp);'],
    ['    const BUILD_TS = Utilities.formatDate(\n        new Date(),\n        Session.getScriptTimeZone(),\n        "yyyyMMdd_HHmmss"\n    );', '    const BUILD_TS = buildTimestamp;'],
  ];
  let builder = raw;
  for (const [before, after] of replacements) {
    if (builder.split(before).length !== 2) throw new Error('Approved builder structure changed.');
    builder = builder.replace(before, after);
  }
  const code = [
    '// Mechanically extracted v3.9.1 reference candidate. NOT a stable Tessera runtime.',
    `// Original SHA-256: ${REFERENCE_SHA256}`,
    '// Only the build-time clock adapter has changed. Browser output is checked for byte parity.',
    assertBuildTimestamp.toString(), '', builder, '',
  ].join('\n');
  if (sha256(code) !== MODULE_SHA256) throw new Error('Adapted module checksum mismatch.');
  return code;
}

export async function prepareBuiltinRuntime(root = ROOT) {
  const parts = await Promise.all([0, 1, 2, 3].map((i) => readFile(resolve(root, `vendor/reference391/builder.part${i}.b64`), 'utf8')));
  const original = decodeBuilder(parts);
  const code = adaptBuilder(original);
  const sourceFiles = [
    'worker/runtime-compiler.ts', 'worker/runtime/reference-bridge.mjs',
    'worker/runtime/consent-timer.mjs', 'worker/runtime/version-pin.mjs',
    'worker/runtime/preview-snapshot.mjs',
    'worker/runtime/artifact-candidate.mjs', 'worker/runtime/artifact-styles.mjs',
    'worker/runtime/artifact-minifier.mjs', 'worker/runtime/prebid-artifact-check.mjs', 'package-lock.json',
  ];
  const components = [{ path: 'reference391.mjs', sha256: MODULE_SHA256 }];
  for (const path of sourceFiles) components.push({ path, sha256: sha256(await readFile(resolve(root, path))) });
  components.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const codeSha256 = sha256(JSON.stringify(components));
  assertRuntimeReleaseSource(codeSha256,currentRuntimeRelease);
  const { id, version, configSchemaVersion, channel, capabilities } = currentRuntimeRelease;
  const descriptor = { id, version, codeSha256, configSchemaVersion, channel, capabilities };
  await mkdir(resolve(root, '.generated'), { recursive: true });
  await writeFile(resolve(root, '.generated/reference391.mjs'), code);
  await writeFile(resolve(root, '.generated/reference391-original.js'), original);
  await writeFile(resolve(root, '.generated/runtime-manifest.mjs'),
    `// Generated from checksum-verified source; no network or runtime eval.\nexport const descriptor = ${JSON.stringify(descriptor, null, 2)};\nexport const sourceComponents = ${JSON.stringify(components, null, 2)};\n`);
  await prepareNextRuntime(root);
  await prepareCreativeRuntime(root);
  await prepareReportingRuntime(root);
  await prepareTestPageClient(root);
  return descriptor;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await prepareBuiltinRuntime(), null, 2));
}
