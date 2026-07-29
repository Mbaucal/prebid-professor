import { useEffect } from 'react';
import { api } from '../api';
import type { PublisherAccount, Site } from '../shared/types';

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

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, '');
}

function activeSiteFromPage(accounts: PublisherAccount[], page: Element): Site | null {
  const input = page.querySelector<HTMLInputElement>('.ads-txt-url-row input');
  const value = input?.value.trim() ?? '';
  if (value) {
    try {
      const hostname = normalizedHost(new URL(value).hostname);
      const site = accounts.flatMap((account) => account.sites)
        .find((candidate) => normalizedHost(candidate.domain) === hostname);
      if (site) return site;
    } catch {
      // Fall through to the active sidebar label.
    }
  }

  const activeSiteName = document.querySelector('.site-link.active span')?.textContent?.trim() ?? '';
  if (!activeSiteName) return null;
  const matches = accounts.flatMap((account) => account.sites).filter((site) => site.name === activeSiteName);
  return matches.length === 1 ? matches[0] : null;
}

function labelFromLine(line: string): string {
  const commentIndex = line.indexOf('#');
  if (commentIndex >= 0) {
    const comment = line.slice(commentIndex + 1).trim().replace(/^#+\s*/, '');
    if (comment) return comment.slice(0, 120);
  }
  return line.split('#')[0].split(',')[0]?.trim() || 'Ads.txt';
}

function exactRowsFromAdsTxt(text: string): Array<{ sourceLabel: string; entry: string; required: boolean }> {
  let activeLabel = '';
  const rows: Array<{ sourceLabel: string; entry: string; required: boolean }> = [];
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      activeLabel = line.replace(/^#+\s*/, '').trim().slice(0, 120);
      continue;
    }
    rows.push({
      sourceLabel: activeLabel || labelFromLine(line),
      entry: line,
      required: true,
    });
  }
  return rows;
}

async function importExactAdsTxt(
  page: Element,
  accounts: PublisherAccount[],
  file: File,
  replaceExisting: boolean,
): Promise<void> {
  const site = activeSiteFromPage(accounts, page);
  if (!site) throw new Error('The active site could not be resolved safely. Refresh the page and try again.');
  const rows = exactRowsFromAdsTxt(await file.text());
  if (!rows.length) throw new Error('No valid ads.txt rows were found in the selected file.');
  if (rows.length > 5_000) throw new Error('Import at most 5,000 ads.txt rows at once.');

  const response = await fetch(`/api/publishers/${encodeURIComponent(site.id)}/ads-txt/requirements/import`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ rows, replaceExisting }),
  });
  const payload = await response.json().catch(() => null) as { error?: string; imported?: number; duplicatesKept?: number } | null;
  if (!response.ok) throw new Error(payload?.error || `Import failed with status ${response.status}.`);
  const duplicates = payload?.duplicatesKept ?? 0;
  window.sessionStorage.setItem(
    'tessera:ads-txt-import-message',
    `Imported ${payload?.imported ?? rows.length} rows${duplicates ? `; kept ${duplicates} duplicate canonical row${duplicates === 1 ? '' : 's'} for review` : ''}.`,
  );
  window.location.reload();
}

