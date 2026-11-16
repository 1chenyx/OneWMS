import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import App from './App.js';
import './field.css';
import { FieldSessionProvider } from './session.js';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FieldSessionProvider>
      <App />
    </FieldSessionProvider>
  </React.StrictMode>,
);
