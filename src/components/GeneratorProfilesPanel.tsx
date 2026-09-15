import { useState } from 'react';
import SiteRuntimePanel from './SiteRuntimePanel';
import LegacyGeneratorProfilesPanel from './LegacyGeneratorProfilesPanel';
export default function GeneratorProfilesPanel({ publisherId }: { publisherId: string }) {
  const [legacyOpen, setLegacyOpen] = useState(false);
  return <div className="builtin-runtime-workspace">
    <SiteRuntimePanel key={publisherId} publisherId={publisherId} view="versions" />
    <details onToggle={(event) => setLegacyOpen(event.currentTarget.open)}>
      <summary>Advanced: older template profiles</summary>
      {legacyOpen ? <LegacyGeneratorProfilesPanel key={publisherId} publisherId={publisherId} /> : null}
    </details>
  </div>;
}
