from pathlib import Path

worker_path = Path('worker/ads-txt-versions.ts')
worker = worker_path.read_text()
old_worker = """  const saved = await versionRow(db, siteId, id);
  if (!saved) {
    await env.BUILDS!.delete(objectKey).catch(() => undefined);
    return apiError('The saved version metadata could not be loaded.', 500);
  }
"""
new_worker = """  const saved = await versionRow(db, siteId, id)
    ?? await versionByChecksum(db, siteId, current.file.checksum);
  if (!saved) {
    return apiError(
      'The version was stored, but its metadata could not be reloaded. Refresh version history and try again.',
      500,
    );
  }
"""
if old_worker not in worker:
    raise SystemExit('worker saved-version block not found')
worker_path.write_text(worker.replace(old_worker, new_worker, 1))

panel_path = Path('src/components/AdsTxtVersionsPanel.tsx')
panel = panel_path.read_text()
old_success = """      setNote('');
      setMessage(payload.message || `Version ${payload.version.versionNumber} saved.`);
      await loadForSite(site);
      setHistoryOpen(true);
"""
new_success = """      setNote('');
      await loadForSite(site);
      if (activeSiteIdRef.current !== requestedSiteId) return;
      setMessage(payload.message || `Version ${payload.version.versionNumber} saved.`);
      setHistoryOpen(true);
"""
if old_success not in panel:
    raise SystemExit('panel success block not found')
panel = panel.replace(old_success, new_success, 1)

old_button = """            <button
              className=\"button primary\"
              disabled={saving || !currentFile?.rowCount || Boolean(matchingVersion)}
              onClick={() => void saveCurrentVersion()}
              type=\"button\"
            >
              {saving
                ? 'Saving version…'
                : matchingVersion
                  ? `Already saved as v${matchingVersion.versionNumber}`
                  : 'Save current version'}
            </button>
"""
new_button = """            <div className=\"ads-txt-version-create-actions\">
              <button
                className=\"button secondary\"
                disabled={saving || loading}
                onClick={() => void loadForSite(site)}
                type=\"button\"
              >
                Refresh status
              </button>
              <button
                className=\"button primary\"
                disabled={saving || !currentFile?.rowCount || Boolean(matchingVersion)}
                onClick={() => void saveCurrentVersion()}
                type=\"button\"
              >
                {saving
                  ? 'Saving version…'
                  : matchingVersion
                    ? `Already saved as v${matchingVersion.versionNumber}`
                    : 'Save current version'}
              </button>
            </div>
"""
if old_button not in panel:
    raise SystemExit('panel save button block not found')
panel_path.write_text(panel.replace(old_button, new_button, 1))

css_path = Path('src/ads-txt-versions.css')
css = css_path.read_text()
old_css = """.ads-txt-version-create .button {
  min-height: 42px;
}
"""
new_css = """.ads-txt-version-create-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ads-txt-version-create-actions .button {
  min-height: 42px;
}
"""
if old_css not in css:
    raise SystemExit('version action CSS block not found')
css_path.write_text(css.replace(old_css, new_css, 1))
