import { useEffect } from 'react';

function applyBranding(): void {
  document.title = 'Tessera';

  const brand = document.querySelector<HTMLElement>('.brand');
  if (brand) {
    const mark = brand.querySelector<HTMLElement>('.brand-mark');
    if (mark && !mark.querySelector('img')) {
      mark.textContent = '';
      mark.setAttribute('aria-hidden', 'true');
      const image = document.createElement('img');
      image.alt = '';
      image.src = '/tessera-logo.svg';
      mark.appendChild(image);
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