export default function AdsTxtRequirementDuplicateGuard() {
  useEffect(() => {
    const searchCleanups = new Map<HTMLInputElement, () => void>();
    const fileCleanups = new Map<HTMLInputElement, () => void>();
    const buttonCleanups = new Map<HTMLButtonElement, () => void>();
    const selectedFiles = new Map<Element, File>();
    let accounts: PublisherAccount[] = [];
    let disposed = false;

    void api.listPublisherAccounts().then((items) => {
      if (!disposed) accounts = items;
    }).catch(() => {
      if (!disposed) accounts = [];
    });

    const apply = () => {
      const page = document.querySelector('.ads-txt-page');
      if (!page) return;
      const card = page.querySelector<HTMLElement>('#ads-txt-saved-requirements');
      if (!card) return;

      const storedMessage = window.sessionStorage.getItem('tessera:ads-txt-import-message');
      if (storedMessage && !page.querySelector('.ads-txt-restored-import-message')) {
        window.sessionStorage.removeItem('tessera:ads-txt-import-message');
        const message = document.createElement('div');
        message.className = 'ads-txt-success ads-txt-message ads-txt-restored-import-message';
        message.textContent = `✓ ${storedMessage}`;
        page.querySelector('.ads-txt-heading')?.insertAdjacentElement('afterend', message);
      }

      const kicker = card.querySelector<HTMLElement>('.panel-kicker');
      if (kicker) kicker.textContent = 'Monitoring requirements';

      let note = card.querySelector<HTMLElement>('.ads-txt-duplicate-requirement-note');
      if (!note) {
        note = document.createElement('div');
        note.className = 'ads-txt-success ads-txt-message ads-txt-duplicate-requirement-note';
        note.textContent = 'Partner rows are kept as separate requirements, even when they resolve to the same canonical ads.txt record. Edit or delete each row independently; checker emails still deduplicate the canonical missing line.';
        const toolbar = card.querySelector('.ads-txt-list-toolbar');
        toolbar?.insertAdjacentElement('beforebegin', note);
      }

      const searchInput = card.querySelector<HTMLInputElement>('input[type="search"]');
      if (searchInput) {
        searchInput.placeholder = 'Search source, domain, seller ID or complete requirement…';
        searchInput.setAttribute('aria-label', 'Search all saved monitoring requirement rows');
        searchInput.autocomplete = 'off';
        if (!searchCleanups.has(searchInput)) {
          const onPaste = (event: ClipboardEvent) => {
            const pasted = event.clipboardData?.getData('text') ?? '';
            if (!pasted) return;
            const normalized = canonicalSearchText(pasted);
            if (!normalized) return;
            event.preventDefault();
            setNativeInputValue(searchInput, normalized);
          };
          searchInput.addEventListener('paste', onPaste, true);
          searchCleanups.set(searchInput, () => searchInput.removeEventListener('paste', onPaste, true));
        }
      }

      const importSection = Array.from(page.querySelectorAll<HTMLElement>('.ads-txt-tool-section'))
        .find((section) => section.querySelector('input[type="file"]'));
      const fileInput = importSection?.querySelector<HTMLInputElement>('input[type="file"]') ?? null;
      const importButton = importSection
        ? Array.from(importSection.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Import rows')) ?? null
        : null;
      if (fileInput && importSection && !fileCleanups.has(fileInput)) {
        const onChange = () => {
          const file = fileInput.files?.[0];
          if (!file) return;
          if (file.name.toLowerCase().endsWith('.txt') || file.type === 'text/plain') selectedFiles.set(importSection, file);
          else selectedFiles.delete(importSection);
        };
        fileInput.addEventListener('change', onChange, true);
        fileCleanups.set(fileInput, () => fileInput.removeEventListener('change', onChange, true));
      }
      if (importButton && importSection && !buttonCleanups.has(importButton)) {
        const onClick = (event: MouseEvent) => {
          const file = selectedFiles.get(importSection);
          if (!file) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          const replaceExisting = importSection.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked === true;
          importButton.disabled = true;
          importButton.textContent = 'Importing exact rows…';
          void importExactAdsTxt(page, accounts, file, replaceExisting).catch((error: unknown) => {
            importButton.disabled = false;
            importButton.textContent = 'Import rows';
            window.alert(error instanceof Error ? error.message : 'The ads.txt file could not be imported.');
          });
        };
        importButton.addEventListener('click', onClick, true);
        buttonCleanups.set(importButton, () => importButton.removeEventListener('click', onClick, true));
      }

      for (const [candidate, cleanup] of searchCleanups) {
        if (candidate.isConnected) continue;
        cleanup();
        searchCleanups.delete(candidate);
      }
      for (const [candidate, cleanup] of fileCleanups) {
        if (candidate.isConnected) continue;
        cleanup();
        fileCleanups.delete(candidate);
      }
      for (const [candidate, cleanup] of buttonCleanups) {
        if (candidate.isConnected) continue;
        cleanup();
        buttonCleanups.delete(candidate);
      }
    };

    const root = document.getElementById('root');
    const observer = new MutationObserver(apply);
    if (root) observer.observe(root, { childList: true, subtree: true });
    const interval = window.setInterval(apply, 500);
    apply();

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearInterval(interval);
      searchCleanups.forEach((cleanup) => cleanup());
      fileCleanups.forEach((cleanup) => cleanup());
      buttonCleanups.forEach((cleanup) => cleanup());
      searchCleanups.clear();
      fileCleanups.clear();
      buttonCleanups.clear();
      selectedFiles.clear();
    };
  }, []);

  return null;
}
