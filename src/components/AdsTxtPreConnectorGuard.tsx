import { useEffect } from 'react';

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export default function AdsTxtPreConnectorGuard() {
  useEffect(() => {
    const cleanups = new Map<HTMLInputElement, () => void>();

    const apply = () => {
      const page = document.querySelector('.ads-txt-page');
      if (!page) return;

      document.getElementById('ads-txt-source-editor-portal')?.remove();
      page.querySelectorAll<HTMLElement>('.ads-txt-live-search-panel').forEach((panel) => {
        panel.hidden = true;
      });

      const requirementsCard = page.querySelector('#ads-txt-saved-requirements');
      const kicker = requirementsCard?.querySelector('.panel-kicker');
      if (kicker && kicker.textContent !== 'Monitoring requirements') {
        kicker.textContent = 'Monitoring requirements';
      }

      page.querySelectorAll<HTMLButtonElement>('.ads-txt-duplicate-list button').forEach((button) => {
        if (button.textContent !== 'Search monitoring requirement') {
          button.textContent = 'Search monitoring requirement';
        }
      });

      const input = requirementsCard?.querySelector<HTMLInputElement>('input[type="search"]');
      if (!input) return;
      input.placeholder = 'Search source, domain, seller ID or complete requirement…';
      input.setAttribute('aria-label', 'Search canonical monitoring requirements');
      input.autocomplete = 'off';

      if (cleanups.has(input)) return;
      const onPaste = (event: ClipboardEvent) => {
        const pasted = event.clipboardData?.getData('text') ?? '';
        if (!pasted) return;
        event.preventDefault();
        const normalized = pasted.replace(/\r?\n/g, ' ').trim();
        setNativeInputValue(input, normalized);
      };
      input.addEventListener('paste', onPaste, true);
      cleanups.set(input, () => input.removeEventListener('paste', onPaste, true));

      for (const [candidate, cleanup] of cleanups) {
        if (candidate.isConnected) continue;
        cleanup();
        cleanups.delete(candidate);
      }
    };

    const root = document.getElementById('root');
    const observer = new MutationObserver(apply);
    if (root) observer.observe(root, { childList: true, subtree: true });
    const interval = window.setInterval(apply, 500);
    apply();

    return () => {
      observer.disconnect();
      window.clearInterval(interval);
      cleanups.forEach((cleanup) => cleanup());
      cleanups.clear();
    };
  }, []);

  return null;
}
