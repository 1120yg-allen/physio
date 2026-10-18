// npm start:檢查 Node 版本 → 必要時自動建置前端 → 啟動服務。
// 目的:讓第一次使用的人不會因為漏掉建置步驟而打不開網頁。
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

/** Node.js 版本是否滿足 node:sqlite 需求(22.13 以上) */
export function nodeOk(version = process.versions.node) {
  const [maj = 0, min = 0] = version.split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 13);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!nodeOk()) {
    console.error(`\n✗ 需要 Node.js 22.13 以上,目前是 v${process.versions.node}。\n  請到 https://nodejs.org 安裝 LTS 版本後重新執行。\n`);
    process.exit(1);
  }
  if (!existsSync('node_modules/vite') || !existsSync('node_modules/tsx')) {
    console.error('\n✗ 尚未安裝相依套件。請先執行:npm install\n');
    process.exit(1);
  }
  if (!existsSync('dist/index.html')) {
    console.log('第一次啟動,正在建置前端(約需 10 秒)…');
    const r = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error('\n✗ 前端建置失敗,請把上方錯誤訊息提供給開發者。\n');
      process.exit(1);
    }
  }
  const port = process.env.PORT ?? '8787';
  const host = process.env.HOST ?? '127.0.0.1';
  console.log(`\n啟動後請用瀏覽器開啟:http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}\n(關閉請在此視窗按 Ctrl+C)\n`);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/server/index.ts'], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}
