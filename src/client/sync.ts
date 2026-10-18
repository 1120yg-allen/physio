// client 同步:先推本機待同步資料,再拉 server 新資料。
// 任何失敗(含無網路)都只回報狀態,絕不阻擋本機讀寫(C4)。
import type { SyncChange, SyncRequest, SyncResponse } from '../shared/sync';
import type { IdbRepo } from './idb';

/** 傳輸層:可替換為測試用的記憶體傳輸 */
export type Transport = (req: SyncRequest) => Promise<SyncResponse>;

export interface SyncOutcome {
  ok: boolean;
  pushed: number;
  pulled: number;
  /** 被 server 拒絕、需人工處理的筆數(資料仍保留在本機) */
  needsAttention: number;
  error?: string;
}

export const httpTransport: Transport = async (req) => {
  const res = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`同步失敗(${res.status})`);
  return (await res.json()) as SyncResponse;
};

export async function runSync(repo: IdbRepo, transport: Transport): Promise<SyncOutcome> {
  const outbox = (await repo.listOutbox()).filter((i) => !i.rejected);
  const changes: SyncChange[] = [];
  for (const item of outbox) {
    const row = await repo.getRowForOutbox(item);
    if (row) changes.push({ table: item.table, row });
  }

  let res: SyncResponse;
  try {
    res = await transport({ since: await repo.getCursor(), changes });
  } catch (e) {
    return { ok: false, pushed: 0, pulled: 0, needsAttention: await countRejected(repo), error: e instanceof Error ? e.message : '無法連線' };
  }

  // 1) 處理推送結果
  let pushed = 0;
  for (const r of res.results) {
    const key = `${r.table}:${r.id}`;
    if (r.status === 'accepted') {
      pushed++;
      await repo.clearOutbox(key);
    } else if (r.reject === 'stale' && r.current) {
      // 最後寫入者勝:server 資料較新,以 server 為準
      await repo.putSynced(r.table, r.current as never);
      await repo.clearOutbox(key);
    } else {
      // 已鎖定、版本分叉等無法自動解決的衝突:本機版本保留並標記,絕不丟棄,交由人工處理
      await repo.markRejected(key, r.message ?? '被伺服器拒絕');
    }
  }

  // 2) 套用拉回的資料;本機仍有未同步修改的列不覆蓋
  const dirty = new Set((await repo.listOutbox()).map((i) => i.key));
  let pulled = 0;
  for (const c of res.changes) {
    if (dirty.has(`${c.table}:${c.row.id}`)) continue;
    await repo.putSynced(c.table, c.row as never);
    pulled++;
  }
  await repo.setCursor(res.cursor);

  return { ok: true, pushed, pulled, needsAttention: await countRejected(repo) };
}

async function countRejected(repo: IdbRepo): Promise<number> {
  return (await repo.listOutbox()).filter((i) => i.rejected).length;
}
