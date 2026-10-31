/** Format generated placeholders without changing their breakpoint cascade. */
export function formatMinimumHeightCss(css: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  const widths = new Map<number, Map<string, number>>();
  const lastWidth = new Map<string, number>();
  const selectorPattern = /^#[A-Za-z](?:[A-Za-z0-9_-]|\\:)*$/;
  let offset = 0;

  function skipSpace() {
    while (/\s/.test(source[offset] ?? '') && offset < source.length) offset++;
  }

  function readRule(width: number): boolean {
    skipSpace();
    const rule = /^([^{}]+)\{\s*min-height\s*:\s*(\d+)(px)?\s*;?\s*\}/.exec(source.slice(offset));
    if (!rule) return false;
    const height = Number(rule[2]);
    if (!Number.isSafeInteger(height) || (!rule[3] && height !== 0)) return false;
    const selectors = rule[1].split(',').map((selector) => selector.trim());
    if (selectors.some((selector) => !selectorPattern.test(selector) || (lastWidth.get(selector) ?? 0) > width)) return false;
    const entries = widths.get(width) ?? new Map<string, number>();
    for (const selector of selectors) {
      entries.set(selector, height);
      lastWidth.set(selector, width);
    }
    widths.set(width, entries);
    offset += rule[0].length;
    return true;
  }

  while (offset < source.length) {
    skipSpace();
    if (offset === source.length) break;
    const media = /^@media\s*\(\s*min-width\s*:\s*(\d+)px\s*\)\s*\{/.exec(source.slice(offset));
    if (media) {
      const width = Number(media[1]);
      if (!Number.isSafeInteger(width)) return css;
      offset += media[0].length;
      skipSpace();
      while (source[offset] !== '}') {
        if (!readRule(width)) return css;
        skipSpace();
      }
      offset++;
    } else if (!readRule(0)) {
      // Leave custom selectors, declarations and media conditions untouched.
      return css;
    }
  }
  if (!widths.size) return css;

  const sortedWidths = [...widths.keys()].sort((a, b) => a - b);
  const firstMediaWidth = sortedWidths.find((width) => width > 0);
  const leadingComments = css.match(/^\s*(?:\/\*[\s\S]*?\*\/\s*)+/)?.[0].match(/\/\*[\s\S]*?\*\//g) ?? [];
  const headers = leadingComments.filter((comment) => !/^\/\*\s*(?:>=|≥|\d+\s*(?:px|[–-]))/.test(comment));
  const blocks = sortedWidths.map((width) => {
    const groups = new Map<number, string[]>();
    for (const [selector, height] of widths.get(width)!) {
      groups.set(height, [...(groups.get(height) ?? []), selector]);
    }
    const indent = width === 0 ? '' : '  ';
    const rules = [...groups.entries()].sort(([a], [b]) => a - b)
      .map(([height, selectors]) => `${indent}${selectors.join(', ')} { min-height: ${height}px; }`)
      .join('\n\n');
    if (width === 0) return `/* ${firstMediaWidth ? `0–${firstMediaWidth - 1}px` : '>= 0px'} */\n${rules}`;
    return `/* >= ${width}px */\n@media (min-width: ${width}px) {\n${rules}\n}`;
  });
  return `${[...headers, ...blocks].join('\n\n')}\n`;
}
