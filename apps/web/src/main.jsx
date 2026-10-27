import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PlatformApp } from './app/PlatformApp.jsx';
import './styles.css';

// The active organisation is supplied by the session. `VITE_ORGANISATION_ID`
// exists so a local stack can run before an account surface resolves it.
const organisationId = import.meta.env?.VITE_ORGANISATION_ID ?? null;

const container = document.getElementById('root');
createRoot(container).render(
  <StrictMode>
    <PlatformApp organisationId={organisationId} />
  </StrictMode>,
);
