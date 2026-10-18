// 匯出/匯入完整資料(JSON)。純本機版沒有伺服器備份,這是唯一的保護;一般版也可作為額外副本。
// 備份檔含全部個案的特種個資,請自行妥善保管(建議存放在加密磁碟)。
import { TABLE_NAMES, type AnyRow, type TableName } from '../shared/schema';
import { applyChanges, type SyncChange } from '../shared/sync';
import { nowTaipei, todayTaipei } from '../shared/time';
import { h } from './dom';
import type { IdbRepo } from './idb';
import type { ViewCtx } from './schedule';

export const BACKUP_FORMAT = 'physio-backup';

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: 1;
  exported_at: string;
  tables: Record<TableName, AnyRow[]>;
}

export async function exportAll(repo: IdbRepo, now: () => string = nowTaipei): Promise<BackupFile> {
  const tables = {} as Record<TableName, AnyRow[]>;
  for (const t of TABLE_NAMES) tables[t] = await repo.list(t);
  return { format: BACKUP_FORMAT, version: 1, exported_at: now(), tables };
}

export interface ImportResult {
  total: number;
  accepted: number;
  rejected: { table: TableName; reject: string; message: string }[];
}

/** 套用備份:走與同步相同的規則檢查(簽章鎖定、版本鏈等),已存在且相同的資料視為成功。 */
export async function importAll(repo: IdbRepo, raw: unknown): Promise<ImportResult> {
  const f = raw as Partial<BackupFile> | null;
  if (!f || f.format !== BACKUP_FORMAT || f.version !== 1 || typeof f.tables !== 'object' || f.tables === null) {
    throw new Error('這不是本系統匯出的備份檔');
  }
  const changes: SyncChange[] = [];
  for (const t of TABLE_NAMES) {
    const rows = (f.tables as Record<string, unknown>)[t];
    if (Array.isArray(rows)) for (const row of rows) changes.push({ table: t, row });
  }
  const results = await applyChanges(repo, changes);
  return {
    total: results.length,
    accepted: results.filter((r) => r.status === 'accepted').length,
    rejected: results.filter((r) => r.status === 'rejected').map((r) => ({ table: r.table, reject: r.reject ?? 'invalid', message: r.message ?? '' })),
  };
}

const KEY = 'physio.lastBackup';

export function lastBackupLabel(): string {
  try {
    const v = localStorage.getItem(KEY);
    return v ? `上次匯出 ${v.slice(0, 10)}` : '尚未匯出過';
  } catch {
    return '尚未匯出過';
  }
}

export async function backupView(ctx: ViewCtx, repo: IdbRepo): Promise<void> {
  ctx.setEditing(true);
  const counts = await Promise.all(TABLE_NAMES.map(async (t) => [t, (await repo.list(t)).length] as const));
  const patients = counts.find(([t]) => t === 'patients')?.[1] ?? 0;
  const encounters = counts.find(([t]) => t === 'encounters')?.[1] ?? 0;
  const msg = h('div');

  const doExport = async (): Promise<void> => {
    msg.replaceChildren();
    const data = await exportAll(repo);
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `physio-backup-${todayTaipei()}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    try {
      localStorage.setItem(KEY, data.exported_at);
    } catch {
      /* 無法寫入時略過 */
    }
    msg.replaceChildren(h('div', { className: 'ok' }, `已匯出 ${patients} 位個案、${encounters} 筆服務紀錄。請把下載的檔案存放在安全的地方。`));
  };

  const file = h('input', { type: 'file', accept: '.json,application/json' });
  const doImport = async (): Promise<void> => {
    msg.replaceChildren();
    const f = file.files?.[0];
    if (!f) {
      msg.replaceChildren(ctx.errorBox('請先選擇備份檔'));
      return;
    }
    try {
      const r = await importAll(repo, JSON.parse(await f.text()) as unknown);
      msg.replaceChildren(
        h('div', { className: r.rejected.length ? 'err' : 'ok' },
          `匯入完成:${r.accepted} / ${r.total} 筆成功。`,
          r.rejected.length ? `其中 ${r.rejected.length} 筆被規則拒絕(例如已簽章的紀錄與現有不同)。` : '',
        ),
      );
    } catch (e) {
      msg.replaceChildren(ctx.errorBox(e instanceof Error ? e.message : '匯入失敗'));
    }
  };

  ctx.layout('備份與還原', [
    h('div', { className: 'card' },
      h('h2', null, '匯出備份'),
      h('p', { className: 'muted' }, `目前有 ${patients} 位個案、${encounters} 筆服務紀錄。${lastBackupLabel()}。`),
      h('p', { className: 'muted' }, '備份檔含全部個案資料,請存放在安全的地方,不要上傳到公開空間或傳給無關的人。'),
      h('button', { className: 'primary', onclick: () => void doExport() }, '下載備份檔'),
    ),
    h('div', { className: 'card' },
      h('h2', null, '匯入還原'),
      h('p', { className: 'muted' }, '選擇之前匯出的備份檔。已存在且相同的資料不會重複;已簽章鎖定的紀錄不會被覆寫。'),
      file,
      h('p', null, h('button', { onclick: () => void doImport() }, '匯入')),
    ),
    msg,
  ], '#/');
  await ctx.refreshStatus();
}
