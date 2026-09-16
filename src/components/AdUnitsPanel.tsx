import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { AdUnit, AdUnitType } from '../shared/types';
import SiteRuntimePanel from './SiteRuntimePanel';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

type FormMode = 'create' | 'edit' | 'duplicate';

type FormState = {
  code: string;
  type: AdUnitType;
  mediaType: string;
  sizeMapKey: string;
  enabled: boolean;
  sortOrder: number;
  notes: string;
  copySizeMapReference: boolean;
  copyUnitRule: boolean;
  copyBidderAdUnitOverrides: boolean;
};

const emptyForm: FormState = {
  code: '',
  type: 'BTF',
  mediaType: 'banner',
  sizeMapKey: '',
  enabled: true,
  sortOrder: 0,
  notes: '',
  copySizeMapReference: true,
  copyUnitRule: true,
  copyBidderAdUnitOverrides: true,
};

const columns: Array<{ type: AdUnitType; label: string; description: string }> = [
  { type: 'ATF', label: 'ATF', description: 'Initial page-load inventory' },
  { type: 'BTF', label: 'BTF', description: 'Lazy and in-content inventory' },
  { type: 'DRAFT', label: 'Draft', description: 'Not included in generated output yet' },
];

function nextCopyCode(code: string): string {
  const match = code.match(/^(.*?)(?:_(\d+))?$/);
  if (!match) return `${code}_2`;
  const base = match[1] || code;
  const current = match[2] ? Number(match[2]) : 1;
  return `${base}_${current + 1}`;
}

function formFromAdUnit(adUnit: AdUnit): FormState {
  return {
    code: adUnit.code,
    type: adUnit.type,
    mediaType: adUnit.mediaType,
    sizeMapKey: adUnit.sizeMapKey ?? '',
    enabled: adUnit.enabled,
    sortOrder: adUnit.sortOrder,
    notes: adUnit.notes ?? '',
    copySizeMapReference: true,
    copyUnitRule: true,
    copyBidderAdUnitOverrides: true,
  };
}

