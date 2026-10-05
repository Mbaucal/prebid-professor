import { useEffect } from 'react';

const TESSERA_LOGO_URL = '/tessera-logo.png?v=21';
const TESSERA_ICON_URL = '/favicon.ico?v=21';

function ensureIcon(rel: 'icon' | 'apple-touch-icon'): void {
  let link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!link) {
    link = document.createElement('link');
    link.rel = rel;
    document.head.appendChild(link);
  }
  const url = rel === 'icon' ? TESSERA_ICON_URL : TESSERA_LOGO_URL;
  if (link.getAttribute('href') !== url) link.href = url;
  if (rel === 'icon') {
    link.type = 'image/x-icon';
    link.sizes = '16x16 32x32 48x48';
  }
}

function applyBranding(): void {
  if (document.title !== 'Tessera') document.title = 'Tessera';
  ensureIcon('icon');
  ensureIcon('apple-touch-icon');

  const brand = document.querySelector<HTMLElement>('.brand');
  if (brand) {
    const mark = brand.querySelector<HTMLElement>('.brand-mark');
    if (mark) {
      mark.setAttribute('aria-hidden', 'true');
      let image = mark.querySelector<HTMLImageElement>('img');
      if (!image) {
        mark.replaceChildren();
        image = document.createElement('img');
        image.alt = '';
        mark.appendChild(image);
      }
      if (image.getAttribute('src') !== TESSERA_LOGO_URL) image.src = TESSERA_LOGO_URL;
    }

    const name = brand.querySelector<HTMLElement>('strong');
    if (name && name.textContent !== 'Tessera') name.textContent = 'Tessera';
  }

  document.querySelectorAll<HTMLElement>('h1').forEach((heading) => {
    if (heading.textContent?.trim() === 'Prebid Professor') heading.textContent = 'Tessera';
  });
}

export default function TesseraBranding() {
  useEffect(() => {
    applyBranding();
    const root = document.getElementById('root');
    if (!root) return undefined;

    const observer = new MutationObserver(applyBranding);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
