import { useState } from 'react';
import SiteRuntimePanel from './SiteRuntimePanel';
import LegacyGeneratorProfilesPanel from './LegacyGeneratorProfilesPanel';
export default function GeneratorProfilesPanel({ publisherId, onOpenPrebid }: { publisherId: string; onOpenPrebid?: () => void }) {
  const [legacyOpen, setLegacyOpen] = useState(false);
  return <div className="builtin-runtime-workspace">
    <SiteRuntimePanel key={publisherId} publisherId={publisherId} view="versions" onOpenPrebid={onOpenPrebid} />
    <details onToggle={(event) => setLegacyOpen(event.currentTarget.open)}>
      <summary>Advanced: older template profiles</summary>
      {legacyOpen ? <LegacyGeneratorProfilesPanel key={publisherId} publisherId={publisherId} /> : null}
    </details>
  </div>;
}
