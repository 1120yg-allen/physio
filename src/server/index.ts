import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './app';
import { startDailyBackup } from './backup';
import { loadConfig } from './config';
import { SqliteRepo } from './db';
import { createGcalService } from './gcal/service';
import { createLineService } from './line/service';
import { createWebhookServer } from './line/server';

const cfg = loadConfig();
mkdirSync(dirname(cfg.dbPath), { recursive: true });
const repo = new SqliteRepo(cfg.dbPath);

startDailyBackup(repo, cfg.backupDir, (p) => console.log(`已完成每日備份:${p}`));

const gcal = createGcalService(repo, dirname(cfg.dbPath));
gcal.start();
const gs = gcal.status();
console.log(gs.enabled ? `Google 行事曆同步:已啟用(隱私等級 ${gs.privacy})` : `Google 行事曆同步:未啟用(${gs.reason ?? ''});可在「排程」頁按「連結 Google 帳號」設定`);

const line = createLineService(repo);
line.start();
const ls = line.status();
console.log(ls.enabled ? `LINE:已啟用(提醒於前一日 ${ls.reminder_hour}:00 起發送)` : `LINE:未啟用(${ls.reason ?? ''})`);
if (line.enabled) {
  // webhook 專用埠:需要公網 HTTPS 時只對外開放這個埠,主系統(病歷 API)不對外
  const whPort = Number(process.env.LINE_WEBHOOK_PORT ?? 8788);
  createWebhookServer(line).listen(whPort, process.env.LINE_WEBHOOK_HOST ?? '127.0.0.1', () => console.log(`LINE webhook 埠:${whPort}(只處理 POST /line/webhook)`));
}

createApp(repo, cfg.staticDir, { gcal, line }).listen(cfg.port, cfg.host, () => {
  console.log(`居家物理治療系統已啟動:http://${cfg.host}:${cfg.port}`);
  console.log(`資料庫:${cfg.dbPath}`);
  console.log(`備份目錄:${cfg.backupDir}`);
});
