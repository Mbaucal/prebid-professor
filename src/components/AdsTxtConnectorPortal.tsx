import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import AdsTxtCmsConnectionPanel from './AdsTxtCmsConnectionPanel';

const PORTAL_ID = 'ads-txt-cms-connection-portal';

export default function AdsTxtConnectorPortal() {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let currentHost: HTMLElement | null = null;

    const sync = () => {
      const page = document.querySelector<HTMLElement>('.ads-txt-page');
      if (!page) {
        if (currentHost && !currentHost.isConnected) {
          currentHost = null;
          setHost(null);
        }
        return;
      }

      let target = page.querySelector<HTMLElement>(`#${PORTAL_ID}`);
      if (!target) {
        target = document.createElement('div');
        target.id = PORTAL_ID;
        target.className = 'ads-txt-cms-portal';
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

  return host ? createPortal(<AdsTxtCmsConnectionPanel />, host) : null;
}
