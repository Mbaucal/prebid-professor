import { useState } from 'react';
import AdUnitsPanel from './AdUnitsPanel';
import BiddersPanel from './BiddersPanel';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

type ConfigSection = 'ad-units' | 'bidders';

export default function ConfigPanel({ publisherId, onChanged }: Props) {
  const [section, setSection] = useState<ConfigSection>('ad-units');

  return (
    <div className="config-workspace">
      <nav className="config-subnav" aria-label="Configuration sections">
        <button
          className={section === 'ad-units' ? 'active' : ''}
          onClick={() => setSection('ad-units')}
          type="button"
        >
          Ad units
        </button>
        <button
          className={section === 'bidders' ? 'active' : ''}
          onClick={() => setSection('bidders')}
          type="button"
        >
          Bidders & overrides
        </button>
        <button disabled title="Size map editor is the next config module." type="button">
          Size maps
        </button>
        <button disabled title="Unit rule editor is the next config module." type="button">
          Unit rules
        </button>
      </nav>

      {section === 'ad-units' ? (
        <AdUnitsPanel onChanged={onChanged} publisherId={publisherId} />
      ) : (
        <BiddersPanel onChanged={onChanged} publisherId={publisherId} />
      )}
    </div>
  );
}
