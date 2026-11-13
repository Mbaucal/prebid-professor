import BulkImportPanel from './BulkImportPanel';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { AdUnit, SizeMap } from '../shared/types';
import { reservedHeightSummary } from '../shared/size-map-height-summary';

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

function previewReservedHeight(value: string, index: number) {
  try {
    return reservedHeightSummary(parseSizes(value, index + 1));
  } catch {
    return null;
  }
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
  const [defaultsBusy,setDefaultsBusy]=useState(false),[defaultsNote,setDefaultsNote]=useState('');
  const errorNotice = useRef<HTMLDivElement>(null);
  const formNotice = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errorNotice.current?.scrollIntoView({ block: 'nearest' }); }, [error]);
  useEffect(() => { if (formError) formNotice.current?.scrollIntoView({ block: 'nearest' }); }, [formError]);

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
    sizeMaps.forEach((map) => {
      if (map.references) result.set(map.name, map.references.map(reference => reference.label));
    });
    return result;
  }, [adUnits, sizeMaps]);

  async function addDefaults(){
    setDefaultsBusy(true);setError(null);setDefaultsNote('');
    try{
      const base='/api/integrations/gam';
      const r=await fetch(base+'/site-inventory?siteId='+encodeURIComponent(publisherId));const saved=await r.json() as {revision:string;error?:string};if(!r.ok)throw Error(saved.error);
      const response=await fetch(base+'/defaults',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({siteId:publisherId,revision:saved.revision})});const result=await response.json() as {addedMaps:number;error?:string};if(!response.ok)throw Error(result.error);
      await load();await onChanged?.();setDefaultsNote(result.addedMaps?`${result.addedMaps} default maps added. Existing maps kept.`:'All 7 default maps are already present. Existing maps kept.');
    }catch(e){setError((e as Error).message);}finally{setDefaultsBusy(false);}
  }
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
      setMode(null);
      setSource(null);
      setFormError(null);
    } catch (requestError) {
      setFormError(requestError instanceof Error ? requestError.message : 'Size map operation failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(item: FlexibleMap) {
    const usedBy = usage.get(item.name) ?? [];
    const message = usedBy.length
      ? `${item.name} is used by ${usedBy.join(', ')}. Reassign these references before deleting it.`
      : `Delete size map ${item.name}?`;
    if (usedBy.length) { setError(message); return; }
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
          <button className="button" type="button" disabled={loading||defaultsBusy} onClick={()=>void addDefaults()}>{defaultsBusy?'Adding…':'Add 7 default maps'}</button>
          <button className="button primary" onClick={openCreate} type="button">＋ New size map</button>
        </div>

        <p>Complete starter: 7 maps / 25 breakpoints. Add missing maps, then edit or delete what you do not need. Existing maps are kept.</p>
        {defaultsNote&&<p role="status">{defaultsNote}</p>}
        <details className="inventory-csv"><summary>Import size maps / Download CSV template</summary><BulkImportPanel publisherId={publisherId} kinds={['size-maps']} onChanged={async()=>{await load();await onChanged?.();}}/></details>
        <div className="size-map-compat-note">
          <strong>Special values:</strong>
          <span><code>fluid</code> is valid for GPT/native inventory. Leave Sizes empty to create <code>[]</code> and disable the slot at that viewport.</span>
        </div>

        {error ? <div ref={errorNotice} role="alert" className="form-error config-error"><p>{error}</p><button className="button secondary" disabled={loading} onClick={() => void load()} type="button">Reload size maps</button></div> : null}
        {loading ? <div className="config-loading">Loading size maps from D1…</div> : null}

        <div className="size-map-grid">
          {sizeMaps.map((item) => {
            const usedBy = usage.get(item.name) ?? [];
            return (
              <article className="size-map-card" key={item.id}>
                <div className="size-map-heading">
                  <div><h3>{item.name}</h3><span>{item.map.length} breakpoint(s)</span></div>
                  <span className={usedBy.length ? 'map-usage used' : 'map-usage'}>
                    {usedBy.length ? `${usedBy.length} reference(s)` : 'unused'}
                  </span>
                </div>

                <div className="size-map-breakpoints">
                  {item.map.map((breakpoint) => (
                    <div className={`size-map-breakpoint${breakpoint.sizes.length ? '' : ' disabled-breakpoint'}`} key={`${breakpoint.minViewPort[0]}-${breakpoint.minViewPort[1]}`}>
                      <div className="viewport-label">
                        Width ≥ {breakpoint.minViewPort[0]}px
                        {breakpoint.minViewPort[1] ? <span className="viewport-height-label">Height ≥ {breakpoint.minViewPort[1]}px</span> : null}
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
                      <span className="height-chip" title={reservedHeightSummary(breakpoint.sizes).detail}>Reserve {reservedHeightSummary(breakpoint.sizes).label}</span>
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
          <section aria-labelledby="size-map-editor-title" className="modal-card size-map-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <div className="modal-heading">
              <div>
                <span className="panel-kicker">Responsive size workflow</span>
                <h2 id="size-map-editor-title">{mode === 'create' ? 'Create size map' : mode === 'duplicate' ? `Duplicate ${source?.name ?? 'size map'}` : `Edit ${source?.name ?? 'size map'}`}</h2>
              </div>
              <button className="icon-button" disabled={submitting} onClick={closeForm} type="button">×</button>
            </div>

            <form className="publisher-form" onSubmit={submit}>
              <label>
                <span>Size map name</span>
                <input autoFocus disabled={submitting} onChange={(event) => setName(event.target.value)} placeholder="Billboard" value={name} />
                <small>Renaming a map updates ad units and saved rules that reference it.</small>
              </label>

              <div className="breakpoint-editor size-map-compat-editor">
                <div className="breakpoint-editor-heading">
                  <div>
                    <span>Breakpoints</span>
                    <small>Viewport width chooses when a row applies. Sizes lists the allowed creatives, for example 970x250 | fluid. Leave Sizes empty when no ad should serve.</small>
                  </div>
                  {mode !== 'duplicate' ? <button className="button secondary" disabled={submitting} onClick={addBreakpoint} type="button">Add breakpoint</button> : null}
                </div>

                <p className="size-map-reservation-help">Reserved ad height is calculated from Sizes for standard slots and exported as CSS min-height. Sticky and overlay positions use their own layout. It is separate from the browser viewport height.</p>
                {rows.map((row, index) => {
                  const reserve = previewReservedHeight(row.sizesText, index);
                  return (
                  <div className="breakpoint-form-row" key={row.id}>
                    <label>
                      <span>Viewport width ≥ (px)</span>
                      <input aria-label={`Breakpoint ${index + 1} minimum browser viewport width`} disabled={submitting || mode === 'duplicate'} min="0" onChange={(event) => updateRow(row.id, { minWidth: Number(event.target.value) })} type="number" value={row.minWidth} />
                    </label>
                    <label className="sizes-field">
                      <span>Sizes</span>
                      <input aria-label={`Breakpoint ${index + 1} sizes`} disabled={submitting || mode === 'duplicate'} onChange={(event) => updateRow(row.id, { sizesText: event.target.value })} placeholder="970x250 | 728x90 | fluid · or leave empty" value={row.sizesText} />
                    </label>
                    {mode !== 'duplicate' ? (
                      <button aria-label={`Remove breakpoint ${index + 1}`} className="breakpoint-remove" disabled={submitting || rows.length === 1} onClick={() => removeBreakpoint(row.id)} type="button">×</button>
                    ) : null}
                    <div className="breakpoint-reserved-height" aria-live="polite">
                      <span>Reserved ad height / CSS min-height</span>
                      <output aria-label={`Breakpoint ${index + 1} reserved ad height`}>{reserve?.label ?? 'Enter valid Sizes to calculate'}</output>
                      <small>{reserve?.detail ?? 'Use fixed dimensions such as 300x250, fluid, or an empty field.'}</small>
                    </div>
                    <details className="breakpoint-viewport-height" open={row.minHeight > 0 || undefined}>
                      <summary>Advanced: browser viewport height{row.minHeight ? ` ≥ ${row.minHeight}px` : ''}</summary>
                      <label>
                        <span>Minimum browser viewport height (px)</span>
                        <input aria-label={`Breakpoint ${index + 1} minimum browser viewport height`} disabled={submitting || mode === 'duplicate'} min="0" onChange={(event) => updateRow(row.id, { minHeight: Number(event.target.value) })} type="number" value={row.minHeight} />
                        <small>Additional condition on the browser window, not reserved ad space. Keep 0 for width-only rules. Nonzero values require a script and ad format that support viewport-height rules.</small>
                      </label>
                    </details>
                  </div>
                );})}
              </div>

              {mode === 'duplicate' ? <div className="form-options">The copied map keeps all {source?.map.length ?? 0} breakpoint(s). Save it first, then edit if needed.</div> : null}
              {formError ? <div ref={formNotice} role="alert" className="form-error">{formError}</div> : null}
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
