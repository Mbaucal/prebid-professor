import { useState, type DragEvent } from 'react';
import type { PublisherAccount, Site } from '../shared/types';

type Props = {
  publishers: PublisherAccount[];
  activePublisherId: string | null;
  activeSiteId: string | null;
  loading: boolean;
  error: string | null;
  onSelectPublisher: (publisher: PublisherAccount) => void;
  onSelectSite: (publisherId: string, site: Site) => void;
  onCreatePublisher: () => void;
  onAddSite: (publisherId: string) => void;
  onMoveSite: (siteId: string, targetPublisherId: string) => Promise<void>;
};

export default function HierarchySidebar({
  publishers,
  activePublisherId,
  activeSiteId,
  loading,
  error,
  onSelectPublisher,
  onSelectSite,
  onCreatePublisher,
  onAddSite,
  onMoveSite,
}: Props) {
  const [draggedSiteId, setDraggedSiteId] = useState<string | null>(null);
  const [dragOverPublisherId, setDragOverPublisherId] = useState<string | null>(null);
  const [movingSiteId, setMovingSiteId] = useState<string | null>(null);

  function startDrag(event: DragEvent<HTMLButtonElement>, site: Site) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/prebid-professor-site', site.id);
    event.dataTransfer.setData('text/plain', site.id);
    setDraggedSiteId(site.id);
  }

  function endDrag() {
    setDraggedSiteId(null);
    setDragOverPublisherId(null);
  }

  function allowDrop(event: DragEvent<HTMLElement>, publisherId: string) {
    if (!draggedSiteId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverPublisherId(publisherId);
  }

  async function drop(event: DragEvent<HTMLElement>, publisherId: string) {
    event.preventDefault();
    const siteId =
      event.dataTransfer.getData('text/prebid-professor-site') ||
      event.dataTransfer.getData('text/plain') ||
      draggedSiteId;
    setDragOverPublisherId(null);
    setDraggedSiteId(null);
    if (!siteId) return;

    const sourcePublisher = publishers.find((publisher) =>
      publisher.sites.some((site) => site.id === siteId),
    );
    if (sourcePublisher?.id === publisherId) return;

    setMovingSiteId(siteId);
    try {
      await onMoveSite(siteId, publisherId);
    } finally {
      setMovingSiteId(null);
    }
  }

  return (
    <div className="publisher-nav publisher-tree">
      <div className="section-label">Publishers</div>
      {loading ? <div className="publisher-nav-message">Loading publisher hierarchy…</div> : null}
      {error ? <div className="publisher-nav-message error">{error}</div> : null}

      {publishers.map((account) => (
        <div
          className={`publisher-tree-group${dragOverPublisherId === account.id ? ' drag-target' : ''}`}
          key={account.id}
          onDragEnter={(event) => allowDrop(event, account.id)}
          onDragOver={(event) => allowDrop(event, account.id)}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragOverPublisherId(null);
            }
          }}
          onDrop={(event) => void drop(event, account.id)}
        >
          <button
            className={account.id === activePublisherId ? 'publisher-account-link active' : 'publisher-account-link'}
            onClick={() => onSelectPublisher(account)}
            type="button"
          >
            <span>{account.name}</span>
            <small>{account.sitesCount}</small>
          </button>

          {dragOverPublisherId === account.id ? (
            <div className="site-drop-hint">Drop site here to move it</div>
          ) : null}

          <div className="publisher-site-list">
            {account.sites.map((site) => (
              <button
                className={`site-link${site.id === activeSiteId ? ' active' : ''}${draggedSiteId === site.id ? ' dragging' : ''}`}
                draggable
                key={site.id}
                onClick={() => onSelectSite(account.id, site)}
                onDragEnd={endDrag}
                onDragStart={(event) => startDrag(event, site)}
                title="Open site, or drag it onto another publisher to move it"
                type="button"
              >
                <span>{movingSiteId === site.id ? 'Moving…' : site.name}</span>
                <small className={site.status}>{site.status}</small>
              </button>
            ))}
            <button className="site-link add-site-link" onClick={() => onAddSite(account.id)} type="button">
              ＋ Add site
            </button>
          </div>
        </div>
      ))}

      <button className="publisher-link muted" onClick={onCreatePublisher} type="button">
        <span>＋ New publisher</span>
      </button>
    </div>
  );
}
