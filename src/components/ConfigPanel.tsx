import { useState } from 'react';
import AdUnitsPanel from './AdUnitsPanel';
import AdvancedRefreshPanel from './AdvancedRefreshPanel';
import BidderBuildSelectionPanel from './BidderBuildSelectionPanel';
import BiddersPanel from './BiddersPanel';
import BulkImportPanel from './BulkImportPanel';
import GeneratorProfilesPanel from './GeneratorProfilesPanel';
import LegacyGeneratorProfilesPanel from './LegacyGeneratorProfilesPanel';
import PrebidModePanel from './PrebidModePanel';
import RuntimeControlsPanel from './RuntimeControlsPanel';
import SizeMapsCompatPanel from './SizeMapsCompatPanel';
import SupplyChainConsentPanel from './SupplyChainConsentPanel';
import UnitRulesPanel from './UnitRulesPanel';
import UserIdModulesPanel from './UserIdModulesPanel';

type Props = {
  publisherId: string;
  onOpenPrebid?: () => void;
  onGenerate?: () => void;
  onChanged?: () => void | Promise<void>;
  initialSection?: ConfigSection;
};

type ConfigSection =
  | 'ad-units'
  | 'demand-mode'
  | 'bidders'
  | 'size-maps'
  | 'unit-rules'
  | 'advanced-rules'
  | 'runtime-controls'
  | 'supply-consent'
  | 'user-id'
  | 'generator-profiles'
  | 'legacy-profiles'
  | 'imports';

const CONFIG_GROUPS: Array<{
  label: string;
  sections: Array<{ id: ConfigSection; label: string }>;
}> = [
  { label: 'Script', sections: [{ id: 'generator-profiles', label: 'Script setup' }] },
  { label: 'Inventory', sections: [
    { id: 'ad-units', label: 'Ad units' },
    { id: 'size-maps', label: 'Size maps' },
  ] },
  { label: 'Demand', sections: [
    { id: 'demand-mode', label: 'Prebid' },
    { id: 'bidders', label: 'Bidders' },
    { id: 'supply-consent', label: 'Supply & consent' },
    { id: 'user-id', label: 'User ID modules' },
  ] },
  { label: 'Delivery', sections: [
    { id: 'advanced-rules', label: 'Refresh' },
    { id: 'runtime-controls', label: 'Sticky & floors' },
  ] },
  { label: 'Advanced', sections: [
    { id: 'unit-rules', label: 'Unit rules' },
    { id: 'imports', label: 'CSV import' },
    { id: 'legacy-profiles', label: 'Imported templates' },
  ] },
];

export default function ConfigPanel({ publisherId, onChanged, onOpenPrebid, onGenerate, initialSection = 'generator-profiles' }: Props) {
  const [section, setSection] = useState<ConfigSection>(initialSection);
  const group = CONFIG_GROUPS.find((item) => item.sections.some((child) => child.id === section))!;

  return (
    <div className="config-workspace">
      <nav className="config-groups" aria-label="Configuration groups">
        {CONFIG_GROUPS.map((item) => (
          <button key={item.label} type="button" aria-pressed={group === item}
            className={group === item ? 'active' : ''}
            onClick={() => { if (group !== item) setSection(item.sections[0].id); }}>
            {item.label}
          </button>
        ))}
      </nav>
      <nav className="config-subnav" aria-label={`${group.label} settings`}>
        {group.sections.map((item) => (
          <button key={item.id} type="button" aria-pressed={section === item.id}
            className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>

      {section === 'ad-units' ? <AdUnitsPanel onChanged={onChanged} publisherId={publisherId} /> : null}
      {section === 'demand-mode' ? <PrebidModePanel onChanged={onChanged} publisherId={publisherId} /> : null}
      {section === 'bidders' ? (
        <>
          <BidderBuildSelectionPanel onChanged={onChanged} publisherId={publisherId} />
          <BiddersPanel onChanged={onChanged} publisherId={publisherId} />
        </>
      ) : null}
      {section === 'size-maps' ? <SizeMapsCompatPanel onChanged={onChanged} publisherId={publisherId} /> : null}
      {section === 'unit-rules' ? <UnitRulesPanel onOpenRefresh={() => setSection('advanced-rules')} onChanged={onChanged} publisherId={publisherId} /> : null}
      {section === 'advanced-rules' ? <AdvancedRefreshPanel onOpenUnitRules={() => setSection('unit-rules')} onChanged={onChanged} publisherId={publisherId} /> : null}
      {section === 'runtime-controls' ? <RuntimeControlsPanel onChanged={onChanged} publisherId={publisherId} /> : null}
      {section === 'supply-consent' ? <SupplyChainConsentPanel onChanged={onChanged} publisherId={publisherId} /> : null}
      {section === 'user-id' ? <UserIdModulesPanel onChanged={onChanged} publisherId={publisherId} /> : null}
      {section === 'generator-profiles' ? <GeneratorProfilesPanel publisherId={publisherId} onOpenPrebid={onOpenPrebid} onChanged={onChanged} onContinue={onGenerate} /> : null}
      {section === 'legacy-profiles' ? <LegacyGeneratorProfilesPanel key={publisherId} publisherId={publisherId} /> : null}
      {section === 'imports' ? (
        <>
          <div className="size-map-import-compat-note">
            <strong>Size-map CSV:</strong>
            <span>Use <code>fluid</code> as a size. Leave the <code>sizes</code> cell empty to store <code>[]</code> and disable the slot at that breakpoint.</span>
          </div>
          <BulkImportPanel onChanged={onChanged} publisherId={publisherId} />
        </>
      ) : null}
    </div>
  );
}
