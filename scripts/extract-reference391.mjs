/** Developer-only migration tool. Never loaded by the public wrapper. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REFERENCE_SHA256 = '40e1ac4e546f0786fff95e236d9fd5fab36fcdf57ff3ff22ce8198c4751aea57';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function assertBuildTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{8}_\d{6}$/.test(value)) {
    throw new Error('An explicit buildTimestamp in YYYYMMDD_HHmmss format is required.');
  }
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.000Z`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) {
    throw new Error('buildTimestamp is not a valid UTC date.');
  }
  return value;
}

function replaceOnce(text, before, after) {
  const index = text.indexOf(before);
  if (index < 0 || text.indexOf(before, index + before.length) >= 0) {
    throw new Error('Reference structure changed; review the migration instead of guessing.');
  }
  return text.slice(0, index) + after + text.slice(index + before.length);
}

export function extractReference391(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Pass original source bytes.');
  if (sha256(bytes) !== REFERENCE_SHA256) {
    throw new Error('Reference checksum mismatch; refusing to migrate a different source.');
  }
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const startMarker = 'function buildScript(st) {';
  const endMarker = "    return out.replace('__SCHAIN_CONFIG_LINE__', SCHAIN_CONFIG_LINE);\n}";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < start) throw new Error('Reference builder boundaries not found.');
  let builder = source.slice(start, end + endMarker.length);
  builder = replaceOnce(builder, startMarker,
    'export function buildReference391(st, options = {}) {\n    const buildTimestamp = assertBuildTimestamp(options.buildTimestamp);');
  builder = replaceOnce(builder,
    '    const BUILD_TS = Utilities.formatDate(\n        new Date(),\n        Session.getScriptTimeZone(),\n        "yyyyMMdd_HHmmss"\n    );',
    '    const BUILD_TS = buildTimestamp;');
  const code = [
    '// Mechanically extracted v3.9.1 reference candidate. NOT a stable Tessera runtime.',
    `// Original SHA-256: ${REFERENCE_SHA256}`,
    '// Only the build-time clock adapter has changed. Browser output is checked for byte parity.',
    assertBuildTimestamp.toString(), '', builder, '',
  ].join('\n');
  return {
    code,
    manifest: {
      extractionVersion: 1,
      referenceVersion: '3.9.1',
      sourceSha256: REFERENCE_SHA256,
      moduleSha256: sha256(code),
      byteSize: Buffer.byteLength(code, 'utf8'),
      productionReady: false,
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('Usage: node scripts/extract-reference391.mjs <original-reference.txt> <new-module.mjs>');
    process.exitCode = 1;
  } else {
    const result = extractReference391(await readFile(input));
    // New immutable path only; accidental overwrites are not allowed.
    await writeFile(output, result.code, { flag: 'wx' });
    console.log(JSON.stringify(result.manifest, null, 2));
  }
}
