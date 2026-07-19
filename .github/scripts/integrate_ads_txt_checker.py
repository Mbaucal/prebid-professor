from pathlib import Path


path = Path('src/App.tsx')
source = path.read_text(encoding='utf-8')

import_line = "import AdsTxtPanel from './components/AdsTxtPanel';\n"
import_anchor = "import ConfigPanel from './components/ConfigPanel';\n"
if import_line not in source:
    if import_anchor not in source:
        raise SystemExit('App AdsTxtPanel import anchor was not found.')
    source = source.replace(import_anchor, import_line + import_anchor, 1)

mockup_render = "        {activeTab === 'Mockup' && site ? <MockupBuilderPanel publisherId={site.id} siteName={site.name} /> : null}\n"
ads_render = "        {activeTab === 'Ads.txt' && site ? (\n          <AdsTxtPanel onChanged={() => loadHierarchy(publisher?.id, site.id)} site={site} />\n        ) : null}\n"
if ads_render not in source:
    if mockup_render not in source:
        raise SystemExit('App Mockup render anchor was not found.')
    source = source.replace(mockup_render, mockup_render + ads_render, 1)

old_condition = "        {activeTab !== 'Overview' && activeTab !== 'Config' && activeTab !== 'Prebid.js' && activeTab !== 'Releases' && activeTab !== 'Export' && activeTab !== 'Mockup'\n"
new_condition = "        {activeTab !== 'Overview' && activeTab !== 'Config' && activeTab !== 'Prebid.js' && activeTab !== 'Releases' && activeTab !== 'Export' && activeTab !== 'Mockup' && activeTab !== 'Ads.txt'\n"
if new_condition not in source:
    if old_condition not in source:
        raise SystemExit('App placeholder exclusion anchor was not found.')
    source = source.replace(old_condition, new_condition, 1)

path.write_text(source, encoding='utf-8')
print('Ads.txt checker integrated into App.tsx.')
