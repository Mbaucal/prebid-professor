import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const result = await build({ absWorkingDir: fileURLToPath(root), entryPoints: ['src/layout-preview/entry.tsx'], bundle: true, write: false,
  outdir: '.generated/layout-preview', format: 'iife', platform: 'browser', jsx: 'automatic', minify: true, target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' } });
const js = result.outputFiles.find(file => file.path.endsWith('.js'))?.text;
const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text;
if (!js || !css) throw Error('Layout preview assets missing');
const logo = readFileSync(new URL('public/tessera-logo.png', root)).toString('base64');
mkdirSync(new URL('.generated/', root), { recursive: true });
writeFileSync(new URL('.generated/layout-preview.mjs', root), `export const layoutJs=${JSON.stringify(js)};\nexport const layoutCss=${JSON.stringify(css)};\nexport const layoutLogo=${JSON.stringify(logo)};\n`);
