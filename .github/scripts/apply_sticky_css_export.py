from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if old not in source:
        raise SystemExit(f"{label} anchor was not found.")
    return source.replace(old, new, 1)


# worker/releases.ts
path = Path("worker/releases.ts")
source = path.read_text(encoding="utf-8")
source = replace_once(
    source,
    "  'min-height.css',\n  'div-export.csv',",
    "  'min-height.css',\n  'sticky.css',\n  'div-export.csv',",
    "RELEASE_FILES sticky.css",
)

sticky_helper = r'''function cssCommentText(value: string): string {
  return value.replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ').trim();
}

function stickyCss(snapshot: Snapshot): string {
  const runtime = isRecord(snapshot.config.runtimeControls) ? snapshot.config.runtimeControls : {};
  const sticky = isRecord(runtime.sticky) ? runtime.sticky : {};
  const defaultBottom = snapshot.adUnits.some((unit) => unit.enabled === 1 && unit.code === 'Sticky')
    ? 'Sticky'
    : '';
  const bottomId = typeof sticky.bottomAdUnitId === 'string'
    ? sticky.bottomAdUnitId.trim()
    : defaultBottom;
  const topId = typeof sticky.topAdUnitId === 'string' ? sticky.topAdUnitId.trim() : '';
  const bottom = bottomId ? cssEscape(bottomId) : '';
  const top = topId ? cssEscape(topId) : '';
  const output = [
    '/*!',
    ' * Prebid Professor sticky ad styles',
    ` * Site: ${cssCommentText(snapshot.site.name)} (${cssCommentText(snapshot.site.domain)})`,
    ` * Bottom sticky: ${cssCommentText(bottomId || 'disabled')}`,
    ` * Top sticky: ${cssCommentText(topId || 'disabled')}`,
    ' * ads.js injects equivalent base styles automatically.',
    ' * Load this file only for external handoff or controlled overrides.',
    ' */',
  ];

  if (!bottom && !top) {
    output.push('', '/* No sticky ad unit is enabled for this site. */');
    return `${output.join('\n')}\n`;
  }

  if (bottom) {
    output.push(
      '',
      `#${bottom} {`,
      '  position: fixed;',
      '  left: 0;',
      '  right: 0;',
      '  bottom: 0;',
      '  width: 100%;',
      '  z-index: 2147483000;',
      '  display: flex;',
      '  justify-content: center;',
      '  align-items: flex-start;',
      '  background: rgba(247, 247, 247, 0.85);',
      '  border-top: 1px solid #ccc;',
      '  padding: 5px 0;',
      '  min-height: 50px;',
      '  opacity: 0;',
      '  visibility: hidden;',
      '  height: 0;',
      '  transform: translateY(16px);',
      '  transition: opacity 0.35s ease-out, visibility 0.35s ease-out, transform 0.35s ease-out;',
      '  overflow: visible;',
      '}',
      '',
      `#${bottom}.ad-loaded {`,
      '  opacity: 1;',
      '  visibility: visible;',
      '  height: auto;',
      '  transform: translateY(0);',
      '}',
      '',
      `#${bottom} #close_sticky_ad,`,
      'body > #close_sticky_ad {',
      '  position: absolute !important;',
      '  top: 6px !important;',
      '  right: 5px !important;',
      '  bottom: auto !important;',
      '  width: 28px !important;',
      '  height: 28px !important;',
      '  display: flex !important;',
      '  align-items: center !important;',
      '  justify-content: center !important;',
      '  background: #fff !important;',
      '  border: 1px solid #888 !important;',
      '  border-radius: 50% !important;',
      '  color: #333 !important;',
      '  cursor: pointer;',
      '  font: 28px/1 Arial, Helvetica, sans-serif !important;',
      '  text-align: center;',
      '  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.98), 0 1px 3px rgba(0, 0, 0, 0.2) !important;',
      '  user-select: none;',
      '  z-index: 2147483647 !important;',
      '}',
      '',
      '@media (max-width: 767px) {',
      `  #${bottom} #close_sticky_ad,`,
      '  body > #close_sticky_ad {',
      '    top: -8px !important;',
      '    right: 8px !important;',
      '    bottom: auto !important;',
      '  }',
      '}',
    );
  }

  if (top) {
    output.push(
      '',
      `#${top} {`,
      '  position: fixed;',
      '  left: 0;',
      '  right: 0;',
      '  top: 0;',
      '  width: 100%;',
      '  z-index: 2147483000;',
      '  display: flex;',
      '  justify-content: center;',
      '  align-items: flex-start;',
      '  background: rgba(247, 247, 247, 0.85);',
      '  border-bottom: 1px solid #ccc;',
      '  padding: 5px 0;',
      '  min-height: 50px;',
      '  opacity: 0;',
      '  visibility: hidden;',
      '  height: 0;',
      '  transform: translateY(-16px);',
      '  transition: opacity 0.35s ease-out, visibility 0.35s ease-out, transform 0.35s ease-out;',
      '  overflow: visible;',
      '}',
      '',
      `#${top}.ad-loaded {`,
      '  opacity: 1;',
      '  visibility: visible;',
      '  height: auto;',
      '  transform: translateY(0);',
      '}',
      '',
      `#${top} #close_sticky_top_ad {`,
      '  position: absolute !important;',
      '  right: 5px !important;',
      '  bottom: 6px !important;',
      '  top: auto !important;',
      '  width: 28px !important;',
      '  height: 28px !important;',
      '  display: flex !important;',
      '  align-items: center !important;',
      '  justify-content: center !important;',
      '  background: #fff !important;',
      '  border: 1px solid #888 !important;',
      '  border-radius: 50% !important;',
      '  color: #333 !important;',
      '  cursor: pointer;',
      '  font: 28px/1 Arial, Helvetica, sans-serif !important;',
      '  text-align: center;',
      '  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.98), 0 1px 3px rgba(0, 0, 0, 0.2) !important;',
      '  user-select: none;',
      '  z-index: 2147483001 !important;',
      '}',
      '',
      '@media (max-width: 767px) {',
      `  #${top} #close_sticky_top_ad {`,
      '    right: 8px !important;',
      '    bottom: -8px !important;',
      '    top: auto !important;',
      '  }',
      '}',
    );
  }

  return `${output.join('\n').trim()}\n`;
}

'''
anchor = "function csvCell(value: string): string {"
if anchor not in source:
    raise SystemExit("stickyCss insertion anchor was not found.")
