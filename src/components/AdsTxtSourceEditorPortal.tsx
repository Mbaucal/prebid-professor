import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import type { PublisherAccount, Site } from '../shared/types';
import '../ads-txt-source-editor.css';
import AdsTxtSourceEditor from './AdsTxtSourceEditor';

type SearchRequest = {
  query: string;
  requestId: number;
};

function activeSiteFromDom(accounts: PublisherAccount[]): Site | null {
  const activePublisherName = document.querySelector('.publisher-account-link.active span')?.textContent?.trim() ?? '';
  const activeSiteName = document.querySelector('.site-link.active span')?.textContent?.trim() ?? '';
  if (activePublisherName && activeSiteName) {
    const account = accounts.find((candidate) => candidate.name === activePublisherName);
    const site = account?.sites.find((candidate) => candidate.name === activeSiteName);
    if (site) return site;
  }

  const urlInput = document.querySelector<HTMLInputElement>('.ads-txt-page .ads-txt-url-row input');
  const rawUrl = urlInput?.value.trim() ?? '';
  if (!rawUrl) return null;
  try {
    const hostname = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    const exactDomain = accounts.flatMap((account) => account.sites)
      .find((candidate) => candidate.domain.replace(/^www\./, '').toLowerCase() === hostname);
    return exactDomain ?? null;
  } catch {
    return null;
  }
}

function polishLegacyAdsTxtWorkspace(page: Element): void {
  page.querySelectorAll<HTMLButtonElement>('.ads-txt-duplicate-list button').forEach((button) => {
    if (button.textContent !== 'Edit repeated source lines') button.textContent = 'Edit repeated source lines';
  });

  const requirementsCard = page.querySelector('#ads-txt-saved-requirements');
  const kicker = requirementsCard?.querySelector('.panel-kicker');
  if (kicker && kicker.textContent !== 'Monitoring requirements') kicker.textContent = 'Monitoring requirements';

  const input = requirementsCard?.querySelector<HTMLInputElement>('input[type="search"]');
  if (input) {
    input.setAttribute('aria-label', 'Search canonical monitoring requirements');
    input.placeholder = 'Search canonical monitoring requirements…';
  }

  const heading = requirementsCard?.querySelector('h3');
  if (heading && input?.value.trim()) {
    const savedMatches = requirementsCard?.querySelectorAll('.ads-txt-requirement').length ?? 0;
    heading.textContent = `${savedMatches} saved requirement match${savedMatches === 1 ? '' : 'es'}`;
  }
}

export default function AdsTxtSourceEditorPortal() {
  const [accounts, setAccounts] = useState<PublisherAccount[]>([]);
  const [site, setSite] = useState<Site | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [requestedSearch, setRequestedSearch] = useState<SearchRequest>({ query: '', requestId: 0 });

  useEffect(() => {
    let cancelled = false;
    void api.listPublisherAccounts().then((items) => {
      if (!cancelled) setAccounts(items);
    }).catch(() => {
      if (!cancelled) setAccounts([]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let mount: HTMLElement | null = null;

    const resolve = () => {
      const page = document.querySelector('.ads-txt-page');
      if (!page) {
        if (mount?.isConnected) mount.remove();
        mount = null;
        setTarget(null);
        setSite(null);
        return;
      }

      polishLegacyAdsTxtWorkspace(page);
      if (!mount || !mount.isConnected) {
        mount = document.createElement('div');
        mount.id = 'ads-txt-source-editor-portal';
        const urlCard = page.querySelector('.ads-txt-url-card');
        if (urlCard) urlCard.insertAdjacentElement('afterend', mount);
        else page.prepend(mount);
        setTarget(mount);
      }

      const nextSite = activeSiteFromDom(accounts);
      setSite((current) => current?.id === nextSite?.id ? current : nextSite);
    };

    const clickHandler = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      const button = element?.closest<HTMLButtonElement>('.ads-txt-duplicate-list button');
      if (!button) return;
      const entry = button.closest('.ads-txt-duplicate-list > div')?.querySelector('code')?.textContent?.trim() ?? '';
      if (!entry) return;
      event.preventDefault();
      event.stopPropagation();
      setRequestedSearch((current) => ({ query: entry, requestId: current.requestId + 1 }));
      window.requestAnimationFrame(() => {
        document.getElementById('ads-txt-source-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    };

    const observer = new MutationObserver(resolve);
    const root = document.getElementById('root');
    if (root) observer.observe(root, { childList: true, subtree: true });
    const interval = window.setInterval(resolve, 500);
    document.addEventListener('click', clickHandler, true);
    resolve();

    return () => {
      observer.disconnect();
      window.clearInterval(interval);
      document.removeEventListener('click', clickHandler, true);
      if (mount?.isConnected) mount.remove();
    };
  }, [accounts]);

  if (!target || !site) return null;
  return createPortal(
    <AdsTxtSourceEditor requestedSearch={requestedSearch} site={site} />,
    target,
  );
}
