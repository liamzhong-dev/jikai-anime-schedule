import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { getState, load } from './core/store.js';
import { applyTheme } from './theme/applyTheme.js';
import './styles.css';

load().then(() => {
  // 首屏渲染前先把主题变量写上，免得浅色主题下闪一下深色底
  const st = getState();
  applyTheme(st.settings.theme, {
    wallpaper: st.settings.wallpaper,
    panelAlpha: st.settings.panelAlpha,
  });

  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
