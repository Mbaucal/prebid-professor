import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const result = await build({ absWorkingDir: fileURLToPath(root), entryPoints: ['src/preview/ads-versions.tsx'],
  bundle: true, write: false, outdir: '.generated/ads-versions-assets', format: 'iife', platform: 'browser',
  jsx: 'automatic', minify: true, target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' } });
const js = result.outputFiles.find(file => file.path.endsWith('.js'))?.text;
const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text;
if (!js || !css) throw new Error('Both ads-version review assets must be generated.');
mkdirSync(new URL('.generated/', root), { recursive: true });
writeFileSync(new URL('.generated/ads-versions-preview.mjs', root),
  `// Generated UI review assets only; no database or network access.\nexport const reviewJs=${JSON.stringify(js)};\nexport const reviewCss=${JSON.stringify(css)};\n`);
console.log('Prepared ads.js version UI review from the shared React component.');
