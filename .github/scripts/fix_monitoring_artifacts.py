from pathlib import Path

path = Path('worker/monitoring.ts')
source = path.read_text(encoding='utf-8')
old_files = """const ARTIFACT_FILES = [
  'ads.js',
  'ads.min.js',
  'prebid.js',
  'manifest.json',
"""
new_files = """const ARTIFACT_FILES = [
  'ads.js',
  'ads.min.js',
  'prebid.js',
  'config.json',
  'manifest.json',
"""
if new_files not in source:
    if old_files not in source:
        raise SystemExit('ARTIFACT_FILES anchor was not found.')
    source = source.replace(old_files, new_files, 1)
old_required = "    const required = fileName !== 'prebid.js' || prebidRequired;"
new_required = "    const required = fileName !== 'sticky.css' && (fileName !== 'prebid.js' || prebidRequired);"
if new_required not in source:
    if old_required not in source:
        raise SystemExit('artifact required anchor was not found.')
    source = source.replace(old_required, new_required, 1)
path.write_text(source, encoding='utf-8')
