import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import MobileApp from './MobileApp';
import './monaco-setup';
import './theme/themeStore';
import './theme/monacoTheme';
import './index.css';
import '@xterm/xterm/css/xterm.css';
import '@vscode/codicons/dist/codicon.css';
import { bootMetrics } from './metrics';

// メトリクス収集 (サーバーの tier が権威。off なら何も入らない)。描画を待たせない。
void bootMetrics();

// /m 以下はスマホ向けの限定ページ (エージェントパネルのみ)。デスクトップ版の
// 挙動には一切影響させないため、ルーターは使わず入口でパス判定だけ行う。
const isMobilePath = window.location.pathname.replace(/\/+$/, '') === '/m';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isMobilePath ? <MobileApp /> : <App />}</React.StrictMode>,
);
