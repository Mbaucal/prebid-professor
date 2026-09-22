import { useEffect, useState, type DragEvent, type FormEvent } from 'react';
import { api } from '../api';
import type {
  PublisherAccount,
  PublisherAccountStatus,
  Site,
} from '../shared/types';

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

type PublisherEditForm = {
  name: string;
  status: PublisherAccountStatus;
  notes: string;
};

const RETURN_TO_PUBLISHER_KEY = 'prebid-professor:return-to-publisher';

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
  const [editingPublisher, setEditingPublisher] = useState<PublisherAccount | null>(null);
  const [editForm, setEditForm] = useState<PublisherEditForm>({
    name: '',
    status: 'active',
    notes: '',
  });
  const [editError, setEditError] = useState<string | null>(null);
  const [savingPublisher, setSavingPublisher] = useState(false);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deletingPublisher, setDeletingPublisher] = useState(false);

  useEffect(() => {
    const returnId = sessionStorage.getItem(RETURN_TO_PUBLISHER_KEY);
    if (!returnId) return;

    const account = publishers.find((publisher) => publisher.id === returnId);
    if (!account) return;

    sessionStorage.removeItem(RETURN_TO_PUBLISHER_KEY);
    onSelectPublisher(account);
  }, [onSelectPublisher, publishers]);

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

  function openPublisherEditor(account: PublisherAccount) {
    setEditingPublisher(account);
    setEditForm({
      name: account.name,
      status: account.status,
      notes: account.notes ?? '',
    });
    setEditError(null);
    setDeleteConfirming(false);
    setDeleteConfirmation('');
  }

  function closePublisherEditor() {
    if (savingPublisher || deletingPublisher) return;
    setEditingPublisher(null);
    setEditError(null);
    setDeleteConfirming(false);
    setDeleteConfirmation('');
  }

  async function savePublisher(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingPublisher) return;

    const name = editForm.name.trim();
    if (!name) {
      setEditError('Publisher name is required.');
      return;
    }

    setSavingPublisher(true);
    setEditError(null);

    try {
      const updated = await api.updatePublisherAccount(editingPublisher.id, {
        name,
        status: editForm.status,
        notes: editForm.notes.trim() || null,
      });

      // Reload the hierarchy from D1 so the sidebar, breadcrumb, page title and
      // overview all receive the new publisher name in one consistent refresh.
      sessionStorage.setItem(RETURN_TO_PUBLISHER_KEY, updated.id);
      window.location.reload();
    } catch (requestError) {
      setEditError(
        requestError instanceof Error
          ? requestError.message
          : 'Publisher could not be updated.',
      );
      setSavingPublisher(false);
    }
  }

  function beginPublisherDelete() {
    if (!editingPublisher) return;

    if (editingPublisher.sitesCount > 0) {
      setEditError(
        `Move or delete all ${editingPublisher.sitesCount} site(s) before deleting this publisher.`,
      );
      return;
    }

    setDeleteConfirming(true);
    setDeleteConfirmation('');
    setEditError(null);
  }

  async function permanentlyDeletePublisher() {
    if (!editingPublisher) return;
    if (editingPublisher.sitesCount > 0) return;
    if (deleteConfirmation.trim() !== editingPublisher.id) return;

    setDeletingPublisher(true);
    setEditError(null);

    try {
      await api.deletePublisherAccount(editingPublisher.id);
      sessionStorage.removeItem(RETURN_TO_PUBLISHER_KEY);
      window.location.reload();
    } catch (requestError) {
      setEditError(
        requestError instanceof Error
          ? requestError.message
          : 'Publisher could not be deleted.',
      );
      setDeletingPublisher(false);
    }
  }

  return (
    <>
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
            <div className="publisher-account-row">
              <button
                className={account.id === activePublisherId ? 'publisher-account-link active' : 'publisher-account-link'}
                onClick={() => onSelectPublisher(account)}
                type="button"
              >
                <span>{account.name}</span>
                <small>{account.sitesCount}</small>
              </button>
              <button
                aria-label={`Edit publisher ${account.name}`}
                className="publisher-account-edit"
                onClick={() => openPublisherEditor(account)}
                title={`Edit ${account.name}`}
                type="button"
              >
                ✎
              </button>
            </div>

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

      {editingPublisher ? (
        <div className="modal-backdrop" onMouseDown={closePublisherEditor} role="presentation">
          <section
            aria-labelledby="edit-publisher-title"
            aria-modal="true"
            className="modal-card"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-heading">
              <div>
                <span className="panel-kicker">Publisher account</span>
                <h2 id="edit-publisher-title">Edit {editingPublisher.name}</h2>
              </div>
              <button className="icon-button" onClick={closePublisherEditor} type="button">×</button>
            </div>

            <form className="publisher-form" onSubmit={savePublisher}>
              <label>
                <span>Publisher name</span>
                <input
                  autoFocus
                  onChange={(event) =>
                    setEditForm((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="Example Publisher"
                  value={editForm.name}
                />
              </label>

              <label>
                <span>Publisher ID</span>
                <input disabled value={editingPublisher.id} />
                <small>
                  Publisher ID is immutable. If it was created incorrectly, move or delete all sites,
                  delete this empty publisher, and recreate it with the correct ID.
                </small>
              </label>

              <label>
                <span>Status</span>
                <select
                  onChange={(event) =>
                    setEditForm((current) => ({
                      ...current,
                      status: event.target.value as PublisherAccountStatus,
                    }))
                  }
                  value={editForm.status}
                >
                  <option value="active">active</option>
                  <option value="draft">draft</option>
                  <option value="archived">archived</option>
                </select>
              </label>

              <label>
                <span>Notes</span>
                <input
                  onChange={(event) =>
                    setEditForm((current) => ({ ...current, notes: event.target.value }))
                  }
                  placeholder="example.com, news.example.com..."
                  value={editForm.notes}
                />
              </label>

              <div className="publisher-danger-zone">
                <div>
                  <strong>Delete publisher</strong>
                  <p>
                    This permanently removes only the publisher account. A publisher must contain zero sites
                    before it can be deleted.
                  </p>
                  {editingPublisher.sitesCount > 0 ? (
                    <small>
                      Move or delete {editingPublisher.sitesCount} site(s) first. Their configurations and
                      releases will remain attached to the sites when moved.
                    </small>
                  ) : null}
                </div>

                {!deleteConfirming ? (
                  <button
                    className="button danger"
                    disabled={editingPublisher.sitesCount > 0 || savingPublisher || deletingPublisher}
                    onClick={beginPublisherDelete}
                    type="button"
                  >
                    Delete publisher
                  </button>
                ) : null}

                {deleteConfirming ? (
                  <div className="publisher-delete-confirmation">
                    <label>
                      <span>Type the Publisher ID to confirm</span>
                      <input
                        autoFocus
                        onChange={(event) => setDeleteConfirmation(event.target.value)}
                        placeholder={editingPublisher.id}
                        value={deleteConfirmation}
                      />
                    </label>
                    <div className="publisher-delete-actions">
                      <button
                        className="button secondary"
                        disabled={deletingPublisher}
                        onClick={() => {
                          setDeleteConfirming(false);
                          setDeleteConfirmation('');
                        }}
                        type="button"
                      >
                        Keep publisher
                      </button>
                      <button
                        className="button danger publisher-delete-final"
                        disabled={
                          deletingPublisher ||
                          deleteConfirmation.trim() !== editingPublisher.id
                        }
                        onClick={() => void permanentlyDeletePublisher()}
                        type="button"
                      >
                        {deletingPublisher ? 'Deleting…' : 'Delete permanently'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              {editError ? <div className="form-error">{editError}</div> : null}

              <div className="modal-actions">
                <button
                  className="button secondary"
                  disabled={savingPublisher || deletingPublisher}
                  onClick={closePublisherEditor}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="button primary"
                  disabled={savingPublisher || deletingPublisher || deleteConfirming}
                  type="submit"
                >
                  {savingPublisher ? 'Saving…' : 'Save publisher'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}
