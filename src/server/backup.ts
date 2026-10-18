// 每日備份:以 VACUUM INTO 產生一致性快照(不需停服務)。
// 備份檔含完整特種個資,目的路徑須位於加密磁碟/NAS;另需異地或離線副本(SPEC §8)。
// 病歷依法保存十年,本程式只新增備份檔,不自動刪除任何舊備份。
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from './sqlite';
import { migrate, type SqliteRepo } from './db';

const NAME = /^physio-(\d{4}-\d{2}-\d{2})(?:-(\d{6}))?\.sqlite$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 台北時區的 YYYY-MM-DD */
export function taipeiDate(d: Date): string {
  const t = new Date(d.getTime() + 8 * 3600_000);
  return t.toISOString().slice(0, 10);
}

function taipeiClock(d: Date): string {
  const t = new Date(d.getTime() + 8 * 3600_000);
  return `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}`;
}

/** 建立備份檔,回傳路徑。同日已有備份時加上時間後綴,不覆蓋既有備份。 */
export function backupNow(repo: SqliteRepo, backupDir: string, now = new Date()): string {
  mkdirSync(backupDir, { recursive: true });
  let target = join(backupDir, `physio-${taipeiDate(now)}.sqlite`);
  if (existsSync(target)) target = join(backupDir, `physio-${taipeiDate(now)}-${taipeiClock(now)}.sqlite`);
  repo.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  // VACUUM INTO 不支援參數綁定;路徑來自設定,單引號跳脫處理
  repo.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

export function listBackups(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((f) => NAME.test(f))
    .sort();
}

/** 今天是否已備份(台北時區) */
export function hasBackupForToday(backupDir: string, now = new Date()): boolean {
  const today = taipeiDate(now);
  return listBackups(backupDir).some((f) => NAME.exec(f)?.[1] === today);
}

/** 若今日尚無備份則建立;回傳新備份路徑或 null。 */
export function backupIfDue(repo: SqliteRepo, backupDir: string, now = new Date()): string | null {
  return hasBackupForToday(backupDir, now) ? null : backupNow(repo, backupDir, now);
}

/** 每小時檢查一次,跨日後第一次檢查即備份。啟動時也立即檢查一次。 */
export function startDailyBackup(repo: SqliteRepo, backupDir: string, onDone: (path: string) => void): () => void {
  const tick = (): void => {
    const p = backupIfDue(repo, backupDir);
    if (p) onDone(p);
  };
  tick();
  const timer = setInterval(tick, 3600_000);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * 還原:驗證備份檔完整後,將現有資料庫改名保留(不覆蓋、不刪除),再複製備份檔為資料庫。
 * 須在服務停止時執行。回傳被保留的舊資料庫路徑(若原本存在)。
 */
export function restoreBackup(backupFile: string, dbPath: string): string | null {
  const src = resolve(backupFile);
  if (!existsSync(src) || !statSync(src).isFile()) throw new Error(`找不到備份檔:${basename(src)}`);

  const probe = new DatabaseSync(src, { readOnly: true });
  try {
    const r = probe.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (r.integrity_check !== 'ok') throw new Error('備份檔完整性檢查未通過,已中止還原');
  } finally {
    probe.close();
  }

  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  let kept: string | null = null;
  if (existsSync(dbPath)) {
    kept = `${dbPath}.before-restore-${Date.now()}`;
    copyFileSync(dbPath, kept);
    rmSync(dbPath);
  }
  for (const ext of ['-wal', '-shm']) rmSync(dbPath + ext, { force: true });
  copyFileSync(src, dbPath);

  // 補跑 migration(備份可能來自較舊版本)
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db);
  } finally {
    db.close();
  }
  return kept;
}
