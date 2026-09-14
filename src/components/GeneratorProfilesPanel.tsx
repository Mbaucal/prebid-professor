import { useState } from 'react';
import BuiltinRuntimePreviewPanel from './BuiltinRuntimePreviewPanel';
import BuiltinPrebidCheckPanel from './BuiltinPrebidCheckPanel';
import LegacyGeneratorProfilesPanel from './LegacyGeneratorProfilesPanel';
export default function GeneratorProfilesPanel({ publisherId }: { publisherId: string }) {
  const [legacyOpen, setLegacyOpen] = useState(false);
  return <div className="builtin-runtime-workspace">
    <BuiltinRuntimePreviewPanel key={publisherId} publisherId={publisherId} />
    <BuiltinPrebidCheckPanel key={`prebid-${publisherId}`} publisherId={publisherId} />
    <details onToggle={(event) => setLegacyOpen(event.currentTarget.open)}>
      <summary>Advanced: older template profiles</summary>
      {legacyOpen ? <LegacyGeneratorProfilesPanel key={publisherId} publisherId={publisherId} /> : null}
    </details>
  </div>;
}
