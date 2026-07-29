import { useEffect } from 'react';

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function canonicalSearchText(value: string): string {
  const firstLine = value.replace(/^\uFEFF/, '').split(/\r?\n/).find((line) => line.trim()) ?? '';
  const commentIndex = firstLine.indexOf('#');
  return (commentIndex >= 0 ? firstLine.slice(0, commentIndex) : firstLine).trim();
}

export default function AdsTxtRequirementDuplicateGuard() {
  useEffect(() => {
    const cleanups = new Map<HTMLInputElement, () => void>();

    const apply = () => {
      const page = document.querySelector('.ads-txt-page');
      if (!page) return;
      const card = page.querySelector<HTMLElement>('#ads-txt-saved-requirements');
      if (!card) return;

      const kicker = card.querySelector<HTMLElement>('.panel-kicker');
      if (kicker) kicker.textContent = 'Monitoring requirements';

      let note = card.querySelector<HTMLElement>('.ads-txt-duplicate-requirement-note');
      if (!note) {
        note = document.createElement('div');
        note.className = 'ads-txt-success ads-txt-message ads-txt-duplicate-requirement-note';
        note.textContent = 'Partner rows are kept exactly as separate requirements, even when they resolve to the same canonical ads.txt record. Edit or delete each row independently; checker emails still deduplicate the canonical missing line.';
        const toolbar = card.querySelector('.ads-txt-list-toolbar');
        toolbar?.insertAdjacentElement('beforebegin', note);
      }

      const input = card.querySelector<HTMLInputElement>('input[type="search"]');
      if (!input) return;
      input.placeholder = 'Search source, domain, seller ID or complete requirement…';
      input.setAttribute('aria-label', 'Search all saved monitoring requirement rows');
      input.autocomplete = 'off';
      if (cleanups.has(input)) return;

      const onPaste = (event: ClipboardEvent) => {
        const pasted = event.clipboardData?.getData('text') ?? '';
        if (!pasted) return;
        const normalized = canonicalSearchText(pasted);
        if (!normalized) return;
        event.preventDefault();
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
