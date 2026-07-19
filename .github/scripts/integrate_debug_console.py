from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if new in source:
        return source
    if old not in source:
        raise SystemExit(f'{label} anchor was not found.')
    return source.replace(old, new, 1)


app_path = Path('src/App.tsx')
app = app_path.read_text(encoding='utf-8')
app = replace_once(
    app,
    "import AdsTxtPanel from './components/AdsTxtPanel';\n",
    "import AdsTxtPanel from './components/AdsTxtPanel';\nimport DebugConsolePanel from './components/DebugConsolePanel';\n",
    'DebugConsolePanel import',
)
app = replace_once(
    app,
    "        {activeTab === 'Mockup' && site ? <MockupBuilderPanel publisherId={site.id} siteName={site.name} /> : null}\n",
    "        {activeTab === 'Mockup' && site ? <MockupBuilderPanel publisherId={site.id} siteName={site.name} /> : null}\n"
    "        {activeTab === 'Debug' && site ? (\n"
    "          <DebugConsolePanel domain={site.domain} publisherId={site.id} siteName={site.name} />\n"
    "        ) : null}\n",
    'Debug tab render',
)
app = replace_once(
    app,
    "        {activeTab !== 'Overview' && activeTab !== 'Config' && activeTab !== 'Prebid.js' && activeTab !== 'Releases' && activeTab !== 'Export' && activeTab !== 'Mockup' && activeTab !== 'Ads.txt'\n",
    "        {activeTab !== 'Overview' && activeTab !== 'Config' && activeTab !== 'Prebid.js' && activeTab !== 'Releases' && activeTab !== 'Export' && activeTab !== 'Mockup' && activeTab !== 'Debug' && activeTab !== 'Ads.txt'\n",
    'Debug placeholder exclusion',
)
app_path.write_text(app, encoding='utf-8')

main_path = Path('src/main.tsx')
main = main_path.read_text(encoding='utf-8')
main = replace_once(
    main,
    "import './mockup-builder.css';\n",
    "import './mockup-builder.css';\nimport './debug-console.css';\n",
    'Debug Console stylesheet import',
)
main_path.write_text(main, encoding='utf-8')

worker_path = Path('worker/app-deploy.ts')
worker = worker_path.read_text(encoding='utf-8')
worker = replace_once(
    worker,
    "const RUNTIME_BUILD = '2026-07-19-ads-txt-multiline-v13';",
    "const RUNTIME_BUILD = '2026-07-19-debug-console-v14';",
    'Debug Console runtime build marker',
)
worker_path.write_text(worker, encoding='utf-8')

print('Debug Console integrated into App, main stylesheet imports and Worker build marker.')
