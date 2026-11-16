import { useEffect, useRef, useState, type ReactNode } from 'react';

type Props = {
  navigation: ReactNode;
  sidebarContent: ReactNode;
  account: ReactNode;
  children: ReactNode;
  logoSrc?: string;
};

/** The dashboard and TEST layout preview share the same viewport and scroll regions. */
export default function AppFrame({ navigation, sidebarContent, account, children, logoSrc = "/tessera-logo.png?v=20" }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  function closeMenu() {
    setMenuOpen(false);
    toggle.current?.focus();
  }

  return (
    <div className={`app-shell${menuOpen ? ' navigation-open' : ''}`}>
      <aside className="sidebar" aria-label="Tessera navigation" onKeyDown={event => {
        if (event.key === 'Escape' && menuOpen) closeMenu();
      }}>
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><img src={logoSrc} alt="" /></div>
          <div><strong>Tessera</strong><span>Ad-tech control plane</span></div>
          <button ref={toggle} className="sidebar-toggle" type="button" aria-expanded={menuOpen}
            aria-controls="sidebar-menu" onClick={() => setMenuOpen(open => !open)}>
            {menuOpen ? 'Close menu' : 'Menu'}
          </button>
        </div>
        <div id="sidebar-menu" className="sidebar-menu" onClick={event => {
          // Close the compact navigation after choosing a destination, not editing a publisher.
          if (menuOpen && (event.target as HTMLElement).closest('.nav-item, .publisher-account-link, .site-link:not(.add-site-link), .global-sidebar-context button, .agency-tree-tools .publisher-link')) closeMenu();
        }}>
          <div className="sidebar-navigation">{navigation}</div>
          <div className="sidebar-content" role="region" aria-label="Publisher navigation" tabIndex={0}>{sidebarContent}</div>
        </div>
        <div className="sidebar-footer">{account}</div>
      </aside>
      {children}
    </div>
  );
}

export function WorkspaceContent({ pageKey, children }: { pageKey: string; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => { content.current?.scrollTo(0, 0); }, [pageKey]);
  return <div ref={content} className="workspace-content" role="region" aria-label="Workspace content" tabIndex={0}>{children}</div>;
}
