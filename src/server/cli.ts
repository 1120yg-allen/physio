// 命令列:npm run backup / npm run restore -- <備份檔>
import { SqliteRepo } from './db';
import { verifyWitness, witnessPending } from './witness';
import { backupNow, listBackups, restoreBackup } from './backup';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { HttpLineApi } from './line/api';
import { loadConfig } from './config';
import { accessTokenProvider, createDedicatedCalendar, gcalFiles, readConfig, resolveClient, runAuthFlow, saveConfig } from './gcal/auth';

const cfg = loadConfig();
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'verify') {
  const repo = new SqliteRepo(cfg.dbPath);
  witnessPending(repo);
  const r = verifyWitness(repo);
  console.log(`見證鏈共 ${r.total} 筆。${r.problems.length === 0 ? '驗證通過:簽章紀錄完整、內容未被改動。' : '發現問題:\n  ' + r.problems.join('\n  ')}`);
  repo.close();
  process.exit(r.problems.length === 0 ? 0 : 1);
} else if (cmd === 'backup') {
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
} else if (cmd === 'line-test') {
  // 用法:npm run line:test -- <LINE userId> [訊息]  (userId 可由綁定流程取得;此指令用於確認頻道權杖可用)
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || !arg) {
    console.log('用法:LINE_CHANNEL_ACCESS_TOKEN=... npm run line:test -- <LINE userId> [訊息]');
    process.exit(1);
  }
  const msg = process.argv[4] ?? '這是一則測試訊息(居家物理治療系統)';
  const r = await new HttpLineApi(token).push(arg, [{ type: 'text', text: msg }], randomUUID());
  console.log(r.ok ? '已送出' : `失敗:${r.detail}`);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'gcal-auth') {
  const files = gcalFiles(dirname(cfg.dbPath));
  const creds = resolveClient(files);
  if (!creds) {
    console.log('請先設定 Google 用戶端 ID 與密鑰:在「排程」頁貼上,或設定環境變數 GCAL_CLIENT_ID / GCAL_CLIENT_SECRET(見 README)');
    process.exit(1);
  }
  const refresh = await runAuthFlow(creds, files, console.log);
  if (!readConfig(files)) {
    const id = await createDedicatedCalendar(accessTokenProvider(creds, refresh), '居家物治排程');
    saveConfig(files, { calendar_id: id });
    console.log('已建立專用行事曆「居家物治排程」。');
  }
  console.log('授權完成。重新啟動服務(npm start)即可開始同步。');
} else {
  console.log('用法:npm run backup | npm run restore -- <備份檔> | npm run verify | npm run gcal:auth | npm run line:test');
  process.exit(1);
}
