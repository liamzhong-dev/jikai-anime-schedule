import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base 用相对路径，这样 Electron 直接 file:// 加载 dist 也能跑
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
