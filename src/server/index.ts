import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './app';
import { startDailyBackup } from './backup';
import { loadConfig } from './config';
import { SqliteRepo } from './db';
import { createGcalService } from './gcal/service';

const cfg = loadConfig();
mkdirSync(dirname(cfg.dbPath), { recursive: true });
const repo = new SqliteRepo(cfg.dbPath);

startDailyBackup(repo, cfg.backupDir, (p) => console.log(`已完成每日備份:${p}`));

const gcal = createGcalService(repo, dirname(cfg.dbPath));
gcal.start();
const gs = gcal.status();
console.log(gs.enabled ? `Google 行事曆同步:已啟用(隱私等級 ${gs.privacy})` : `Google 行事曆同步:未啟用(${gs.reason ?? ''})`);

createApp(repo, cfg.staticDir, gcal).listen(cfg.port, cfg.host, () => {
  console.log(`居家物理治療系統已啟動:http://${cfg.host}:${cfg.port}`);
  console.log(`資料庫:${cfg.dbPath}`);
  console.log(`備份目錄:${cfg.backupDir}`);
});
