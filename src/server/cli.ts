// 命令列:npm run backup / npm run restore -- <備份檔>
import { SqliteRepo } from './db';
import { backupNow, listBackups, restoreBackup } from './backup';
import { dirname } from 'node:path';
import { loadConfig } from './config';
import { accessTokenProvider, clientFromEnv, createDedicatedCalendar, gcalFiles, readConfig, runAuthFlow, saveConfig } from './gcal/auth';

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
} else if (cmd === 'gcal-auth') {
  const creds = clientFromEnv();
  if (!creds) {
    console.log('請先設定環境變數 GCAL_CLIENT_ID 與 GCAL_CLIENT_SECRET(見 README「Google 行事曆」)');
    process.exit(1);
  }
  const files = gcalFiles(dirname(cfg.dbPath));
  const refresh = await runAuthFlow(creds, files, console.log);
  if (!readConfig(files)) {
    const id = await createDedicatedCalendar(accessTokenProvider(creds, refresh), '居家物治排程');
    saveConfig(files, { calendar_id: id });
    console.log('已建立專用行事曆「居家物治排程」。');
  }
  console.log('授權完成。重新啟動服務(npm start)即可開始同步。');
} else {
  console.log('用法:npm run backup | npm run restore -- <備份檔> | npm run gcal:auth');
  process.exit(1);
}
