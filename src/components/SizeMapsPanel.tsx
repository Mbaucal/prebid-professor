import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { AdUnit, SizeMap, SizeMapBreakpoint, SizeMapSize } from '../shared/types';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

type FormMode = 'create' | 'edit' | 'duplicate';

type BreakpointForm = {
  id: string;
  minWidth: number;
  minHeight: number;
  sizesText: string;
};

function rowId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function emptyBreakpoint(minWidth = 0): BreakpointForm {
  return { id: rowId(), minWidth, minHeight: 0, sizesText: '300x250' };
}

function formatSizes(sizes: SizeMapSize[]): string {
  return sizes.map((size) => `${size[0]}x${size[1]}`).join(' | ');
}

function rowsFromMap(map: SizeMapBreakpoint[]): BreakpointForm[] {
  return map.map((breakpoint) => ({
    id: rowId(),
    minWidth: breakpoint.minViewPort[0],
    minHeight: breakpoint.minViewPort[1],
    sizesText: formatSizes(breakpoint.sizes),
  }));
}

function parseSizes(value: string, rowNumber: number): SizeMapSize[] {
  const tokens = value
    .split(/[|;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (!tokens.length) throw new Error(`Breakpoint ${rowNumber}: add at least one size.`);

  const sizes = tokens.map((token) => {
    const match = token.match(/^(\d+)\s*x\s*(\d+)$/i);
    if (!match) throw new Error(`Breakpoint ${rowNumber}: "${token}" must use format 970x250.`);
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) throw new Error(`Breakpoint ${rowNumber}: size values must be positive.`);
    return [width, height] as SizeMapSize;
  });

  return Array.from(new Map(sizes.map((size) => [`${size[0]}x${size[1]}`, size])).values());
}

function mapFromRows(rows: BreakpointForm[]): SizeMapBreakpoint[] {
  if (!rows.length) throw new Error('Add at least one breakpoint.');

  const seen = new Set<string>();
  return rows
    .map((row, index) => {
      const minWidth = Number(row.minWidth);
      const minHeight = Number(row.minHeight);
      if (!Number.isInteger(minWidth) || minWidth < 0 || !Number.isInteger(minHeight) || minHeight < 0) {
        throw new Error(`Breakpoint ${index + 1}: viewport values must be non-negative integers.`);
      }
      const key = `${minWidth}x${minHeight}`;
      if (seen.has(key)) throw new Error(`Breakpoint ${index + 1}: viewport ${key} is duplicated.`);
      seen.add(key);
      return {
        minViewPort: [minWidth, minHeight] as [number, number],
        sizes: parseSizes(row.sizesText, index + 1),
      };
    })
    .sort((a, b) => a.minViewPort[0] - b.minViewPort[0] || a.minViewPort[1] - b.minViewPort[1]);
}

function nextCopyName(name: string): string {
  const match = name.match(/^(.*?)(?:_(\d+))?$/);
  const base = match?.[1] || name;
  const next = match?.[2] ? Number(match[2]) + 1 : 2;
  return `${base}_${next}`;
}

function maxHeight(sizes: SizeMapSize[]): number {
  return sizes.reduce((max, size) => Math.max(max, size[1]), 0);
}

export default function SizeMapsPanel({ publisherId, onChanged }: Props) {
  const [sizeMaps, setSizeMaps] = useState<SizeMap[]>([]);
  const [adUnits, setAdUnits] = useState<AdUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<FormMode | null>(null);
  const [source, setSource] = useState<SizeMap | null>(null);
  const [name, setName] = useState('');
  const [rows, setRows] = useState<BreakpointForm[]>([emptyBreakpoint()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [maps, units] = await Promise.all([
        api.listSizeMaps(publisherId),
        api.listAdUnits(publisherId),
      ]);
      setSizeMaps(maps);
      setAdUnits(units);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load size maps.');
    } finally {
      setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    void load();
  }, [load]);

  const usage = useMemo(() => {
    const result = new Map<string, string[]>();
    adUnits.forEach((unit) => {
      if (!unit.sizeMapKey) return;
      result.set(unit.sizeMapKey, [...(result.get(unit.sizeMapKey) ?? []), unit.code]);
    });
    return result;
  }, [adUnits]);

  function openCreate() {
    setMode('create');
    setSource(null);
    setName('');
    setRows([emptyBreakpoint(0)]);
    setFormError(null);
  }

  function openEdit(item: SizeMap) {
    setMode('edit');
    setSource(item);
    setName(item.name);
    setRows(rowsFromMap(item.map));
    setFormError(null);
  }

  function openDuplicate(item: SizeMap) {
    setMode('duplicate');
    setSource(item);
    setName(nextCopyName(item.name));
    setRows(rowsFromMap(item.map));
    setFormError(null);
  }

  function closeForm() {
    if (submitting) return;
    setMode(null);
    setSource(null);
    setFormError(null);
  }

  function updateRow(id: string, patch: Partial<BreakpointForm>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function addBreakpoint() {
    const currentMax = rows.reduce((max, row) => Math.max(max, Number(row.minWidth) || 0), 0);
    setRows((current) => [...current, emptyBreakpoint(currentMax ? currentMax + 1 : 469)]);
  }

  function removeBreakpoint(id: string) {
    setRows((current) => current.filter((row) => row.id !== id));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const cleanName = name.trim();
    if (!cleanName) {
      setFormError('Size map name is required.');
      return;
    }

    let map: SizeMapBreakpoint[];
    try {
      map = mapFromRows(rows);
    } catch (validationError) {
      setFormError(validationError instanceof Error ? validationError.message : String(validationError));
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'duplicate' && source) {
        await api.duplicateSizeMap(publisherId, source.id, { name: cleanName });
      } else if (mode === 'edit' && source) {
        await api.updateSizeMap(publisherId, source.id, { name: cleanName, map });
      } else {
        await api.createSizeMap(publisherId, { name: cleanName, map });
      }
      await load();
      await onChanged?.();
      closeForm();
    } catch (requestError) {
      setFormError(requestError instanceof Error ? requestError.message : 'Size map operation failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(item: SizeMap) {
    const usedBy = usage.get(item.name) ?? [];
    const message = usedBy.length
      ? `${item.name} is used by ${usedBy.join(', ')} and cannot be deleted until those ad units are reassigned.`
      : `Delete size map ${item.name}?`;
    if (!window.confirm(message)) return;

    try {
      await api.deleteSizeMap(publisherId, item.id);
      await load();
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not delete size map.');
    }
  }

  return (
    <>
      <section className="size-maps-page">
        <div className="config-toolbar">
          <div>
            <span className="panel-kicker">Responsive inventory</span>
            <h2>Size maps</h2>
            <p>Manage viewport breakpoints, permitted creative sizes and recommended reserved height.</p>
          </div>
          <button className="button primary" onClick={openCreate} type="button">
            ＋ New size map
          </button>
        </div>

        {error ? <div className="form-error config-error">{error}</div> : null}
        {loading ? <div className="config-loading">Loading size maps from D1…</div> : null}

        <div className="size-map-grid">
          {sizeMaps.map((item) => {
            const usedBy = usage.get(item.name) ?? [];
            return (
              <article className="size-map-card" key={item.id}>
                <div className="size-map-heading">
                  <div>
                    <h3>{item.name}</h3>
                    <span>{item.map.length} breakpoint(s)</span>
                  </div>
                  <span className={usedBy.length ? 'map-usage used' : 'map-usage'}>
                    {usedBy.length ? `${usedBy.length} unit(s)` : 'unused'}
                  </span>
                </div>

                <div className="size-map-breakpoints">
                  {item.map.map((breakpoint) => (
                    <div className="size-map-breakpoint" key={`${breakpoint.minViewPort[0]}-${breakpoint.minViewPort[1]}`}>
                      <div className="viewport-label">
                        ≥ {breakpoint.minViewPort[0]}px
                        {breakpoint.minViewPort[1] ? ` × ${breakpoint.minViewPort[1]}px` : ''}
                      </div>
                      <div className="size-chip-list">
                        {breakpoint.sizes.map((size) => (
                          <span className="size-chip" key={`${size[0]}x${size[1]}`}>{size[0]}x{size[1]}</span>
                        ))}
                      </div>
                      <span className="height-chip">min-height {maxHeight(breakpoint.sizes)}px</span>
                    </div>
                  ))}
                </div>

                {usedBy.length ? (
                  <div className="map-used-by"><b>Used by:</b> {usedBy.join(', ')}</div>
                ) : null}

                <div className="ad-unit-actions">
                  <button onClick={() => openEdit(item)} type="button">Edit</button>
                  <button onClick={() => openDuplicate(item)} type="button">Duplicate</button>
                  <button className="danger-link" onClick={() => void remove(item)} type="button">Delete</button>
                </div>
              </article>
            );
          })}

          {!loading && sizeMaps.length === 0 ? (
            <button className="empty-size-map-card" onClick={openCreate} type="button">
              ＋ Create the first size map or import one from CSV
            </button>
          ) : null}
        </div>
      </section>

      {mode ? (
        <div className="modal-backdrop" onMouseDown={closeForm} role="presentation">
          <section className="modal-card size-map-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <div className="modal-heading">
              <div>
                <span className="panel-kicker">Responsive size workflow</span>
                <h2>
                  {mode === 'create'
                    ? 'Create size map'
                    : mode === 'duplicate'
                      ? `Duplicate ${source?.name ?? 'size map'}`
                      : `Edit ${source?.name ?? 'size map'}`}
                </h2>
              </div>
              <button className="icon-button" onClick={closeForm} type="button">×</button>
            </div>

            <form className="publisher-form" onSubmit={submit}>
              <label>
                <span>Size map name</span>
                <input autoFocus onChange={(event) => setName(event.target.value)} placeholder="Billboard" value={name} />
                <small>Renaming a map updates all ad units that reference it.</small>
              </label>

              <div className="breakpoint-editor">
                <div className="breakpoint-editor-heading">
                  <div>
                    <span>Breakpoints</span>
                    <small>Sizes can be separated with |, comma or semicolon.</small>
                  </div>
                  {mode !== 'duplicate' ? (
                    <button className="button secondary" onClick={addBreakpoint} type="button">＋ Breakpoint</button>
                  ) : null}
                </div>

                {rows.map((row, index) => (
                  <div className="breakpoint-form-row" key={row.id}>
                    <label>
                      <span>Min width</span>
                      <input
                        disabled={mode === 'duplicate'}
                        min="0"
                        onChange={(event) => updateRow(row.id, { minWidth: Number(event.target.value) })}
                        type="number"
                        value={row.minWidth}
                      />
                    </label>
                    <label>
                      <span>Min height</span>
                      <input
                        disabled={mode === 'duplicate'}
                        min="0"
                        onChange={(event) => updateRow(row.id, { minHeight: Number(event.target.value) })}
                        type="number"
                        value={row.minHeight}
                      />
                    </label>
                    <label className="sizes-field">
                      <span>Sizes</span>
                      <input
                        disabled={mode === 'duplicate'}
                        onChange={(event) => updateRow(row.id, { sizesText: event.target.value })}
                        placeholder="970x250 | 970x90 | 728x90"
                        value={row.sizesText}
                      />
                    </label>
                    {mode !== 'duplicate' ? (
                      <button
                        aria-label={`Remove breakpoint ${index + 1}`}
                        className="breakpoint-remove"
                        disabled={rows.length === 1}
                        onClick={() => removeBreakpoint(row.id)}
                        type="button"
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>

              {mode === 'duplicate' ? (
                <div className="form-options">
                  The copied map keeps all {source?.map.length ?? 0} breakpoint(s). Save it first, then edit if needed.
                </div>
              ) : null}

              {formError ? <div className="form-error">{formError}</div> : null}
              <div className="modal-actions">
                <button className="button secondary" disabled={submitting} onClick={closeForm} type="button">Cancel</button>
                <button className="button primary" disabled={submitting} type="submit">
                  {submitting ? 'Saving…' : mode === 'duplicate' ? 'Duplicate size map' : 'Save size map'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}
