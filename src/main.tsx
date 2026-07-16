import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AuthAccount from './components/AuthAccount';
import './styles.css';
import './publisher-workflows.css';
import './publisher-hierarchy.css';
import './ad-units.css';
import './bidders.css';
import './imports.css';
import './size-maps.css';
import './unit-rules.css';
import './prebid-builds.css';
import './prebid-storage.css';
import './generator-profiles.css';
import './advanced-refresh.css';
import './user-id-modules.css';
import './releases.css';
import './external-deployments.css';
import './auth-account.css';
import './admin-helpers.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element was not found.');
}

createRoot(root).render(
  <StrictMode>
    <App />
    <AuthAccount />
  </StrictMode>,
);
