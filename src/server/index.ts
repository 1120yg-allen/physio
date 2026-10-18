import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { createApp } from './app';
import { AccessLog, SessionAuth, hardenPermissions, hostPolicy } from './security';
import { startDailyBackup } from './backup';
import { loadConfig } from './config';
import { SqliteRepo } from './db';
import { createGcalService } from './gcal/service';
import { createLineService } from './line/service';
import { createWebhookServer } from './line/server';

const cfg = loadConfig();
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(cfg.host);
const password = process.env.PHYSIO_PASSWORD;
// 對網路開放(HOST 非本機)卻沒有設密碼 → 拒絕啟動,避免病歷 API 裸奔
if (!loopback && !password && process.env.PHYSIO_ALLOW_NO_AUTH !== '1') {
  console.error('✗ HOST 設為對網路開放,但沒有設定 PHYSIO_PASSWORD。為了保護病歷資料,已拒絕啟動。\n  請設定密碼(例:PHYSIO_PASSWORD=你的密碼),並以 PHYSIO_ALLOWED_HOSTS 列出允許的網域。');
  process.exit(1);
}
mkdirSync(dirname(cfg.dbPath), { recursive: true });
const repo = new SqliteRepo(cfg.dbPath);
hardenPermissions(dirname(cfg.dbPath), cfg.dbPath, cfg.backupDir);
// 未預期錯誤只記錄錯誤類型,不輸出訊息與堆疊(可能夾帶資料)
process.on('uncaughtException', (e) => { console.error(`未預期錯誤(${e instanceof Error ? e.name : 'unknown'}),服務將結束`); process.exit(1); });
process.on('unhandledRejection', (e) => console.error(`未處理的非同步錯誤(${e instanceof Error ? e.name : 'unknown'})`));

startDailyBackup(repo, cfg.backupDir, (file) => console.log(`已完成每日備份:${file}`));

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

const accessLog = new AccessLog(join(dirname(cfg.dbPath), 'access.log'));
createApp(repo, cfg.staticDir, { gcal, line, accessLog, hosts: hostPolicy(), ...(password ? { auth: new SessionAuth(password) } : {}) }).listen(cfg.port, cfg.host, () => {
  console.log(`居家物理治療系統已啟動:http://${cfg.host}:${cfg.port}`);
  console.log(`資料庫:${cfg.dbPath}`);
  console.log(`備份目錄:${cfg.backupDir}`);
  console.log(password ? '密碼登入:已啟用' : '密碼登入:未啟用(只聽本機,可用 PHYSIO_PASSWORD 啟用)');
});
