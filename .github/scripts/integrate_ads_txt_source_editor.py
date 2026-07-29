from pathlib import Path
import re


BRANCH = "feature/ads-txt-source-editor-v1"


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    if new in source:
        print(f"{label}: already applied")
        return
    if old not in source:
        raise SystemExit(f"{label} anchor was not found in {path}.")
    file_path.write_text(source.replace(old, new, 1), encoding="utf-8")
    print(f"{label}: applied")


def replace_regex(path: str, pattern: str, replacement: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, source, count=1, flags=re.S)
    if count == 0:
        if replacement.strip() and replacement.strip() in source:
            print(f"{label}: already applied")
            return
        raise SystemExit(f"{label} pattern was not found in {path}.")
    file_path.write_text(updated, encoding="utf-8")
    print(f"{label}: applied")


def remove_regex(path: str, pattern: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, "\n", source, count=1, flags=re.S)
    if count == 0:
        print(f"{label}: already removed")
        return
    file_path.write_text(updated, encoding="utf-8")
    print(f"{label}: removed")


def require(path: str, *needles: str) -> None:
    source = Path(path).read_text(encoding="utf-8")
    missing = [needle for needle in needles if needle not in source]
    if missing:
        raise SystemExit(f"Integration validation failed in {path}: {missing}")


def forbid(path: str, *needles: str) -> None:
    source = Path(path).read_text(encoding="utf-8")
    found = [needle for needle in needles if needle in source]
    if found:
        raise SystemExit(f"Integration validation found forbidden content in {path}: {found}")


# Worker routes and build marker.
replace_once(
    "worker/app-deploy.ts",
    "import { copyAdsTxtRequirementsLarge, importAdsTxtRequirementsLarge } from './ads-txt-bulk';\n",
    "import { copyAdsTxtRequirementsLarge, importAdsTxtRequirementsLarge } from './ads-txt-bulk';\n"
    "import {\n"
    "  addAdsTxtSourceLine,\n"
    "  deleteAdsTxtSourceLine,\n"
    "  getAdsTxtSource,\n"
    "  resetAdsTxtSourceDraft,\n"
    "  syncAdsTxtSource,\n"
    "  updateAdsTxtSourceLine,\n"
    "} from './ads-txt-source';\n",
    "ads.txt source imports",
)
replace_once(
    "worker/app-deploy.ts",
    "const RUNTIME_BUILD = '2026-07-29-ads-txt-combined-search-v33';",
    "const RUNTIME_BUILD = '2026-07-29-ads-txt-source-editor-v34';",
    "ads.txt source build marker",
)
replace_once(
    "worker/app-deploy.ts",
    "    const adsTxtCheckMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/ads-txt\\/check$/);\n",
    "    const adsTxtSourceLineMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/ads-txt\\/source\\/lines\\/(\\d+)$/);\n"
    "    if (adsTxtSourceLineMatch) {\n"
    "      const verified = await authenticatedRequest(request, env);\n"
    "      if (verified instanceof Response) return withBuildHeader(verified);\n"
    "      const siteId = decodeURIComponent(adsTxtSourceLineMatch[1]);\n"
    "      const lineIndex = Number(adsTxtSourceLineMatch[2]);\n"
    "      if (request.method === 'PATCH') {\n"
    "        return withBuildHeader(await updateAdsTxtSourceLine(verified, env, siteId, lineIndex));\n"
    "      }\n"
    "      if (request.method === 'DELETE') {\n"
    "        return withBuildHeader(await deleteAdsTxtSourceLine(verified, env, siteId, lineIndex));\n"
    "      }\n"
    "      return withBuildHeader(apiError('Method not allowed.', 405));\n"
    "    }\n\n"
    "    const adsTxtSourceSyncMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/ads-txt\\/source\\/sync$/);\n"
    "    if (adsTxtSourceSyncMatch) {\n"
    "      const verified = await authenticatedRequest(request, env);\n"
    "      if (verified instanceof Response) return withBuildHeader(verified);\n"
    "      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));\n"
    "      return withBuildHeader(await syncAdsTxtSource(verified, env, decodeURIComponent(adsTxtSourceSyncMatch[1])));\n"
    "    }\n\n"
    "    const adsTxtSourceResetMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/ads-txt\\/source\\/reset$/);\n"
    "    if (adsTxtSourceResetMatch) {\n"
    "      const verified = await authenticatedRequest(request, env);\n"
    "      if (verified instanceof Response) return withBuildHeader(verified);\n"
    "      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));\n"
    "      return withBuildHeader(await resetAdsTxtSourceDraft(verified, env, decodeURIComponent(adsTxtSourceResetMatch[1])));\n"
    "    }\n\n"
    "    const adsTxtSourceCollectionMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/ads-txt\\/source$/);\n"
    "    if (adsTxtSourceCollectionMatch) {\n"
    "      const verified = await authenticatedRequest(request, env);\n"
    "      if (verified instanceof Response) return withBuildHeader(verified);\n"
    "      const siteId = decodeURIComponent(adsTxtSourceCollectionMatch[1]);\n"
    "      if (request.method === 'GET') return withBuildHeader(await getAdsTxtSource(env, siteId));\n"
    "      return withBuildHeader(apiError('Method not allowed.', 405));\n"
    "    }\n\n"
    "    const adsTxtSourceLinesMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/ads-txt\\/source\\/lines$/);\n"
    "    if (adsTxtSourceLinesMatch) {\n"
    "      const verified = await authenticatedRequest(request, env);\n"
    "      if (verified instanceof Response) return withBuildHeader(verified);\n"
    "      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));\n"
    "      return withBuildHeader(await addAdsTxtSourceLine(verified, env, decodeURIComponent(adsTxtSourceLinesMatch[1])));\n"
    "    }\n\n"
    "    const adsTxtCheckMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/ads-txt\\/check$/);\n",
    "ads.txt source routes",
)

