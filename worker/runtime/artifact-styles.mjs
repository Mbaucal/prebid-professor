/** The injected sticky stylesheet and exported sticky.css share this exact source. */
function cssId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_:-]*$/.test(value)) throw new Error('Invalid ad unit ID for generated CSS.');
  return `#${value.replace(/([^A-Za-z0-9_-])/g, '\\$1')}`;
}
export function stickyStyles(bottomId) {
  if (!bottomId) return '';
  const id = cssId(bottomId);
  return `${id}{position:fixed;left:0;right:0;bottom:0;width:100%;z-index:2147483000;display:flex;justify-content:center;align-items:flex-start;background:rgba(247,247,247,.85);border-top:1px solid #ccc;padding:5px 0;min-height:50px;opacity:0;visibility:hidden;height:0;transform:translateY(16px);transition:opacity .35s ease-out,visibility .35s ease-out,transform .35s ease-out;overflow:visible}\n` +
    `${id}.ad-loaded{opacity:1;visibility:visible;height:auto;transform:translateY(0)}\n` +
    `${id} #close_sticky_ad{position:absolute!important;right:5px!important;top:6px!important;bottom:auto!important;width:28px!important;height:28px!important;background:#fff!important;border:1px solid #888!important;border-radius:50%!important;cursor:pointer;display:flex!important;align-items:center!important;justify-content:center!important;font-family:Arial,Helvetica,sans-serif!important;font-size:28px!important;color:#333!important;line-height:1!important;text-align:center;box-shadow:0 0 0 3px rgba(255,255,255,.98),0 1px 3px rgba(0,0,0,.2)!important;z-index:2147483647!important;user-select:none!important}\n` +
    `@media(max-width:767px){${id} #close_sticky_ad{top:-8px!important;bottom:auto!important;right:8px!important}}\n`;
}
export function installSharedStickyStyles(source, css) {
  const start = source.indexOf('function ensureStickyCss(){');
  const end = source.indexOf('function ensureStickyClose(){', start);
  if (start < 0 || end <= start || source.lastIndexOf('function ensureStickyCss(){') !== start) {
    throw new Error('Approved sticky CSS insertion point changed; review required.');
  }
  const replacement = `function ensureStickyCss(){
    if(!STICKY_TARGET_ID) return;
    var tag=document.getElementById('adsx-sticky-css');
    if(!tag){tag=document.createElement('style');tag.id='adsx-sticky-css';tag.type='text/css';document.head.appendChild(tag);}
    tag.textContent=${JSON.stringify(css).replace(/</g, '\\u003c')};
  }\n\n`;
  return source.slice(0, start) + replacement + source.slice(end);
}
/** Explicit zero-height reset prevents a disabled/fluid-only breakpoint inheriting old spacing. */
export function placeholderStyles(input) {
  const stickyId = input.options.sticky.bottomAdUnitId;
  const blocks = ['/* Generated responsive placeholders; sticky and TakeOver are excluded. */'];
  for (const unit of input.core.explicitUnits) {
    if (unit.id === stickyId) continue;
    const selector = cssId(unit.id);
    const map = input.core.sizeMapsRaw[unit.sizeMapName];
    if (!Array.isArray(map) || !map.length) throw new Error(`Missing size map for ${unit.id}.`);
    blocks.push(`${selector}{min-height:0;}`);
    const seen = new Set();
    for (const row of [...map].sort((a, b) => a.viewport[0] - b.viewport[0])) {
      const [width, height] = row.viewport;
      if (height !== 0) throw new Error('Height-based size-map breakpoints are not supported by this candidate.');
      if (seen.has(width)) throw new Error('Duplicate size-map breakpoints must be resolved before building a candidate.');
      seen.add(width);
      const numeric = row.sizes.filter(Array.isArray);
      const minHeight = Math.max(0, ...numeric.map((size) => size[1]));
      const rule = `${selector}{min-height:${minHeight}px;}`;
      blocks.push(width === 0 ? rule : `@media(min-width:${width}px){${rule}}`);
    }
  }
  return `${blocks.join('\n')}\n`;
}
