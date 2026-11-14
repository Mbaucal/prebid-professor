const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const script = (s) => String(s).replace(/<\/script/gi, '<\\/script');

/** Only used inside an opaque sandbox with no external network capabilities. */
export function tanjugPreview(files, units, mockSource) {
  const decode = (name) => new TextDecoder().decode(files[name]);
  const positions = units.filter((u) => u.code !== 'Sticky').map((u) => `<section><h2>${escape(u.code)} <small>${escape(u.type)}</small></h2><div id="${escape(u.code)}" class="wrapperAd${u.type === 'BTF' ? ' lazyAd' : ''}"></div></section>`).join('\n');
  return `<!doctype html><html lang="sr-Latn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tanjug — probni baneri</title>
<style>body{margin:0;padding:16px 0 180px;background:#f4f6f9;color:#263347;font:16px system-ui}header{padding:0 20px}h1{font-size:24px}h2{font-size:16px;margin:0 0 12px}small{font-weight:400;color:#667085}section{margin:20px auto;padding:12px 0;background:white;border-top:1px solid #dbe2ea;max-width:1200px;overflow:hidden}section h2{padding:0 16px}.wrapperAd{text-align:center}p{line-height:1.6}</style>
<style>${decode('min-height.css')}</style></head><body><header><h1>Tanjug · probne pozicije</h1><p>Probni baneri, bez stvarne aukcije. Skroluj kroz pozicije; Sticky se prikazuje pri dnu. TakeOver je isključen.</p></header>${positions}
<script>${script(mockSource)}</script>
<script>${script(decode('ads.min.js'))}</script>
</body></html>`;
}
