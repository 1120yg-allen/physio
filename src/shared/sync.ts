// 同步協定(client ↔ server)與 server 端套用邏輯。
import type { Repo } from './repo';
import { acceptRow, type RejectCode } from './rules';
import { isTableName, type AnyRow, type Encounter, type TableName } from './schema';

export interface SyncChange {
  table: TableName;
  row: unknown;
}

export interface SyncRequest {
  /** client 已取得的 server 序號;server 回傳此序號之後的變更 */
  since: number;
  changes: SyncChange[];
}

export interface SyncResult {
  table: TableName;
  id: string;
  status: 'accepted' | 'rejected';
  reject?: RejectCode;
  message?: string;
  /** 被拒絕時,server 目前持有的版本(若有),client 據以覆蓋本機 */
  current?: AnyRow | null;
}

export interface PulledChange {
  table: TableName;
  row: AnyRow;
}

export interface SyncResponse {
  results: SyncResult[];
  changes: PulledChange[];
  cursor: number;
}

/** 套用順序:被參照的資料先到(個案 → 字典 → 服務 → 內容)。 */
const ORDER: readonly TableName[] = ['patients', 'tests', 'exercises', 'goals', 'favorites', 'ltc_contracts', 'ltc_staff', 'ltc_plans', 'ltc_quotas', 'ltc_suspensions', 'encounters', 'soap_notes', 'ltc_records', 'appointments', 'line_messages'];

function rowId(row: unknown): string {
  if (typeof row === 'object' && row !== null && 'id' in row && typeof (row as { id: unknown }).id === 'string') {
    return (row as { id: string }).id;
  }
  return '';
}

/**
 * 依序套用 client 送來的變更。每筆獨立判定:被拒絕的不影響其他筆。
 * 被拒絕且 server 已有同 id 資料時,回傳該資料供 client 對齊。
 */
export async function applyChanges(repo: Repo, changes: SyncChange[]): Promise<SyncResult[]> {
  const sorted = changes
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const t = ORDER.indexOf(a.c.table) - ORDER.indexOf(b.c.table);
      if (t !== 0) return t;
      if (a.c.table === 'encounters') {
        const va = (a.c.row as Partial<Encounter>).version ?? 0;
        const vb = (b.c.row as Partial<Encounter>).version ?? 0;
        if (va !== vb) return va - vb;
      }
      return a.i - b.i;
    })
    .map((x) => x.c);

  const results: SyncResult[] = [];
  for (const { table, row } of sorted) {
    const id = rowId(row);
    if (!isTableName(table)) {
      results.push({ table, id, status: 'rejected', reject: 'invalid', message: '未知資料表' });
      continue;
    }
    const r = await acceptRow(repo, table, row);
    if (r.applied) {
      results.push({ table, id, status: 'accepted' });
    } else {
      const current = id ? await repo.get(table, id) : null;
      results.push({ table, id, status: 'rejected', reject: r.reject, message: r.message, current });
    }
  }
  return results;
}
