import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './monaco-setup';
import './theme/themeStore';
import './theme/monacoTheme';
import './index.css';
import '@xterm/xterm/css/xterm.css';
import '@vscode/codicons/dist/codicon.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
