import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

// Tauri 开发时用固定端口；两个页面：猫咪窗口（index.html）和设置窗口（settings.html）
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // 猫咪页面包含 Three.js 3D 引擎（约 600KB，本地打包、不联网），属于正常体积
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        pet: resolve(__dirname, 'index.html'),
        settings: resolve(__dirname, 'settings.html'),
        statistics: resolve(__dirname, 'statistics.html'),
      },
    },
  },
});
