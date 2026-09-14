// Test-only Node resolution for legacy Vite-style extensionless worker imports.
// This is never included in the Worker bundle.
import { access } from 'node:fs/promises';
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier,context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || /\.[a-z]+$/i.test(specifier)) throw error;
    const url = new URL(specifier+'.ts',context.parentURL);
    if (!url.pathname.includes('/worker/')) throw error;
    try { await access(url); } catch { throw error; }
    return nextResolve(url.href,context);
  }
}
