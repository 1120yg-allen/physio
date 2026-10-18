// npm run build:pages:建置「純本機版」到 docs/,供 GitHub Pages(分支 main、資料夾 /docs)發布。
// 純本機版沒有後端:資料只存在使用者瀏覽器的 IndexedDB。
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const r = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', 'docs', '--emptyOutDir'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_STATIC: '1' },
});
if (r.status !== 0) process.exit(r.status ?? 1);
writeFileSync('docs/.nojekyll', '');
console.log('\n已輸出到 docs/。提交並推送後,在 GitHub → Settings → Pages 選「Deploy from a branch」、main、/docs。');