source = source.replace(anchor, sticky_helper + anchor, 1)

source = replace_once(
    source,
    '''  return `<!-- Prebid Professor implementation for ${snapshot.site.name} -->\n<link rel="stylesheet" href="${origin}/cdn/${snapshot.site.id}/current/min-height.css">\n<script src="${origin}/cdn/${snapshot.site.id}/current/prebid.js"></script>\n<script src="${origin}/cdn/${snapshot.site.id}/current/ads.min.js"></script>\n\n${divs}\n`;''',
    '''  return `<!-- Prebid Professor implementation for ${snapshot.site.name} -->\n<link rel="stylesheet" href="${origin}/cdn/${snapshot.site.id}/current/min-height.css">\n<!-- ads.min.js injects sticky base styles. sticky.css is an optional handoff and override artifact. -->\n<script src="${origin}/cdn/${snapshot.site.id}/current/prebid.js"></script>\n<script src="${origin}/cdn/${snapshot.site.id}/current/ads.min.js"></script>\n\n${divs}\n`;''',
    "implementation sticky comment",
)

source = replace_once(
    source,
    '''      manifest: absoluteUrl(request, `${base}/manifest.json`), css: absoluteUrl(request, `${base}/min-height.css`),
      divCsv: absoluteUrl(request, `${base}/div-export.csv`), implementation: absoluteUrl(request, `${base}/implementation.html`),''',
    '''      manifest: absoluteUrl(request, `${base}/manifest.json`), css: absoluteUrl(request, `${base}/min-height.css`),
      stickyCss: absoluteUrl(request, `${base}/sticky.css`),
      divCsv: absoluteUrl(request, `${base}/div-export.csv`), implementation: absoluteUrl(request, `${base}/implementation.html`),''',
    "release payload stickyCss URL",
)

