import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AuthAccount from './components/AuthAccount';
import TesseraBranding from './components/TesseraBranding';
import './styles.css';
import './publisher-workflows.css';
import './publisher-hierarchy.css';
import './ad-units.css';
import './bidders.css';
import './bidder-build-selection.css';
import './imports.css';
import './size-maps.css';
import './size-maps-compat.css';
import './unit-rules.css';
import './prebid-builds.css';
import './prebid-storage.css';
import './generator-profiles.css';
import './advanced-refresh.css';
import './runtime-controls.css';
import './supply-chain-consent.css';
import './user-id-modules.css';
import './prebid-mode.css';
import './releases.css';
import './release-diff.css';
import './release-deletion.css';
import './external-deployments.css';
import './export.css';
import './mockup-builder.css';
import './debug-console.css';
import './ads-txt.css';
import './global-workspaces.css';
import './tessera-branding.css';
import './auth-account.css';
import './admin-helpers.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element was not found.');
}

createRoot(root).render(
  <StrictMode>
    <TesseraBranding />
    <App />
    <AuthAccount />
  </StrictMode>,
);
