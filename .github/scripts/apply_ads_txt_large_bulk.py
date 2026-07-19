from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if new in source:
        return source
    if old not in source:
        raise SystemExit(f'{label} anchor was not found.')
    return source.replace(old, new, 1)


app_path = Path('worker/app-deploy.ts')
app = app_path.read_text(encoding='utf-8')
app = replace_once(
    app,
    "  copyAdsTxtRequirements,\n  deleteAdsTxtRequirement,\n  importAdsTxtRequirements,\n",
    "  deleteAdsTxtRequirement,\n",
    'app-deploy legacy bulk imports',
)
app = replace_once(
    app,
    "import { createAdsTxtRequirementFlexible } from './ads-txt-flexible';\n",
    "import { createAdsTxtRequirementFlexible } from './ads-txt-flexible';\nimport { copyAdsTxtRequirementsLarge, importAdsTxtRequirementsLarge } from './ads-txt-bulk';\n",
    'app-deploy bulk import',
)
app = replace_once(
    app,
    "const RUNTIME_BUILD = '2026-07-19-debug-console-v14';",
    "const RUNTIME_BUILD = '2026-07-19-ads-txt-large-bulk-v15';",
    'runtime build marker',
)
app = replace_once(
    app,
    'await importAdsTxtRequirements(\n',
    'await importAdsTxtRequirementsLarge(\n',
    'large import route',
)
app = replace_once(
    app,
    'await copyAdsTxtRequirements(\n',
    'await copyAdsTxtRequirementsLarge(\n',
    'large copy route',
)
app_path.write_text(app, encoding='utf-8')

panel_path = Path('src/components/AdsTxtPanel.tsx')
panel = panel_path.read_text(encoding='utf-8')
panel = replace_once(
    panel,
    "type ApiFailure = {\n  error?: string;\n  details?: unknown;\n};\n",
    "type ApiFailure = {\n  error?: string;\n  details?: unknown;\n};\n\nconst MAX_BULK_ENTRIES = 5_000;\n",
    'frontend bulk constant',
)
panel = replace_once(
    panel,
    "      if (parsed.length > 100) throw new Error('Import at most 100 rows at once.');",
    "      if (parsed.length > MAX_BULK_ENTRIES) {\n        throw new Error(`Import at most ${MAX_BULK_ENTRIES.toLocaleString('en-US')} rows at once.`);\n      }",
    'frontend file import limit',
)
panel = panel.replace(
    'Maximum 100 entries at once.',
    'Maximum 5,000 entries at once.',
)
panel_path.write_text(panel, encoding='utf-8')

print('Ads.txt large bulk integration applied.')
