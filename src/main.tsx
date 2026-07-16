import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
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

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element was not found.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
