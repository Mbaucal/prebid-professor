import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AdsTxtCmsConnectionPortal from './components/AdsTxtCmsConnectionPortal';
import AdsTxtManagedFilePortal from './components/AdsTxtManagedFilePortal';
import AdsTxtRequirementsCollapse from './components/AdsTxtRequirementsCollapse';
import TesseraBranding from './components/TesseraBranding';
import './dashboard-styles';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element was not found.');
}

createRoot(root).render(
  <StrictMode>
    <TesseraBranding />
    <App />
    <AdsTxtRequirementsCollapse />
    <AdsTxtManagedFilePortal />
    <AdsTxtCmsConnectionPortal />
  </StrictMode>,
);
