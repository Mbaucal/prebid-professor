import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import AdsTxtVersionsPanel from './AdsTxtVersionsPanel';

const PORTAL_ID = 'ads-txt-versions-portal';
const MANAGED_PORTAL_ID = 'ads-txt-managed-file-portal';
const CMS_PORTAL_ID = 'ads-txt-cms-connection-portal';

export default function AdsTxtVersionsPortal() {
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
        target.className = 'ads-txt-versions-portal';
      }

      const cmsPortal = page.querySelector<HTMLElement>(`#${CMS_PORTAL_ID}`);
      const managedPortal = page.querySelector<HTMLElement>(`#${MANAGED_PORTAL_ID}`);
      if (cmsPortal) {
        if (target.parentElement !== page || target.nextElementSibling !== cmsPortal) {
          page.insertBefore(target, cmsPortal);
        }
      } else if (managedPortal) {
        if (target.parentElement !== page || managedPortal.nextElementSibling !== target) {
          managedPortal.insertAdjacentElement('afterend', target);
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

  return host ? createPortal(<AdsTxtVersionsPanel />, host) : null;
}