export default function AdUnitsPanel({ publisherId, onChanged }: Props) {
  const [runtimeUnit,setRuntimeUnit]=useState<string|null>(null);
  const [adUnits, setAdUnits] = useState<AdUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<FormMode | null>(null);
  const [source, setSource] = useState<AdUnit | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAdUnits(await api.listAdUnits(publisherId));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load ad units.');
    } finally {
      setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const result: Record<AdUnitType, AdUnit[]> = { ATF: [], BTF: [], DRAFT: [] };
    adUnits.forEach((unit) => result[unit.type].push(unit));
    return result;
  }, [adUnits]);

  function openCreate() {
    const maxOrder = adUnits.reduce((max, unit) => Math.max(max, unit.sortOrder), 0);
    setMode('create');
    setSource(null);
    setForm({ ...emptyForm, sortOrder: maxOrder + 1 });
    setFormError(null);
  }

  function openEdit(adUnit: AdUnit) {
    setMode('edit');
    setSource(adUnit);
    setForm(formFromAdUnit(adUnit));
    setFormError(null);
  }

  function openDuplicate(adUnit: AdUnit) {
    setMode('duplicate');
    setSource(adUnit);
    setForm({
      ...formFromAdUnit(adUnit),
      code: nextCopyCode(adUnit.code),
      sortOrder: adUnit.sortOrder + 1,
      copySizeMapReference: true,
      copyUnitRule: true,
      copyBidderAdUnitOverrides: true,
    });
    setFormError(null);
  }

  function closeForm() {
    if (submitting) return;
    setMode(null);
    setSource(null);
    setFormError(null);
  }

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    if (!form.code.trim()) {
      setFormError('Ad unit code is required.');
      return;
    }

    setSubmitting(true);

    try {
      const common = {
        code: form.code.trim(),
        type: form.type,
        mediaType: form.mediaType.trim() || 'banner',
        enabled: form.enabled,
        sortOrder: Number(form.sortOrder) || 0,
        notes: form.notes.trim() || null,
      };

      if (mode === 'duplicate' && source) {
        await api.duplicateAdUnit(publisherId, source.id, {
          ...common,
          copySizeMapReference: form.copySizeMapReference,
          copyUnitRule: form.copyUnitRule,
          copyBidderAdUnitOverrides: form.copyBidderAdUnitOverrides,
        });
      } else if (mode === 'edit' && source) {
        await api.updateAdUnit(publisherId, source.id, {
          ...common,
          sizeMapKey: form.sizeMapKey.trim() || null,
        });
      } else {
        await api.createAdUnit(publisherId, {
          ...common,
          sizeMapKey: form.sizeMapKey.trim() || null,
        });
      }

      await load();
      await onChanged?.();
      closeForm();
    } catch (requestError) {
      setFormError(requestError instanceof Error ? requestError.message : 'Ad unit operation failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(adUnit: AdUnit) {
    const confirmed = window.confirm(
      `Delete ${adUnit.code}? Its exact ad-unit bidder overrides and unit rule will also be removed.`,
    );
    if (!confirmed) return;

    try {
      await api.deleteAdUnit(publisherId, adUnit.id);
      await load();
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not delete ad unit.');
    }
  }

  return (
    <>
      <section className="config-page">
        <div className="config-toolbar">
          <div>
            <span className="panel-kicker">Publisher configuration</span>
            <h2>Ad unit board</h2>
            <p>Create, edit or copy repeatable inventory without rebuilding a publisher from scratch.</p>
          </div>
          <button className="button primary" onClick={openCreate} type="button">
            ＋ New ad unit
          </button>
        </div>

        {error ? <div className="form-error config-error">{error}</div> : null}
        {loading ? <div className="config-loading">Loading ad units from D1…</div> : null}

        <div className="ad-unit-board">
          {columns.map((column) => (
            <article className="ad-unit-column" key={column.type}>
              <div className="ad-unit-column-heading">
                <div>
                  <h3>{column.label}</h3>
                  <span>{column.description}</span>
                </div>
                <strong>{grouped[column.type].length}</strong>
              </div>

              <div className="ad-unit-list">
                {grouped[column.type].map((adUnit) => (
                  <div className={`ad-unit-card${adUnit.enabled ? '' : ' disabled'}`} key={adUnit.id}>
                    <div className="ad-unit-card-heading">
                      <div>
                        <code>{adUnit.code}</code>
                        <span>{adUnit.mediaType}</span>
                      </div>
                      <span className={adUnit.enabled ? 'unit-state enabled' : 'unit-state'}>
                        {adUnit.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </div>

                    <dl>
                      <div><dt>Size map</dt><dd>{adUnit.sizeMapKey ?? 'Not assigned'}</dd></div>
                      <div><dt>Sort</dt><dd>{adUnit.sortOrder}</dd></div>
                    </dl>

                    {adUnit.notes ? <p>{adUnit.notes}</p> : null}

                    <div className="ad-unit-actions">
                      {adUnit.mediaType==='banner'&&adUnit.type!=='DRAFT'?<button onClick={()=>setRuntimeUnit(adUnit.code)} type="button">Display & loading</button>:null}
                      <button onClick={() => openEdit(adUnit)} type="button">Edit</button>
                      <button onClick={() => openDuplicate(adUnit)} type="button">Duplicate</button>
                      <button className="danger-link" onClick={() => void remove(adUnit)} type="button">
                        Delete
                      </button>
                    </div>
                  </div>
                ))}

                {!loading && grouped[column.type].length === 0 ? (
                  <button className="empty-unit-card" onClick={openCreate} type="button">
                    ＋ Add {column.label} unit
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>

      {runtimeUnit?<div className="modal-backdrop"><section className="modal-card ad-unit-modal" role="dialog" aria-modal="true" aria-label={`Display settings for ${runtimeUnit}`}><button className="icon-button" type="button" onClick={()=>setRuntimeUnit(null)} aria-label="Close display settings">×</button><SiteRuntimePanel key={publisherId+runtimeUnit} publisherId={publisherId} view="positions" unitCode={runtimeUnit} onChanged={onChanged}/></section></div>:null}
      {mode ? (
        <div className="modal-backdrop" onMouseDown={closeForm} role="presentation">
          <section
            aria-labelledby="ad-unit-form-title"
            aria-modal="true"
            className="modal-card ad-unit-modal"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-heading">
              <div>
                <span className="panel-kicker">Ad unit workflow</span>
                <h2 id="ad-unit-form-title">
                  {mode === 'create'
                    ? 'Create ad unit'
                    : mode === 'duplicate'
                      ? `Duplicate ${source?.code ?? 'ad unit'}`
                      : `Edit ${source?.code ?? 'ad unit'}`}
                </h2>
              </div>
              <button className="icon-button" onClick={closeForm} type="button">×</button>
            </div>

            <form className="publisher-form" onSubmit={submit}>
              <label>
                <span>Ad unit code / div ID</span>
                <input
                  autoFocus
                  onChange={(event) => updateField('code', event.target.value)}
                  placeholder="Billboard_2"
                  value={form.code}
                />
                <small>Renaming an existing unit also updates its exact unit rule and ad-unit overrides.</small>
              </label>

              <div className="form-grid-two">
                <label>
                  <span>Inventory group</span>
                  <select
                    onChange={(event) => updateField('type', event.target.value as AdUnitType)}
                    value={form.type}
                  >
                    <option value="ATF">ATF</option>
                    <option value="BTF">BTF</option>
                    <option value="DRAFT">Draft</option>
                  </select>
                </label>

                <label>
                  <span>Media type</span>
                  <select
                    onChange={(event) => updateField('mediaType', event.target.value)}
                    value={form.mediaType}
                  >
                    <option value="banner">banner</option>
                    <option value="video">video</option>
                    <option value="native">native</option>
                  </select>
                </label>
              </div>

              {mode !== 'duplicate' ? (
                <label>
                  <span>Size map key</span>
                  <input
                    onChange={(event) => updateField('sizeMapKey', event.target.value)}
                    placeholder="Billboard"
                    value={form.sizeMapKey}
                  />
                </label>
              ) : (
                <div className="form-options">
                  <label className="check-row">
                    <input
                      checked={form.copySizeMapReference}
                      onChange={(event) => updateField('copySizeMapReference', event.target.checked)}
                      type="checkbox"
                    />
                    <span>Copy size-map reference ({source?.sizeMapKey ?? 'none'})</span>
                  </label>
                  <label className="check-row">
                    <input
                      checked={form.copyUnitRule}
                      onChange={(event) => updateField('copyUnitRule', event.target.checked)}
                      type="checkbox"
                    />
                    <span>Copy exact unit rule</span>
                  </label>
                  <label className="check-row">
                    <input
                      checked={form.copyBidderAdUnitOverrides}
                      onChange={(event) =>
                        updateField('copyBidderAdUnitOverrides', event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>Copy bidder ad-unit overrides</span>
                  </label>
                </div>
              )}

              <div className="form-grid-two">
                <label>
                  <span>Sort order</span>
                  <input
                    min="0"
                    onChange={(event) => updateField('sortOrder', Number(event.target.value))}
                    type="number"
                    value={form.sortOrder}
                  />
                </label>

                <label className="enabled-field">
                  <span>State</span>
                  <span className="check-row standalone-check">
                    <input
                      checked={form.enabled}
                      onChange={(event) => updateField('enabled', event.target.checked)}
                      type="checkbox"
                    />
                    <span>Enabled</span>
                  </span>
                </label>
              </div>

              <label>
                <span>Notes</span>
                <textarea
                  onChange={(event) => updateField('notes', event.target.value)}
                  placeholder="Homepage top billboard, lazy in-feed placement…"
                  rows={3}
                  value={form.notes}
                />
              </label>

              {formError ? <div className="form-error">{formError}</div> : null}

              <div className="modal-actions">
                <button className="button secondary" disabled={submitting} onClick={closeForm} type="button">
                  Cancel
                </button>
                <button className="button primary" disabled={submitting} type="submit">
                  {submitting
                    ? 'Saving…'
                    : mode === 'create'
                      ? 'Create ad unit'
                      : mode === 'duplicate'
                        ? 'Duplicate ad unit'
                        : 'Save changes'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}
