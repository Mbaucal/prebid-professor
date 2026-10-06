import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import AdsTxtManagedFilePanel from './AdsTxtManagedFilePanel';

const PORTAL_ID = 'ads-txt-managed-file-portal';
const VERSIONS_PORTAL_ID = 'ads-txt-versions-portal';
const CMS_PORTAL_ID = 'ads-txt-cms-connection-portal';

export default function AdsTxtManagedFilePortal() {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let currentHost: HTMLElement | null = null;

    const sync = (): void => {
      const page = document.querySelector<HTMLElement>('.ads-txt-page');
      if (!page) {
        if (currentHost?.isConnected) currentHost.remove();
        currentHost = null;
        setHost(null);
        return;
      }

      let target = page.querySelector<HTMLElement>(`#${PORTAL_ID}`);
      if (!target) {
        target = document.createElement('div');
        target.id = PORTAL_ID;
        target.className = 'ads-txt-managed-file-portal';
      }

      const versionsPortal = page.querySelector<HTMLElement>(`#${VERSIONS_PORTAL_ID}`);
      const cmsPortal = page.querySelector<HTMLElement>(`#${CMS_PORTAL_ID}`);
      const anchor = versionsPortal ?? cmsPortal;
      if (anchor) {
        if (target.parentElement !== page || target.nextElementSibling !== anchor) {
          page.insertBefore(target, anchor);
        }
      } else if (target.parentElement !== page) {
        page.appendChild(target);
      }

      if (target !== currentHost) {
        currentHost = target;
        setHost(target);
      }
    };

    const root = document.getElementById('root');
    const observer = new MutationObserver(sync);
    if (root) observer.observe(root, { childList: true, subtree: true });
    sync();

    return () => {
      observer.disconnect();
      currentHost?.remove();
      currentHost = null;
      setHost(null);
    };
  }, []);

  return host ? createPortal(<AdsTxtManagedFilePanel />, host) : null;
}
