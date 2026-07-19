from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if new in source:
        return source
    if old not in source:
        raise SystemExit(f'{label} anchor was not found.')
    return source.replace(old, new, 1)


panel_path = Path('src/components/ReleasesPanel.tsx')
panel = panel_path.read_text(encoding='utf-8')
panel = replace_once(
    panel,
    "import ExternalDeploymentsPanel from './ExternalDeploymentsPanel';\n",
    "import ExternalDeploymentsPanel from './ExternalDeploymentsPanel';\nimport ReleaseDiffPanel from './ReleaseDiffPanel';\n",
    'ReleasesPanel import',
)
panel = replace_once(
    panel,
    "      <ExternalDeploymentsPanel publisherId={publisherId} releases={releases} />\n",
    "      <ExternalDeploymentsPanel publisherId={publisherId} releases={releases} />\n\n      <ReleaseDiffPanel releases={releases} siteName={siteName} />\n",
    'ReleasesPanel render',
)
panel_path.write_text(panel, encoding='utf-8')

component_path = Path('src/components/ReleaseDiffPanel.tsx')
component = component_path.read_text(encoding='utf-8')
component = replace_once(
    component,
    "  const text = JSON.stringify(canonical(value));\n  return text.length > 260 ? `${text.slice(0, 257)}…` : text;\n",
    "  const text = JSON.stringify(canonical(value)) ?? String(value);\n  return text.length > 260 ? `${text.slice(0, 257)}…` : text;\n",
    'ReleaseDiffPanel display value',
)
component_path.write_text(component, encoding='utf-8')

worker_path = Path('worker/app-deploy.ts')
worker = worker_path.read_text(encoding='utf-8')
old_marker = "const RUNTIME_BUILD = '2026-07-19-global-workspaces-v16';"
new_marker = "const RUNTIME_BUILD = '2026-07-19-release-diff-v17';"
if new_marker not in worker:
    if old_marker not in worker:
        raise SystemExit('Worker runtime marker anchor was not found.')
    worker = worker.replace(old_marker, new_marker, 1)
worker_path.write_text(worker, encoding='utf-8')

print('Release Diff integrated into ReleasesPanel and runtime marker updated.')