# Ads.txt workspace integration.
replace_once(
    "src/components/AdsTxtPanel.tsx",
    "import { api } from '../api';\n",
    "import { api } from '../api';\nimport AdsTxtSourceEditor from './AdsTxtSourceEditor';\n",
    "source editor component import",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    "  const [showDuplicates, setShowDuplicates] = useState(false);\n",
    "  const [showDuplicates, setShowDuplicates] = useState(false);\n"
    "  const [sourceSearchRequest, setSourceSearchRequest] = useState({ query: '', requestId: 0 });\n",
    "source editor search state",
)
remove_regex(
    "src/components/AdsTxtPanel.tsx",
    r"\n  const liveSearchMatches = useMemo\(\(\) => \{.*?\n  \}, \[check, searchQuery\]\);\n",
    "legacy combined live search calculation",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    "  function findSavedRequirement(duplicateEntry: string): void {\n"
    "    setSearchQuery(duplicateEntry);\n"
    "    window.requestAnimationFrame(() => {\n"
    "      document.getElementById('ads-txt-saved-requirements')?.scrollIntoView({ behavior: 'smooth', block: 'start' });\n"
    "    });\n"
    "  }\n",
    "  function openSourceEditorSearch(duplicateEntry: string): void {\n"
    "    setSourceSearchRequest((current) => ({ query: duplicateEntry, requestId: current.requestId + 1 }));\n"
    "    window.requestAnimationFrame(() => {\n"
    "      document.getElementById('ads-txt-source-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });\n"
    "    });\n"
    "  }\n",
    "source editor search launcher",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    "      </article>\n\n      <article className={`ads-txt-result-card ${check?.status ?? 'unchecked'}`}>\n",
    "      </article>\n\n"
    "      <AdsTxtSourceEditor requestedSearch={sourceSearchRequest} site={site} />\n\n"
    "      <article className={`ads-txt-result-card ${check?.status ?? 'unchecked'}`}>\n",
    "source editor render",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    "            <p>Each card is a different canonical ads.txt record that appears more than once in the live publisher file. Use the button to show every matching live occurrence together with the saved requirement below. Tessera remains read-only.</p>\n",
    "            <p>Each card is a canonical record that appears more than once in the live publisher file. Open it in the managed source editor to edit or delete either physical occurrence independently in the Tessera draft.</p>\n",
    "repeated entry explanation",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    "                    <button className=\"button secondary\" onClick={() => findSavedRequirement(duplicate.entry)} type=\"button\">Show all matches in search</button>\n",
    "                    <button className=\"button secondary\" onClick={() => openSourceEditorSearch(duplicate.entry)} type=\"button\">Edit repeated source lines</button>\n",
    "repeated entry source editor action",
)
replace_regex(
    "src/components/AdsTxtPanel.tsx",
    r"<span className=\"panel-kicker\">Ads\.txt search</span>\n\s*<h3>\n\s*\{searchQuery\.trim\(\)\n\s*\? `\$\{liveSearchMatches\.length\} live match\$\{liveSearchMatches\.length === 1 \? '' : 'es'\} · \$\{filteredRequirements\.length\} saved`\n\s*: `\$\{requirements\.length\} entr\$\{requirements\.length === 1 \? 'y' : 'ies'\}`\}\n\s*</h3>",
    "<span className=\"panel-kicker\">Monitoring requirements</span>\n            <h3>{searchQuery.trim() ? `${filteredRequirements.length} of ${requirements.length} entries` : `${requirements.length} entr${requirements.length === 1 ? 'y' : 'ies'}`}</h3>",
    "monitoring requirement heading",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    "                aria-label=\"Search saved and repeated live ads.txt entries\"\n",
    "                aria-label=\"Search canonical monitoring requirements\"\n",
    "monitoring search aria label",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    "                placeholder=\"Search source, domain, seller ID, comment or complete line…\"\n",
    "                placeholder=\"Search canonical monitoring requirements…\"\n",
    "monitoring search placeholder",
)
remove_regex(
    "src/components/AdsTxtPanel.tsx",
    r"\n\s*\{searchQuery\.trim\(\) && liveSearchMatches\.length \? \(\n\s*<div className=\"ads-txt-live-search-panel\">.*?\n\s*\) : null\}\n",
    "legacy combined live search panel",
)

