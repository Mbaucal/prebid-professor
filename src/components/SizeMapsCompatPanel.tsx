import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { AdUnit, SizeMap } from '../shared/types';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

type FormMode = 'create' | 'edit' | 'duplicate';
type FixedSize = [number, number];
type FlexibleSize = FixedSize | 'fluid';
type FlexibleBreakpoint = {
  minViewPort: [number, number];
  sizes: FlexibleSize[];
};
type FlexibleMap = Omit<SizeMap, 'map'> & { map: FlexibleBreakpoint[] };
type BreakpointForm = {
  id: string;
  minWidth: number;
  minHeight: number;
  sizesText: string;
};

const EMPTY_SIZE_TOKENS = new Set(['', 'none', 'off', 'disabled', '[]', '-']);

function rowId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function emptyBreakpoint(minWidth = 0): BreakpointForm {
  return { id: rowId(), minWidth, minHeight: 0, sizesText: '300x250' };
}

function asFlexible(item: SizeMap): FlexibleMap {
  return item as unknown as FlexibleMap;
}

function sizeKey(size: FlexibleSize): string {
  return size === 'fluid' ? 'fluid' : `${size[0]}x${size[1]}`;
}

function formatSizes(sizes: FlexibleSize[]): string {
  return sizes.map((size) => (size === 'fluid' ? 'fluid' : `${size[0]}x${size[1]}`)).join(' | ');
}

function rowsFromMap(map: FlexibleBreakpoint[]): BreakpointForm[] {
  return map.map((breakpoint) => ({
    id: rowId(),
    minWidth: breakpoint.minViewPort[0],
    minHeight: breakpoint.minViewPort[1],
    sizesText: formatSizes(breakpoint.sizes),
  }));
}