source = replace_once(
    source,
    '''      add('config.json', configText), add('min-height.css', minHeightCss(snapshot)), add('div-export.csv', divCsv(snapshot)),
      add('implementation.html', implementationHtml(snapshot, origin)),''',
    '''      add('config.json', configText), add('min-height.css', minHeightCss(snapshot)), add('sticky.css', stickyCss(snapshot)),
      add('div-export.csv', divCsv(snapshot)), add('implementation.html', implementationHtml(snapshot, origin)),''',
    "release generation sticky.css",
)

source = replace_once(
    source,
    '''    const source = await bucket.get(releaseKey(siteId, version, fileName));
    if (!source) throw new Error(`${fileName} is missing from release ${version}.`);''',
    '''    const source = await bucket.get(releaseKey(siteId, version, fileName));
    if (!source && fileName === 'sticky.css') {
      await bucket.delete(channelKey(siteId, channel, fileName)).catch(() => undefined);
      continue;
    }
    if (!source) throw new Error(`${fileName} is missing from release ${version}.`);''',
    "legacy sticky.css promotion",
)
path.write_text(source, encoding="utf-8")

# src/components/ReleasesPanel.tsx
path = Path("src/components/ReleasesPanel.tsx")
source = path.read_text(encoding="utf-8")
source = replace_once(
    source,
    "  css: string;\n  divCsv: string;",
    "  css: string;\n  stickyCss: string;\n  divCsv: string;",
    "ReleasesPanel stickyCss type",
)
source = replace_once(
    source,
    "['ads.min.js', 'prebid.js', 'manifest.json', 'min-height.css']",
    "['ads.min.js', 'prebid.js', 'manifest.json', 'min-height.css', 'sticky.css']",
    "ReleasesPanel channel file list",
)
path.write_text(source, encoding="utf-8")

# src/components/ExportPanel.tsx
path = Path("src/components/ExportPanel.tsx")
source = path.read_text(encoding="utf-8")
source = replace_once(
    source,
    "  css: string;\n  divCsv: string;",
    "  css: string;\n  stickyCss: string;\n  divCsv: string;",
    "ExportPanel stickyCss type",
)
source = replace_once(
    source,
    "  'min-height.css',\n  'div-export.csv',",
    "  'min-height.css',\n  'sticky.css',\n  'div-export.csv',",
    "ExportPanel artifact order",
)
source = replace_once(
    source,
    "    'min-height.css': release.urls.css,\n    'div-export.csv': release.urls.divCsv,",
    "    'min-height.css': release.urls.css,\n    'sticky.css': release.urls.stickyCss,\n    'div-export.csv': release.urls.divCsv,",
    "ExportPanel release artifact mapping",
)
source = replace_once(
    source,
    "  const [cssText, setCssText] = useState('');\n  const [loading, setLoading] = useState(true);\n  const [loadingCss, setLoadingCss] = useState(false);",
    "  const [cssText, setCssText] = useState('');\n  const [stickyCssText, setStickyCssText] = useState('');\n  const [loading, setLoading] = useState(true);\n  const [loadingCss, setLoadingCss] = useState(false);\n  const [loadingStickyCss, setLoadingStickyCss] = useState(false);",
    "ExportPanel sticky CSS state",
)
source = replace_once(
    source,
    '''    if (artifacts['min-height.css']) {
      lines.push(`<link rel="stylesheet" href="${artifacts['min-height.css']}">`);
    }
    if (prebidEnabled''',
    '''    if (artifacts['min-height.css']) {
      lines.push(`<link rel="stylesheet" href="${artifacts['min-height.css']}">`);
    }
    if (artifacts['sticky.css']) {
      lines.push('<!-- ads.min.js injects sticky base styles. sticky.css is an optional handoff and override artifact. -->');
    }
    if (prebidEnabled''',
    "ExportPanel implementation sticky note",
)

