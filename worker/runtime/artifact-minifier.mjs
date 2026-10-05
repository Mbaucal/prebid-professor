import { minify } from 'terser';
// Deliberately conservative first release: parser-based formatting, no property/name
// mangling or optimizer transforms. No regex comment stripping and no remote compiler.
export const MINIFIER = Object.freeze({ name: 'terser', version: '5.44.0', compress: false, mangle: false });
export async function finalizeJavaScript(source, { cleanComments = true } = {}) {
  if (typeof source !== 'string' || !source.trim() || source.length > 1_000_000) throw new Error('Invalid generated JavaScript length.');
  if (typeof cleanComments !== 'boolean') throw new Error('cleanComments must be a boolean.');
  const settings = { ecma: 2015, compress: false, mangle: false, module: false,
    format: { comments: false, inline_script: true, semicolons: true, ascii_only: true } };
  try {
    const compact = await minify(source, settings);
    const readable = cleanComments ? await minify(source, { ...settings, format: { ...settings.format, beautify: true } }) : { code: source };
    if (!compact.code?.trim() || !readable.code?.trim()) throw new Error('Empty compiler output.');
    return { adsJs: `${readable.code.trim()}\n`, adsMinJs: `${compact.code.trim()}\n`, minifier: MINIFIER };
  } catch {
    throw new Error('Generated JavaScript failed parser validation; no artifact bundle was produced.');
  }
}