function parseSizes(value: string, rowNumber: number): FlexibleSize[] {
  const normalizedWhole = value.trim().toLowerCase();
  if (EMPTY_SIZE_TOKENS.has(normalizedWhole)) return [];

  const tokens = value
    .split(/[|;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const sizes = tokens.map((token): FlexibleSize => {
    if (token.toLowerCase() === 'fluid') return 'fluid';
    const match = token.match(/^(\d+)\s*x\s*(\d+)$/i);
    if (!match) {
      throw new Error(
        `Breakpoint ${rowNumber}: "${token}" must use 970x250 or fluid. Leave the field empty to disable the slot.`,
      );
    }
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) throw new Error(`Breakpoint ${rowNumber}: size values must be positive.`);
    return [width, height];
  });

  return Array.from(new Map(sizes.map((size) => [sizeKey(size), size])).values());
}

function mapFromRows(rows: BreakpointForm[]): FlexibleBreakpoint[] {
  if (!rows.length) throw new Error('Add at least one breakpoint.');

  const seen = new Set<string>();
  const map = rows
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

  if (!map.some((breakpoint) => breakpoint.sizes.length)) {
    throw new Error('At least one breakpoint must contain a fixed size or fluid.');
  }
  return map;
}

function nextCopyName(name: string): string {
  const match = name.match(/^(.*?)(?:_(\d+))?$/);
  const base = match?.[1] || name;
  const next = match?.[2] ? Number(match[2]) + 1 : 2;
  return `${base}_${next}`;
}

function maxFixedHeight(sizes: FlexibleSize[]): number {
  return sizes.reduce((max, size) => (size === 'fluid' ? max : Math.max(max, size[1])), 0);
}

function breakpointHeightLabel(sizes: FlexibleSize[]): string {
  if (!sizes.length) return 'slot disabled';
  const height = maxFixedHeight(sizes);
  if (height) return `min-height ${height}px`;
  return 'fluid height';
}

export default function SizeMapsCompatPanel({ publisherId, onChanged }: Props) {
  const [sizeMaps, setSizeMaps] = useState<FlexibleMap[]>([]);
  const [adUnits, setAdUnits] = useState<AdUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<FormMode | null>(null);
  const [source, setSource] = useState<FlexibleMap | null>(null);
  const [name, setName] = useState('');
  const [rows, setRows] = useState<BreakpointForm[]>([emptyBreakpoint()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [maps, units] = await Promise.all([api.listSizeMaps(publisherId), api.listAdUnits(publisherId)]);
      setSizeMaps(maps.map(asFlexible));
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

  function openEdit(item: FlexibleMap) {
    setMode('edit');
    setSource(item);
    setName(item.name);
    setRows(rowsFromMap(item.map));
    setFormError(null);
  }

  function openDuplicate(item: FlexibleMap) {
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

    let map: FlexibleBreakpoint[];
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
        await api.updateSizeMap(publisherId, source.id, {
          name: cleanName,
          map: map as never,
        });
      } else {
        await api.createSizeMap(publisherId, {
          name: cleanName,
          map: map as never,
        });
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

  async function remove(item: FlexibleMap) {
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
            <p>Fixed sizes, GPT fluid inventory and viewport ranges where the slot must not request an ad.</p>
          </div>
          <button className="button primary" onClick={openCreate} type="button">＋ New size map</button>
        </div>

        <div className="size-map-compat-note">
          <strong>Special values:</strong>
          <span><code>fluid</code> is valid for GPT/native inventory. Leave Sizes empty to create <code>[]</code> and disable the slot at that viewport.</span>
        </div>

        {error ? <div className="form-error config-error">{error}</div> : null}
        {loading ? <div className="config-loading">Loading size maps from D1…</div> : null}

        <div className="size-map-grid">
          {sizeMaps.map((item) => {
            const usedBy = usage.get(item.name) ?? [];
            return (
              <article className="size-map-card" key={item.id}>
                <div className="size-map-heading">
                  <div><h3>{item.name}</h3><span>{item.map.length} breakpoint(s)</span></div>
                  <span className={usedBy.length ? 'map-usage used' : 'map-usage'}>
                    {usedBy.length ? `${usedBy.length} unit(s)` : 'unused'}
                  </span>
                </div>

                <div className="size-map-breakpoints">
                  {item.map.map((breakpoint) => (
                    <div className={`size-map-breakpoint${breakpoint.sizes.length ? '' : ' disabled-breakpoint'}`} key={`${breakpoint.minViewPort[0]}-${breakpoint.minViewPort[1]}`}>
                      <div className="viewport-label">
                        ≥ {breakpoint.minViewPort[0]}px
                        {breakpoint.minViewPort[1] ? ` × ${breakpoint.minViewPort[1]}px` : ''}
                      </div>
                      <div className="size-chip-list">
                        {breakpoint.sizes.map((size) =>
                          size === 'fluid' ? (
                            <span className="size-chip fluid" key="fluid">fluid</span>
                          ) : (
                            <span className="size-chip" key={`${size[0]}x${size[1]}`}>{size[0]}x{size[1]}</span>
                          ),
                        )}
                        {!breakpoint.sizes.length ? <span className="size-map-disabled-chip">No ad at this viewport</span> : null}
                      </div>
                      <span className="height-chip">{breakpointHeightLabel(breakpoint.sizes)}</span>
                    </div>
                  ))}
                </div>

                {usedBy.length ? <div className="map-used-by"><b>Used by:</b> {usedBy.join(', ')}</div> : null}
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
                <h2>{mode === 'create' ? 'Create size map' : mode === 'duplicate' ? `Duplicate ${source?.name ?? 'size map'}` : `Edit ${source?.name ?? 'size map'}`}</h2>
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
                    <small>Use 970x250 | fluid. Leave Sizes empty when no ad should serve at that viewport.</small>
                  </div>
                  {mode !== 'duplicate' ? <button className="button secondary" onClick={addBreakpoint} type="button">＋ Breakpoint</button> : null}
                </div>

                {rows.map((row, index) => (
                  <div className="breakpoint-form-row" key={row.id}>
                    <label>
                      <span>Min width</span>
                      <input disabled={mode === 'duplicate'} min="0" onChange={(event) => updateRow(row.id, { minWidth: Number(event.target.value) })} type="number" value={row.minWidth} />
                    </label>
                    <label>
                      <span>Min height</span>
                      <input disabled={mode === 'duplicate'} min="0" onChange={(event) => updateRow(row.id, { minHeight: Number(event.target.value) })} type="number" value={row.minHeight} />
                    </label>
                    <label className="sizes-field">
                      <span>Sizes</span>
                      <input disabled={mode === 'duplicate'} onChange={(event) => updateRow(row.id, { sizesText: event.target.value })} placeholder="970x250 | 728x90 | fluid · or leave empty" value={row.sizesText} />
                    </label>
                    {mode !== 'duplicate' ? (
                      <button aria-label={`Remove breakpoint ${index + 1}`} className="breakpoint-remove" disabled={rows.length === 1} onClick={() => removeBreakpoint(row.id)} type="button">×</button>
                    ) : null}
                  </div>
                ))}
              </div>

              {mode === 'duplicate' ? <div className="form-options">The copied map keeps all {source?.map.length ?? 0} breakpoint(s). Save it first, then edit if needed.</div> : null}
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