effect_anchor = "  async function copyText(value: string, label: string): Promise<void> {"
sticky_effect = '''  useEffect(() => {
    const url = artifacts['sticky.css'];
    if (!url) {
      setStickyCssText('');
      return;
    }
    let cancelled = false;
    setLoadingStickyCss(true);
    fetch(url, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Sticky CSS artifact returned ${response.status}.`);
        return response.text();
      })
      .then((text) => {
        if (!cancelled) setStickyCssText(text);
      })
      .catch(() => {
        if (!cancelled) setStickyCssText('');
      })
      .finally(() => {
        if (!cancelled) setLoadingStickyCss(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artifacts]);

'''
if effect_anchor not in source:
    raise SystemExit("ExportPanel sticky CSS effect anchor was not found.")
source = source.replace(effect_anchor, sticky_effect + effect_anchor, 1)

source = replace_once(
    source,
    "        `Demand mode: ${prebidEnabled ? 'GAM + Prebid' : 'GAM / AdX only'}`,\n        `Source: ${source}`,",
    "        `Demand mode: ${prebidEnabled ? 'GAM + Prebid' : 'GAM / AdX only'}`,\n        'Sticky styling: ads.js injects base styles automatically; sticky.css is included for review and optional external integration.',\n        `Source: ${source}`,",
    "Export ZIP README sticky note",
)

card_anchor = '''        <article className="export-card">
          <div className="export-card-heading">
            <div><span className="panel-kicker">Prebid.org</span><h3>Build configuration</h3></div>'''
sticky_card = '''        <article className="export-card">
          <div className="export-card-heading">
            <div><span className="panel-kicker">Sticky handoff</span><h3>Sticky CSS</h3></div>
            <div className="export-card-actions">
              <button disabled={!stickyCssText} onClick={() => void copyText(stickyCssText, 'sticky-css')} type="button">{copied === 'sticky-css' ? '✓ Copied' : 'Copy'}</button>
              <button disabled={!stickyCssText} onClick={() => downloadText(stickyCssText, `sticky-${safeFileName(site.id)}.css`, 'text/css')} type="button">Download</button>
            </div>
          </div>
          <pre className="export-code compact">{loadingStickyCss ? 'Loading sticky CSS artifact…' : stickyCssText || 'Sticky CSS is not available for this source.'}</pre>
        </article>

'''
if card_anchor not in source:
    raise SystemExit("ExportPanel sticky CSS card anchor was not found.")
source = source.replace(card_anchor, sticky_card + card_anchor, 1)
path.write_text(source, encoding="utf-8")

# .github/workflows/deploy-pages-release.yml
path = Path(".github/workflows/deploy-pages-release.yml")
source = path.read_text(encoding="utf-8")
loop_anchor = '''          for file in "${files[@]}"; do
            echo "Downloading ${file}"
            curl \\
              --fail \\
              --location \\
              --retry 3 \\
              --retry-all-errors \\
              --silent \\
              --show-error \\
              "${RELEASE_BASE_URL}/${file}" \\
              --output "dist/${file}"
          done

          cat > dist/_headers <<'EOF'
'''
loop_replacement = '''          for file in "${files[@]}"; do
            echo "Downloading ${file}"
            curl \\
              --fail \\
              --location \\
              --retry 3 \\
              --retry-all-errors \\
              --silent \\
              --show-error \\
              "${RELEASE_BASE_URL}/${file}" \\
              --output "dist/${file}"
          done

          echo "Downloading optional sticky.css"
          if ! curl \\
            --fail \\
            --location \\
            --retry 3 \\
            --retry-all-errors \\
            --silent \\
            --show-error \\
            "${RELEASE_BASE_URL}/sticky.css" \\
            --output "dist/sticky.css"; then
            rm -f dist/sticky.css
            echo "sticky.css is not present on this legacy release; continuing without it."
          fi

          cat > dist/_headers <<'EOF'
'''
source = replace_once(source, loop_anchor, loop_replacement, "Pages optional sticky.css")
path.write_text(source, encoding="utf-8")

# worker/app-deploy.ts
path = Path("worker/app-deploy.ts")
source = path.read_text(encoding="utf-8")
source = source.replace(
    "const RUNTIME_BUILD = '2026-07-18-release-cleanup-v9';",
    "const RUNTIME_BUILD = '2026-07-18-sticky-css-export-v10';",
    1,
)
path.write_text(source, encoding="utf-8")
