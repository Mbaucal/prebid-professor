import { useState } from 'react';
import MinimumHeightCssExport from '../components/MinimumHeightCssExport';
import { formatMinimumHeightCss } from '../export/min-height-css';

// Synthetic handoff examples only; no site configuration or ad requests.
const groups: { ids: string[]; rows: [number, number][] }[] = [
  { ids: ['Billboard'], rows: [[0, 100], [469, 100], [768, 200], [1024, 250]] },
  { ids: Array.from({ length: 4 }, (_, i) => `Billboard_${i + 2}`), rows: [[0, 0], [768, 200], [1024, 250]] },
  { ids: Array.from({ length: 7 }, (_, i) => `P${i + 1}`), rows: [[0, 250], [469, 250], [768, 600]] },
  { ids: [...Array.from({ length: 10 }, (_, i) => `InText_${i + 1}`), 'Under_Article_1'], rows: [[0, 280], [469, 280]] },
  { ids: ['Branding_Left', 'Branding_Right'], rows: [[0, 0], [1300, 600]] },
];
const cssText = formatMinimumHeightCss(groups.flatMap(({ ids, rows }) => ids.flatMap((id) => rows.map(([width, height]) => {
  const rule = `#${id}{min-height:${height}px;}`;
  return width === 0 ? rule : `@media(min-width:${width}px){${rule}}`;
}))).join('\n'));

export default function MinimumHeightCssPreview() {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(cssText);
      setCopied(true);
      setError('');
    } catch {
      setError('Clipboard access was blocked by the browser. Select the CSS below to copy it manually.');
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([cssText], { type: 'text/css;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'min-height-example.css';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
  return <section className="export-page">
    <p>TEST primer: isti CSS prikaz kao u Export delu Tessere, sa generičkim pozicijama. Copy i Download sadrže komentare i grupisane pozicije.</p>
    {error && <p role="alert">{error}</p>}
    <MinimumHeightCssExport cssText={cssText} copied={copied} onCopy={() => void copy()} onDownload={download} />
  </section>;
}
