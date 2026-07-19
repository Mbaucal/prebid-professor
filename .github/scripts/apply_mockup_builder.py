from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if new in source:
        return source
    if old not in source:
        raise SystemExit(f"{label} anchor was not found.")
    return source.replace(old, new, 1)


app_path = Path("src/App.tsx")
app = app_path.read_text(encoding="utf-8")
app = replace_once(
    app,
    "import ReleasesPanel from './components/ReleasesPanel';",
    "import ReleasesPanel from './components/ReleasesPanel';\nimport MockupBuilderPanel from './components/MockupBuilderPanel';",
    "MockupBuilderPanel import",
)
app = replace_once(
    app,
    "const publisherTabs = ['Overview', 'Config', 'Prebid.js', 'Releases', 'Export', 'Debug', 'Ads.txt'] as const;",
    "const publisherTabs = ['Overview', 'Config', 'Prebid.js', 'Releases', 'Export', 'Mockup', 'Debug', 'Ads.txt'] as const;",
    "Mockup publisher tab",
)
app = replace_once(
    app,
    "        {activeTab === 'Export' && site ? <ExportPanel publisherId={site.id} site={site} /> : null}\n        {activeTab !== 'Overview' && activeTab !== 'Config' && activeTab !== 'Prebid.js' && activeTab !== 'Releases' && activeTab !== 'Export'",
    "        {activeTab === 'Export' && site ? <ExportPanel publisherId={site.id} site={site} /> : null}\n        {activeTab === 'Mockup' && site ? <MockupBuilderPanel publisherId={site.id} siteName={site.name} /> : null}\n        {activeTab !== 'Overview' && activeTab !== 'Config' && activeTab !== 'Prebid.js' && activeTab !== 'Releases' && activeTab !== 'Export' && activeTab !== 'Mockup'",
    "Mockup panel render",
)
app_path.write_text(app, encoding="utf-8")

main_path = Path("src/main.tsx")
main = main_path.read_text(encoding="utf-8")
main = replace_once(
    main,
    "import './export.css';",
    "import './export.css';\nimport './mockup-builder.css';",
    "Mockup builder stylesheet import",
)
main_path.write_text(main, encoding="utf-8")

print("Mockup Builder integration applied.")
