import { useState } from 'react';
import AdUnitsPanel from './AdUnitsPanel';
import AdvancedRefreshPanel from './AdvancedRefreshPanel';
import BidderBuildSelectionPanel from './BidderBuildSelectionPanel';
import BiddersPanel from './BiddersPanel';
import BulkImportPanel from './BulkImportPanel';
import GeneratorProfilesPanel from './GeneratorProfilesPanel';
import PrebidModePanel from './PrebidModePanel';
import RuntimeControlsPanel from './RuntimeControlsPanel';
import SizeMapsCompatPanel from './SizeMapsCompatPanel';
import UnitRulesPanel from './UnitRulesPanel';
import UserIdModulesPanel from './UserIdModulesPanel';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

type ConfigSection =
  | 'ad-units'
  | 'demand-mode'
  | 'bidders'
  | 'size-maps'
  | 'unit-rules'
  | 'advanced-rules'
  | 'runtime-controls'
  | 'user-id'
  | 'generator-profiles'
  | 'imports';

export default function ConfigPanel({ publisherId, onChanged }: Props) {
  const [section, setSection] = useState<ConfigSection>('ad-units');

  return (
    <div className="config-workspace">
      <nav className="config-subnav" aria-label="Configuration sections">
        <button className={section === 'ad-units' ? 'active' : ''} onClick={() => setSection('ad-units')} type="button">
          Ad units
        </button>
        <button className={section === 'demand-mode' ? 'active' : ''} onClick={() => setSection('demand-mode')} type="button">
          Demand mode
        </button>
        <button className={section === 'bidders' ? 'active' : ''} onClick={() => setSection('bidders')} type="button">
          Bidders & overrides
        </button>
        <button className={section === 'size-maps' ? 'active' : ''} onClick={() => setSection('size-maps')} type="button">
          Size maps
        </button>
        <button className={section === 'unit-rules' ? 'active' : ''} onClick={() => setSection('unit-rules')} type="button">
          Unit rules
        </button>
        <button className={section === 'advanced-rules' ? 'active' : ''} onClick={() => setSection('advanced-rules')} type="button">
          Advanced schedules
        </button>
        <button className={section === 'runtime-controls' ? 'active' : ''} onClick={() => setSection('runtime-controls')} type="button">
          Runtime controls
        </button>
        <button className={section === 'user-id' ? 'active' : ''} onClick={() => setSection('user-id')} type="button">
          User ID modules
        </button>
        <button className={section === 'generator-profiles' ? 'active' : ''} onClick={() => setSection('generator-profiles')} type="button">
          Generator profiles
        </button>
        <button className={section === 'imports' ? 'active' : ''} onClick={() => setSection('imports')} type="button">
          CSV import
        </button>
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
      {section === 'unit-rules' ? <UnitRulesPanel onChanged={onChanged} publisherId={publisherId} /> : null}
      {section === 'advanced-rules' ? <AdvancedRefreshPanel onChanged={onChanged} publisherId={publisherId} /> : null}
      {section === 'runtime-controls' ? <RuntimeControlsPanel onChanged={onChanged} publisherId={publisherId} /> : null}
      {section === 'user-id' ? <UserIdModulesPanel onChanged={onChanged} publisherId={publisherId} /> : null}
      {section === 'generator-profiles' ? <GeneratorProfilesPanel publisherId={publisherId} /> : null}
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
