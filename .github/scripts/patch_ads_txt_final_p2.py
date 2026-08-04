from pathlib import Path

panel_path = Path("src/components/AdsTxtPanel.tsx")
panel = panel_path.read_text()
old_join = """    const joined = row.length >= 3 && /^(direct|reseller)$/i.test(row[2] ?? '')
      ? row.slice(0, 4).join(', ')
      : row.join(', ');"""
new_join = """    const joined = row.join(', ');"""
if old_join not in panel:
    raise SystemExit("AdsTxtPanel import join target not found")
panel_path.write_text(panel.replace(old_join, new_join, 1))

sources_path = Path("worker/ads-txt-requirement-sources.ts")
sources = sources_path.read_text()
old_empty_source = """  const source = await sourceRows(env.DB, sourceSiteId);
  if (!source.length) return;
  const normalized = source.map((row) => normalizeInput({"""
new_empty_source = """  const source = await sourceRows(env.DB, sourceSiteId);
  const normalized = source.map((row) => normalizeInput({"""
if old_empty_source not in sources:
    raise SystemExit("Empty source duplication target not found")
sources_path.write_text(sources.replace(old_empty_source, new_empty_source, 1))
