// UI レンダラーの入口。sandbox・contextIsolation の中で動き、Node.js・Electron の API を使わない。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('root_missing');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
