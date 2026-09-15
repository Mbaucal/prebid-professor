import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import BuiltinRuntimePreviewPanel, { type Settings } from '../components/BuiltinRuntimePreviewPanel';
import releases from '../../worker/runtime/runtime-releases.json';
import './ads-versions.css';

// Display values only: no publisher configuration, credentials or live API calls.
const fixture: Settings = {
  site: { id: 'ui-example', name: 'Primer sajta', domain: 'example.invalid' },
  runtime: releases[0], reviewHash: '', summary: { units: 19, bidders: 4 },
  validationIssue: null, notice: 'UI review only',
  takeOver: { enabled: false, adUnitCode: 'TakeOver', desktopMinWidth: 1024,
    desktopSize: [800, 600], mobileSize: [300, 250], autoCloseDesktopSec: 10,
    autoCloseMobileSec: 5, codelessAdUnitPath: '/123/example/Interstitial' },
};
const blocked: Settings = { ...fixture, validationIssue: 'Per-slot lazy settings in __ATF__ require the release overlay; this preview will not silently discard them.' };
function Review() {
  const [showBlocker, setShowBlocker] = useState(true);
  return <>
    <header className="review-header"><strong>Tessera · TEST</strong><a href="/">Nazad na TEST</a></header>
    <main className="review-main">
      <section className="review-intro"><h1>Pregled novog ekrana za ads.js verzije</h1>
        <p>Primer podataka, ne K1 konfiguracija. Ovde proveravamo izgled i objašnjenja: nema čuvanja, generisanja, oglasa ili objave.</p>
        <label><input type="checkbox" checked={showBlocker} onChange={event => setShowBlocker(event.target.checked)} />Prikaži primer upozorenja za lazy pravila</label>
      </section>
      <BuiltinRuntimePreviewPanel key={String(showBlocker)} publisherId="ui-example" displayFixture={showBlocker ? blocked : fixture} />
      <p className="review-footer">Otvori „Version history and earlier files“ i „Technical details“. TakeOver menja samo ovaj prikaz; osvežavanje vraća primer. Dugmad za generisanje su namerno isključena u ovom pregledu.</p>
    </main>
  </>;
}
createRoot(document.getElementById('root')!).render(<Review />);
