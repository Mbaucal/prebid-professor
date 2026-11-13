import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import BulkImportPanel from './BulkImportPanel';
import OutstreamSettingsPanel from './OutstreamSettingsPanel';
import type { AdUnit, SizeMap, SizeMapPageTypeConfirmation, SizeMapReference } from '../shared/types';
import { reservedHeightSummary } from '../shared/size-map-height-summary';
import { comparePageTypeChanges, describePageTypeChange, pageTypeRenames } from '../../shared/size-maps/page-type.mjs';

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
// Ad units and saved rules must be reassigned first; page-type use is confirmed instead.
const BLOCKING_SOURCES = new Set<SizeMapReference['source']>(['ad-unit', 'rule', 'advanced-rule']);

function pageTypeConfirmation(error: unknown): SizeMapPageTypeConfirmation | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const details = error.details as { confirmation?: SizeMapPageTypeConfirmation } | undefined;
  return details?.confirmation?.token && Array.isArray(details.confirmation.changes) ? details.confirmation : null;
}

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
  const [confirmation, setConfirmation] = useState<SizeMapPageTypeConfirmation | null>(null);
  const [formatReview, setFormatReview] = useState<Array<{code:string;message:string}>>([]);
  const [formatReviewError, setFormatReviewError] = useState('');
  const [reviewingFormat, setReviewingFormat] = useState<string | null>(null);
  const reviewNotice = useRef<HTMLDivElement>(null);
  const loadFormatReview = useCallback(async () => {
    setFormatReviewError('');
    try {
      const response = await fetch(`/api/publishers/${encodeURIComponent(publisherId)}/outstream-settings`, {credentials:'same-origin',cache:'no-store'});
      const result = await response.json() as {formatReviewRequired?:Array<{code:string;message:string}>;error?:string};
      if(!response.ok)throw Error(result.error || 'Could not check Outstream size settings.');
      setFormatReview(result.formatReviewRequired ?? []);
    } catch (error) {setFormatReviewError(error instanceof Error ? error.message : 'Could not check Outstream size settings.');}
  }, [publisherId]);
  useEffect(() => {if(formatReview.length && !mode && !reviewingFormat){reviewNotice.current?.scrollIntoView({block:'center'});reviewNotice.current?.focus();}}, [formatReview,mode,reviewingFormat]);
  const [submitting, setSubmitting] = useState(false);
  const errorNotice = useRef<HTMLDivElement>(null);
  const formNotice = useRef<HTMLDivElement>(null);
  const confirmNotice = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errorNotice.current?.scrollIntoView({ block: 'nearest' }); }, [error]);
  useEffect(() => { if (formError) formNotice.current?.scrollIntoView({ block: 'nearest' }); }, [formError]);
  useEffect(() => { if (confirmation) confirmNotice.current?.scrollIntoView({ block: 'nearest' }); }, [confirmation]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [maps, units] = await Promise.all([api.listSizeMaps(publisherId), api.listAdUnits(publisherId), loadFormatReview()]);
      setSizeMaps(maps.map(asFlexible));
      setAdUnits(units);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load size maps.');
    } finally {
      setLoading(false);
    }
  }, [publisherId,loadFormatReview]);

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

  // Page-type maps (<page type>_<name>) follow a rename; the server re-checks this list.
  // Maps that ad units use directly, and page-type maps of other bases, never move with it.
  const pageTypeMapRenames = useMemo(() => {
    const next = name.trim();
    if (mode !== 'edit' || !source || !next || next === source.name) return [];
    const unitBases = new Set(adUnits.map((unit) => unit.sizeMapKey).filter((key): key is string => Boolean(key)));
    return [...pageTypeRenames(sizeMaps.map((item) => item.name), source.name, next, unitBases)].filter(([from]) => from !== source.name);
  }, [mode, source, name, sizeMaps, adUnits]);

  function openCreate() {
    setMode('create');
    setSource(null);
    setName('');
    setRows([emptyBreakpoint(0)]);
    setFormError(null);
    setConfirmation(null);
  }

  function openEdit(item: FlexibleMap) {
    setMode('edit');
    setSource(item);
    setName(item.name);
    setRows(rowsFromMap(item.map));
    setFormError(null);
    setConfirmation(null);
  }

  function openDuplicate(item: FlexibleMap) {
    setMode('duplicate');
    setSource(item);
    setName(nextCopyName(item.name));
    setRows(rowsFromMap(item.map));
    setFormError(null);
    setConfirmation(null);
  }

  function closeForm() {
    if (submitting) return;
    setMode(null);
    setSource(null);
    setFormError(null);
    setConfirmation(null);
  }

  function updateRow(id: string, patch: Partial<BreakpointForm>) {
    setConfirmation(null);
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function addBreakpoint() {
    setConfirmation(null);
    const currentMax = rows.reduce((max, row) => Math.max(max, Number(row.minWidth) || 0), 0);
    setRows((current) => [...current, emptyBreakpoint(currentMax ? currentMax + 1 : 469)]);
  }

  function removeBreakpoint(id: string) {
    setConfirmation(null);
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
          ...(confirmation ? { confirmPageTypeChanges: confirmation.token } : {}),
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
      setConfirmation(null);
    } catch (requestError) {
      const required = pageTypeConfirmation(requestError);
      setConfirmation(required);
      setFormError(required ? null : requestError instanceof Error ? requestError.message : 'Size map operation failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(item: FlexibleMap) {
    const blocking = item.references
      ? item.references.filter((reference) => BLOCKING_SOURCES.has(reference.source)).map((reference) => reference.label)
      : usage.get(item.name) ?? [];
    if (blocking.length) {
      setError(`${item.name} is used by ${blocking.join(', ')}. Reassign these references before deleting it.`);
      return;
    }
    // Page-type maps fall back to their base map; the listing says which positions that affects.
    const references = item.references ?? [];
    const shownChanges = references
      .filter((reference) => reference.source === 'page-type' && reference.pageType && reference.baseMap)
      .map((reference) => ({ pageType: reference.pageType!, base: reference.baseMap!, codes: reference.units ?? [], from: item.name, to: null }))
      .sort(comparePageTypeChanges)
      .map(describePageTypeChange);
    const shownVideo = [...new Set(references.filter((reference) => reference.source === 'outstream').map((reference) => reference.scope))];
    const prompt = (changes: string[], videoUnits: string[]) => [`Delete size map ${item.name}?`, ...changes,
      ...(videoUnits.length ? [`Saved Outstream video sizes for this map are removed from ${videoUnits.join(', ')}.`] : []),
      ...(changes.length ? ['The next Generate uses these sizes. Existing packages do not change.'] : [])].join('\n\n');
    if (!window.confirm(prompt(shownChanges, shownVideo))) return;

    try {
      // The server re-checks the impact. A delete is sent with its token only after the
      // operator has seen exactly those lines; changed lines are shown again first.
      let shown = JSON.stringify([shownChanges, shownVideo]);
      let token: string | undefined;
      for (let attempt = 0; ; attempt += 1) {
        try {
          await api.deleteSizeMap(publisherId, item.id, token);
          break;
        } catch (requestError) {
          const required = pageTypeConfirmation(requestError);
          if (!required || attempt >= 3) throw requestError;
          const changes = required.changes.map((change) => change.message), videoUnits = required.videoUnits ?? [];
          const fresh = JSON.stringify([changes, videoUnits]);
          if (fresh !== shown && !window.confirm(prompt(changes, videoUnits))) return;
          shown = fresh;
          token = required.token;
        }
      }
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

        {formatReview.length ? <div ref={reviewNotice} tabIndex={-1} role="status" className="size-map-compat-note" style={{display:'block'}}>
          <strong>Review Outstream sizes before Generate</strong>
          <p>The size map is saved. Review the video size choices for these positions before generating a new package.</p>
          {formatReview.map(item=><div key={item.code}><p>{item.message}</p><button className="button secondary" type="button" onClick={()=>setReviewingFormat(item.code)}>Review formats for {item.code}</button></div>)}
        </div> : null}
        {formatReviewError ? <div role="alert" className="form-error"><p>{formatReviewError}</p><button className="button secondary" type="button" onClick={()=>void loadFormatReview()}>Retry Outstream review</button></div> : null}
        <div className="size-map-compat-note">
          <strong>Special values:</strong>
          <span><code>fluid</code> is valid for GPT/native inventory. Leave Sizes empty to create <code>[]</code> and disable the slot at that viewport.</span>
        </div>

        <details className="size-map-csv">
          <summary>Import size maps / Download CSV template</summary>
          <BulkImportPanel
            publisherId={publisherId}
            onlyKind="size-maps"
            onChanged={async () => { await load(); await onChanged?.(); }}
          />
        </details>

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

      {reviewingFormat ? <OutstreamSettingsPanel key={publisherId+reviewingFormat} publisherId={publisherId} code={reviewingFormat} onClose={()=>setReviewingFormat(null)} onOpenSizeMaps={()=>setReviewingFormat(null)} onSaved={()=>{void loadFormatReview();void onChanged?.();}}/> : null}
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
                <input autoFocus disabled={submitting} onChange={(event) => { setConfirmation(null); setName(event.target.value); }} placeholder="Billboard" value={name} />
                <small>Renaming a map updates ad units, saved rules and Outstream video sizes that reference it, and renames its page-type maps (&lt;page type&gt;_{source?.name || 'name'}).</small>
                {pageTypeMapRenames.length ? <small className="page-type-renames">Also renames: {pageTypeMapRenames.map(([from, to]) => `${from} → ${to}`).join(', ')}</small> : null}
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
              {confirmation ? (
                <div ref={confirmNotice} role="alert" className="size-map-compat-note page-type-confirmation">
                  <strong>Confirm the page-type change</strong>
                  <ul>{confirmation.changes.map((change) => <li key={`${change.base}\u0000${change.pageType}`}>{change.message}</li>)}</ul>
                  {confirmation.videoUnits?.length ? <p>Saved Outstream video sizes for this map are removed from {confirmation.videoUnits.join(', ')}.</p> : null}
                  <p>The next Generate uses these sizes. Existing packages do not change.</p>
                </div>
              ) : null}
              {formError ? <div ref={formNotice} role="alert" className="form-error">{formError}</div> : null}
              <div className="modal-actions">
                <button className="button secondary" disabled={submitting} onClick={closeForm} type="button">Cancel</button>
                <button className="button primary" disabled={submitting} type="submit">
                  {submitting ? 'Saving…' : mode === 'duplicate' ? 'Duplicate size map' : confirmation ? 'Confirm and save' : 'Save size map'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}
