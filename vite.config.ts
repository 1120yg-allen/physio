import { defineConfig, type Plugin } from 'vite';

/** 根目錄的 index.html 內含「在 GitHub Pages 上導向 ./docs/」的開發用片語,建置輸出不需要 */
const stripDevRedirect: Plugin = {
  name: 'strip-dev-redirect',
  transformIndexHtml: (html) => html.replace(/<!--dev-redirect-->[\s\S]*?<!--\/dev-redirect-->\s*/g, ''),
};

export default defineConfig({
  // 相對路徑:同一份建置可放在網站根目錄(npm start)或子路徑(GitHub Pages 的 /physio/)
  base: './',
  plugins: [stripDevRedirect],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  build: { outDir: 'dist', target: 'es2022' },
});
