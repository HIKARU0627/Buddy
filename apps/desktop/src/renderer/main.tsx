// UI レンダラーの入口。sandbox・contextIsolation の中で動き、Node.js・Electron の API を使わない。
// HeroUI のスタイルは styles.css からビルド時に CSS ファイルへ出す（ADR 0024）。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { AppProviders } from './app/AppProviders.js';
import { followSystemColorScheme } from './app/theme.js';
import './styles.css';

followSystemColorScheme(
  document.documentElement,
  window.matchMedia('(prefers-color-scheme: dark)'),
);

const container = document.getElementById('root');
if (container === null) throw new Error('root_missing');
createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>,
);
