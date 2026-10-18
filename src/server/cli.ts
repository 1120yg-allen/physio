// 命令列:npm run backup / npm run restore -- <備份檔>
import { SqliteRepo } from './db';
import { backupNow, listBackups, restoreBackup } from './backup';
import { loadConfig } from './config';

const cfg = loadConfig();
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'backup') {
  const repo = new SqliteRepo(cfg.dbPath);
  console.log(`備份完成:${backupNow(repo, cfg.backupDir)}`);
  repo.close();
} else if (cmd === 'restore') {
  if (!arg) {
    console.log('用法:npm run restore -- <備份檔路徑>\n\n可用備份:');
    for (const f of listBackups(cfg.backupDir)) console.log(`  ${cfg.backupDir}/${f}`);
    process.exit(1);
  }
  const kept = restoreBackup(arg, cfg.dbPath);
  console.log(`還原完成。${kept ? `原資料庫已保留為:${kept}` : ''}`);
} else {
  console.log('用法:npm run backup | npm run restore -- <備份檔>');
  process.exit(1);
}