# CSS import.
replace_once(
    "src/main.tsx",
    "import './ads-txt.css';\n",
    "import './ads-txt.css';\nimport './ads-txt-source-editor.css';\n",
    "source editor css import",
)

# Durable project record for the stacked feature branch.
replace_once(
    "PROJECT.md",
    "| Current development branch | `feature/monitoring-readonly-v1` |",
    "| Current development branch | `feature/ads-txt-source-editor-v1` (stacked on `feature/monitoring-readonly-v1`) |",
    "project branch marker",
)
replace_once(
    "PROJECT.md",
    "| Managed raw ads.txt source editor with per-occurrence Edit/Delete | Product requirement confirmed; not implemented |",
    "| Managed raw ads.txt source editor with per-occurrence Edit/Delete | Staged on `feature/ads-txt-source-editor-v1` |",
    "source editor module status",
)
replace_once(
    "PROJECT.md",
    "Confirm the publishing mode for the managed ads.txt source editor: Tessera draft plus Download/Copy export, or direct publication through an authenticated publisher integration. Do not merge the current Ads.txt workspace UX as the final source-management experience.",
    "Test the managed ads.txt working copy on the stacked source-editor preview: sync from live, search both repeated physical occurrences, edit or delete one occurrence, verify the other remains, then Copy/Download the complete new ads.txt. Direct CMS publication remains a later connector phase.",
    "project next action",
)
replace_once(
    "PROJECT.md",
    "- Confirmed that direct live changes require an explicit authenticated publishing mechanism; otherwise changes remain a Tessera draft/export.\n",
    "- Confirmed that direct live changes require an explicit authenticated publishing mechanism; otherwise changes remain a Tessera draft/export.\n"
    "- Started the managed raw ads.txt source editor on a separate stacked feature branch so Monitoring PR #19 remains isolated.\n",
    "source editor decision log",
)

require(
    "worker/app-deploy.ts",
    "from './ads-txt-source'",
    "2026-07-29-ads-txt-source-editor-v34",
    "ads-txt/source/sync",
    "ads-txt/source/lines",
)
require(
    "src/components/AdsTxtPanel.tsx",
    "from './AdsTxtSourceEditor'",
    "<AdsTxtSourceEditor",
    "Edit repeated source lines",
    "Monitoring requirements",
)
forbid(
    "src/components/AdsTxtPanel.tsx",
    "liveSearchMatches",
    "LIVE FILE · READ ONLY",
)
require(
    "src/main.tsx",
    "import './ads-txt-source-editor.css';",
)
require(
    "PROJECT.md",
    BRANCH,
    "Staged on `feature/ads-txt-source-editor-v1`",
)
print("Managed ads.txt source editor integration validation passed.")
