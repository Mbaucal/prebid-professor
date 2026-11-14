import { parse } from 'acorn';

/** A compiled Worker may wrap function names with private esbuild helpers.
 * Those helpers cannot be copied into a standalone publisher script.
 * Inspect syntax, not raw text: partner parameters may legitimately contain
 * the same characters inside a string or comment.
 */
export function assertGeneratedBundleStandalone(candidate) {
  for (const name of ['ads.js', 'ads.min.js']) {
    const bytes = candidate?.files?.[name];
    if (!(bytes instanceof Uint8Array)) throw new Error('The generated script file is missing. Generate a new package.');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const nodes = [parse(source, { ecmaVersion: 'latest', sourceType: 'script' })];
    while (nodes.length) {
      const node = nodes.pop();
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === '__name') {
        throw new Error('This script could not be generated as a standalone file. Select script version 3.13.0 or newer and generate again. Existing packages are kept.');
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const child of value) if (child && typeof child.type === 'string') nodes.push(child);
        } else if (value && typeof value.type === 'string') nodes.push(value);
      }
    }
  }
  return candidate;
}
