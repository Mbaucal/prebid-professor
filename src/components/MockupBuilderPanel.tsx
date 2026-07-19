import { useCallback, useMemo, useState } from 'react';
import { api } from '../api';
import type { AdUnit, SizeMap } from '../shared/types';

type Props = {
  publisherId: string;
  siteName: string;
};

type InsertMode = 'selector' | 'fixed';
type InsertPosition = 'before' | 'after' | 'prepend' | 'append';

type MockupRow = {
  id: string;
  enabled: boolean;
  label: string;
  mode: InsertMode;
  width: number;
  height: number;
  selector: string;
  position: InsertPosition;
  extraJson: string;
};

type MockupSettings = {
  borderColor: string;
  backgroundColor: string;
  textColor: string;
  selectorHoverColor: string;
  hideRealAds: boolean;
};

const DEFAULT_SETTINGS: MockupSettings = {
  borderColor: '#2563eb',
  backgroundColor: '#eff6ff',
  textColor: '#17324d',
  selectorHoverColor: '#f97316',
  hideRealAds: true,
};

function rowId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `row-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function emptyRow(): MockupRow {
  return {
    id: rowId(),
    enabled: true,
    label: 'Ad_Position',
    mode: 'selector',
    width: 300,
    height: 250,
    selector: 'main, #content, body',
    position: 'append',
    extraJson: '{}',
  };
}

function firstUsefulSize(unit: AdUnit, maps: Map<string, SizeMap>): [number, number] {
  const map = unit.sizeMapKey ? maps.get(unit.sizeMapKey) : null;
  if (!map) return [300, 250];

  const breakpoints = [...map.map].sort(
    (left, right) => left.minViewPort[0] - right.minViewPort[0] || left.minViewPort[1] - right.minViewPort[1],
  );
  for (const breakpoint of breakpoints) {
    const useful = breakpoint.sizes.find(([width, height]) => width > 1 && height > 1);
    if (useful) return useful;
  }
  return [300, 250];
}

function defaultSelector(code: string): string {
  const normalized = code.toLowerCase();
  if (normalized.includes('sticky') || normalized.includes('adhesion')) return 'body';
  if (normalized.includes('branding')) return 'main, #content, body';
  if (normalized.includes('billboard')) return 'main, #content, body';
  if (normalized.includes('infeed') || normalized.includes('intext') || normalized.includes('under_article')) {
    return 'article, main, #content, body';
  }
  return 'article, main, #content, body';
}

function rowFromAdUnit(unit: AdUnit, maps: Map<string, SizeMap>): MockupRow {
  const [width, height] = firstUsefulSize(unit, maps);
  const sticky = /sticky|adhesion/i.test(unit.code);
  return {
    id: rowId(),
    enabled: unit.enabled,
    label: unit.code,
    mode: sticky ? 'fixed' : 'selector',
    width,
    height,
    selector: defaultSelector(unit.code),
    position: /billboard/i.test(unit.code) ? 'prepend' : 'after',
    extraJson: sticky
      ? JSON.stringify({ style: { bottom: '0', left: '50%', transform: 'translateX(-50%)' } })
      : '{}',
  };
}

function parseExtraJson(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Extra JSON must be an object.');
  }
  return parsed as Record<string, unknown>;
}

function validateRows(rows: MockupRow[]): string[] {
  const errors: string[] = [];
  rows.forEach((row, index) => {
    if (!row.enabled) return;
    if (!row.label.trim()) errors.push(`Row ${index + 1}: label is required.`);
    if (!Number.isFinite(row.width) || row.width <= 0) errors.push(`Row ${index + 1}: width must be greater than 0.`);
    if (!Number.isFinite(row.height) || row.height <= 0) errors.push(`Row ${index + 1}: height must be greater than 0.`);
    if (row.mode === 'selector' && !row.selector.trim()) errors.push(`Row ${index + 1}: selector/root is required.`);
    try {
      parseExtraJson(row.extraJson);
    } catch (error) {
      errors.push(`Row ${index + 1}: ${error instanceof Error ? error.message : 'Extra JSON is invalid.'}`);
    }
  });
  if (!rows.some((row) => row.enabled)) errors.push('Enable at least one mockup row.');
  return errors;
}

function generatedScript(siteName: string, rows: MockupRow[], settings: MockupSettings): string {
  const config = {
    site: siteName,
    generatedAt: new Date().toISOString(),
    settings,
    rows: rows
      .filter((row) => row.enabled)
      .map((row) => ({
        label: row.label.trim(),
        mode: row.mode,
        width: Math.round(row.width),
        height: Math.round(row.height),
        selector: row.selector.trim(),
        position: row.position,
        extra: parseExtraJson(row.extraJson),
      })),
  };

  return String.raw`(function () {
  'use strict';

  var config = ${JSON.stringify(config, null, 2)};
  var hiddenElements = [];
  var pickerCleanup = null;
  var styleId = 'pp-mockup-runtime-style';

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^A-Za-z0-9_-]/g, function (character) { return '\\' + character; });
  }

  function ensureStyles() {
    var existing = document.getElementById(styleId);
    if (existing) return existing;
    var style = document.createElement('style');
    style.id = styleId;
    style.textContent = [
      '.pp-mockup-slot{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;margin:12px auto;padding:10px;text-align:center;font:600 14px/1.25 Arial,Helvetica,sans-serif;letter-spacing:.01em;box-shadow:0 6px 20px rgba(15,23,42,.14);overflow:hidden}',
      '.pp-mockup-slot strong{font-size:15px}',
      '.pp-mockup-slot span{font-size:12px;font-weight:500;opacity:.75}',
      '.pp-mockup-slot.pp-mockup-fixed{margin:0}',
      '.pp-mockup-pick-active *{cursor:crosshair!important}'
    ].join('');
    document.head.appendChild(style);
    return style;
  }

  function rememberAndHide(element) {
    if (!element || element.getAttribute('data-pp-mockup-hidden') === '1') return;
    hiddenElements.push({ element: element, style: element.getAttribute('style') });
    element.setAttribute('data-pp-mockup-hidden', '1');
    element.style.setProperty('visibility', 'hidden', 'important');
    element.style.setProperty('pointer-events', 'none', 'important');
  }

  function hideRealAds() {
    restoreRealAds();
    var selectors = [
      'iframe[id^="google_ads_iframe_"]',
      'iframe[src*="doubleclick.net"]',
      'iframe[src*="googlesyndication.com"]',
      '.adnxs_tag iframe',
      '.adform-adbox iframe'
    ];
    try {
      document.querySelectorAll(selectors.join(',')).forEach(rememberAndHide);
    } catch (error) {
      console.warn('[PP Mockup] Real-ad selector failed.', error);
    }
    config.rows.forEach(function (row) {
      var container = document.getElementById(row.label);
      if (!container) return;
      container.querySelectorAll('iframe, [id^="google_ads_iframe_"]').forEach(rememberAndHide);
    });
  }

  function restoreRealAds() {
    hiddenElements.forEach(function (entry) {
      if (!entry.element) return;
      entry.element.removeAttribute('data-pp-mockup-hidden');
      if (entry.style === null) entry.element.removeAttribute('style');
      else entry.element.setAttribute('style', entry.style);
    });
    hiddenElements = [];
  }

  function applyExtra(element, extra) {
    if (!extra || typeof extra !== 'object') return;
    if (typeof extra.className === 'string' && extra.className.trim()) {
      extra.className.trim().split(/\s+/).forEach(function (name) { element.classList.add(name); });
    }
    if (typeof extra.text === 'string') element.querySelector('strong').textContent = extra.text;
    var style = extra.style && typeof extra.style === 'object' ? extra.style : extra;
    Object.keys(style).forEach(function (key) {
      if (key === 'className' || key === 'text' || key === 'style') return;
      var value = style[key];
      if (value === null || value === undefined) return;
      try { element.style[key] = String(value); } catch (error) { console.warn('[PP Mockup] Invalid style key:', key); }
    });
  }

  function createSlot(row, index) {
    var element = document.createElement('div');
    element.className = 'pp-mockup-slot' + (row.mode === 'fixed' ? ' pp-mockup-fixed' : '');
    element.setAttribute('data-pp-mockup-label', row.label);
    element.style.width = row.width + 'px';
    element.style.height = row.height + 'px';
    element.style.maxWidth = 'calc(100vw - 16px)';
    element.style.border = '2px dashed ' + config.settings.borderColor;
    element.style.background = config.settings.backgroundColor;
    element.style.color = config.settings.textColor;
    element.style.zIndex = String(2147482000 + index);
    element.innerHTML = '<strong></strong><span></span>';
    element.querySelector('strong').textContent = row.label;
    element.querySelector('span').textContent = row.width + ' × ' + row.height + ' px';

    if (row.mode === 'fixed') {
      element.style.position = 'fixed';
      element.style.left = '50%';
      element.style.bottom = '20px';
      element.style.transform = 'translateX(-50%)';
    }
    applyExtra(element, row.extra);
    return element;
  }

  function resolveTarget(selector) {
    if (!selector) return document.body;
    try { return document.querySelector(selector); }
    catch (error) {
      console.warn('[PP Mockup] Invalid selector:', selector, error);
      return null;
    }
  }

  function insertSlot(row, element) {
    if (row.mode === 'fixed') {
      document.body.appendChild(element);
      return true;
    }
    var target = resolveTarget(row.selector);
    if (!target) return false;
    if (row.position === 'before') target.before(element);
    else if (row.position === 'after') target.after(element);
    else if (row.position === 'prepend') target.prepend(element);
    else target.append(element);
    return true;
  }

  function clear() {
    if (pickerCleanup) pickerCleanup();
    document.querySelectorAll('.pp-mockup-slot').forEach(function (element) { element.remove(); });
    var style = document.getElementById(styleId);
    if (style) style.remove();
    restoreRealAds();
  }

  function render() {
    clear();
    ensureStyles();
    if (config.settings.hideRealAds) hideRealAds();
    var results = [];
    config.rows.forEach(function (row, index) {
      var element = createSlot(row, index);
      var inserted = insertSlot(row, element);
      results.push({ label: row.label, inserted: inserted, selector: row.selector || 'body', mode: row.mode });
      if (!inserted) console.warn('[PP Mockup] Target not found for', row.label, row.selector);
    });
    console.table(results);
    return results;
  }

  function selectorFor(element) {
    if (!(element instanceof Element)) return '';
    if (element.id) return '#' + cssEscape(element.id);
    var parts = [];
    var current = element;
    while (current && current.nodeType === 1 && current !== document.body) {
      var part = current.tagName.toLowerCase();
      var classNames = Array.from(current.classList).filter(function (name) {
        return name && !name.startsWith('pp-mockup');
      }).slice(0, 2);
      if (classNames.length) part += '.' + classNames.map(cssEscape).join('.');
      var parent = current.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function (sibling) { return sibling.tagName === current.tagName; });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
      if (parts.length >= 5) break;
    }
    return parts.join(' > ');
  }

  function pick() {
    if (pickerCleanup) pickerCleanup();
    document.documentElement.classList.add('pp-mockup-pick-active');
    var hovered = null;
    var originalOutline = '';
    var originalOffset = '';

    function restoreHover() {
      if (!hovered) return;
      hovered.style.outline = originalOutline;
      hovered.style.outlineOffset = originalOffset;
      hovered = null;
    }

    function move(event) {
      var target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest('.pp-mockup-slot')) return;
      if (target === hovered) return;
      restoreHover();
      hovered = target;
      originalOutline = target.style.outline;
      originalOffset = target.style.outlineOffset;
      target.style.outline = '3px solid ' + config.settings.selectorHoverColor;
      target.style.outlineOffset = '2px';
    }

    function stop() {
      restoreHover();
      document.documentElement.classList.remove('pp-mockup-pick-active');
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', choose, true);
      document.removeEventListener('keydown', keydown, true);
      pickerCleanup = null;
    }

    function choose(event) {
      var target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest('.pp-mockup-slot')) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      var selector = selectorFor(target);
      stop();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(selector).catch(function () {});
      }
      console.log('[PP Mockup] Selector copied:', selector, target);
      return selector;
    }

    function keydown(event) {
      if (event.key === 'Escape') {
        stop();
        console.info('[PP Mockup] Selector picker cancelled.');
      }
    }

    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', choose, true);
    document.addEventListener('keydown', keydown, true);
    pickerCleanup = stop;
    console.info('[PP Mockup] Click an element to copy its selector. Press Escape to cancel.');
  }

  window.ppMockup = {
    config: config,
    render: render,
    clear: clear,
    pick: pick,
    hideRealAds: hideRealAds,
    restoreRealAds: restoreRealAds
  };

  render();
  console.info('[PP Mockup] Ready. Use ppMockup.pick(), ppMockup.render() or ppMockup.clear().');
})();
`;
}

function downloadScript(value: string, publisherId: string): void {
  const blob = new Blob([value], { type: 'text/javascript;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `mockup-${publisherId}.js`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function MockupBuilderPanel({ publisherId, siteName }: Props) {
  const [rows, setRows] = useState<MockupRow[]>([]);
  const [settings, setSettings] = useState<MockupSettings>(DEFAULT_SETTINGS);
  const [script, setScript] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const enabledCount = useMemo(() => rows.filter((row) => row.enabled).length, [rows]);

  const updateRow = useCallback(<K extends keyof MockupRow>(id: string, key: K, value: MockupRow[K]) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, [key]: value } : row)));
    setScript('');
  }, []);

  async function loadCurrentAdUnits(): Promise<void> {
    if (rows.length && !window.confirm('Replace the current mockup rows with active ad units from this site?')) return;
    setLoading(true);
    setError(null);
    try {
      const [adUnits, sizeMaps] = await Promise.all([
        api.listAdUnits(publisherId),
        api.listSizeMaps(publisherId),
      ]);
      const maps = new Map(sizeMaps.map((map) => [map.name, map]));
      const nextRows = adUnits
        .filter((unit) => unit.enabled && unit.type !== 'DRAFT')
        .sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code))
        .map((unit) => rowFromAdUnit(unit, maps));
      setRows(nextRows.length ? nextRows : [emptyRow()]);
      setScript('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Ad units could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  function build(): string | null {
    const errors = validateRows(rows);
    if (errors.length) {
      setError(errors.join(' '));
      return null;
    }
    try {
      const value = generatedScript(siteName, rows, settings);
      setError(null);
      setScript(value);
      return value;
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : 'Mockup script could not be generated.');
      return null;
    }
  }

  async function copyGeneratedScript(): Promise<void> {
    const value = script || build();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Clipboard access was blocked by the browser. Use Download script instead.');
    }
  }

  return (
    <section className="mockup-page">
      <div className="mockup-heading">
        <div>
          <span className="panel-kicker">Visual implementation helper</span>
          <h2>Mockup Builder</h2>
          <p>
            Build a standalone console script for temporary ad placeholders on the live page. The generated script never changes
            the dashboard configuration and can be removed with <code>ppMockup.clear()</code>.
          </p>
        </div>
        <div className="mockup-summary">
          <strong>{enabledCount}</strong>
          <span>enabled mockup(s)</span>
        </div>
      </div>

      {error ? <div className="form-error mockup-error">{error}</div> : null}

      <article className="mockup-settings-card">
        <div className="mockup-settings-grid">
          <label><span>Border color</span><input onChange={(event) => { setSettings((current) => ({ ...current, borderColor: event.target.value })); setScript(''); }} type="color" value={settings.borderColor} /></label>
          <label><span>Background color</span><input onChange={(event) => { setSettings((current) => ({ ...current, backgroundColor: event.target.value })); setScript(''); }} type="color" value={settings.backgroundColor} /></label>
          <label><span>Text color</span><input onChange={(event) => { setSettings((current) => ({ ...current, textColor: event.target.value })); setScript(''); }} type="color" value={settings.textColor} /></label>
          <label><span>Selector hover</span><input onChange={(event) => { setSettings((current) => ({ ...current, selectorHoverColor: event.target.value })); setScript(''); }} type="color" value={settings.selectorHoverColor} /></label>
          <label>
            <span>Hide real ad iframes</span>
            <select onChange={(event) => { setSettings((current) => ({ ...current, hideRealAds: event.target.value === 'true' })); setScript(''); }} value={String(settings.hideRealAds)}>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>
        </div>

        <div className="mockup-toolbar">
          <button className="button secondary" disabled={loading} onClick={() => void loadCurrentAdUnits()} type="button">
            {loading ? 'Loading…' : 'Load current ad units'}
          </button>
          <button className="button secondary" onClick={() => { setRows((current) => [...current, emptyRow()]); setScript(''); }} type="button">＋ Add row</button>
          <button className="button primary" onClick={() => void build()} type="button">Generate script</button>
          <button className={copied ? 'button success' : 'button secondary'} onClick={() => void copyGeneratedScript()} type="button">
            {copied ? '✓ Copied' : 'Copy script'}
          </button>
          <button className="button secondary" disabled={!script} onClick={() => script && downloadScript(script, publisherId)} type="button">Download .js</button>
          <button className="button danger subtle" disabled={!rows.length} onClick={() => { setRows([]); setScript(''); setError(null); }} type="button">Clear rows</button>
        </div>
      </article>

      <article className="mockup-table-card">
        <div className="mockup-table-scroll">
          <table className="mockup-table">
            <thead>
              <tr>
                <th>On</th>
                <th>Label</th>
                <th>Mode</th>
                <th>W</th>
                <th>H</th>
                <th>Selector / root</th>
                <th>Position</th>
                <th>Extra JSON</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td><input checked={row.enabled} onChange={(event) => updateRow(row.id, 'enabled', event.target.checked)} type="checkbox" /></td>
                  <td><input onChange={(event) => updateRow(row.id, 'label', event.target.value)} value={row.label} /></td>
                  <td>
                    <select onChange={(event) => updateRow(row.id, 'mode', event.target.value as InsertMode)} value={row.mode}>
                      <option value="selector">Selector</option>
                      <option value="fixed">Fixed</option>
                    </select>
                  </td>
                  <td><input min="1" onChange={(event) => updateRow(row.id, 'width', Number(event.target.value))} type="number" value={row.width} /></td>
                  <td><input min="1" onChange={(event) => updateRow(row.id, 'height', Number(event.target.value))} type="number" value={row.height} /></td>
                  <td><input disabled={row.mode === 'fixed'} onChange={(event) => updateRow(row.id, 'selector', event.target.value)} placeholder="article, main, body" value={row.selector} /></td>
                  <td>
                    <select disabled={row.mode === 'fixed'} onChange={(event) => updateRow(row.id, 'position', event.target.value as InsertPosition)} value={row.position}>
                      <option value="before">Before</option>
                      <option value="after">After</option>
                      <option value="prepend">Prepend</option>
                      <option value="append">Append</option>
                    </select>
                  </td>
                  <td><input className="mockup-json-input" onChange={(event) => updateRow(row.id, 'extraJson', event.target.value)} placeholder={'{"style":{"marginTop":"20px"}}'} value={row.extraJson} /></td>
                  <td><button aria-label={`Remove ${row.label}`} className="mockup-remove" onClick={() => { setRows((current) => current.filter((item) => item.id !== row.id)); setScript(''); }} type="button">×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length ? (
          <div className="mockup-empty">
            <strong>No mockup rows yet</strong>
            <span>Load active ad units or add a row manually.</span>
          </div>
        ) : null}
      </article>

      <article className="mockup-output-card">
        <div className="mockup-output-heading">
          <div>
            <span className="panel-kicker">Browser console</span>
            <h3>Generated script</h3>
          </div>
          <p>After running it, use <code>ppMockup.pick()</code> to click an element and copy its selector.</p>
        </div>
        <pre>{script || 'Generate the script to preview and copy it here.'}</pre>
      </article>
    </section>
  );
}
