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
import { MetricsProfiler } from './metrics/react';
import { initLsp } from './lsp';

// メトリクス収集 (サーバーの tier が権威。off なら何も入らない)。描画を待たせない。
void bootMetrics();

// /m 以下はスマホ向けの限定ページ (エージェントパネルのみ)。デスクトップ版の
// 挙動には一切影響させないため、ルーターは使わず入口でパス判定だけ行う。
const isMobilePath = window.location.pathname.replace(/\/+$/, '') === '/m';

// LSP の有効/無効は最初の TypeScript モデルが生まれる前 (= 描画前) に決める必要がある (client/src/lsp/index.ts)。
// 失敗時は builtin に落ちるので描画は必ず進む。
void initLsp().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <MetricsProfiler>{isMobilePath ? <MobileApp /> : <App />}</MetricsProfiler>
    </React.StrictMode>,
  );
});
