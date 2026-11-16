/** Render the actual Debug panel; browser test intercepts all traffic. */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
const out = '.generated/schain-debug-fixture';
await mkdir(out, { recursive: true });
await build({ stdin: { contents: `
  import {createRoot} from 'react-dom/client';
  import DebugConsolePanel from './src/components/DebugConsolePanel';
  import './src/dashboard-styles';
  createRoot(document.getElementById('root')).render(<DebugConsolePanel publisherId="test-site" siteName="Fixture publisher" domain="publisher.invalid"/>);
`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, outfile: out + '/app.js', jsx: 'automatic', format: 'iife', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' } });
await writeFile(out + '/index.html', '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>html,body{height:auto;overflow:auto}#root{min-width:0}</style><div id="root"></div><script src="/app.js"></script>');
console.log('Built minified Debug panel fixture');
