// 外送佇列:把 line_messages 中 status=queued 的訊息推給該個案已綁定的 LINE 使用者,並回寫狀態。
// 訊息內容含健康資料,狀態與錯誤只記錄通用說明。
import { acceptRow } from '../../shared/rules';
import type { LineMessage } from '../../shared/schema';
import type { SqliteRepo } from '../db';
import { retryKeyFor, type LineApi } from './api';
import type { LineStore } from './store';

const MAX_ATTEMPTS = 3;

export interface OutboxDeps {
  repo: SqliteRepo;
  store: LineStore;
  api: LineApi;
  now: () => string;
}

export interface DrainResult {
  sent: number;
  skipped: number;
  failed: number;
  retry: number;
}

/** 回寫時間戳:至少比原列晚 1ms,避免裝置時鐘稍快時被判為舊資料而拒收 */
function after(prev: string, now: string): string {
  return Date.parse(now) > Date.parse(prev) ? now : new Date(Date.parse(prev) + 1).toISOString();
}

async function update(d: OutboxDeps, m: LineMessage, patch: Partial<LineMessage>): Promise<void> {
  const row: LineMessage = { ...m, ...patch, updated_at: after(m.updated_at, d.now()) };
  const r = await acceptRow(d.repo, 'line_messages', row);
  if (!r.applied && r.reject !== 'locked') throw new Error(`回寫訊息狀態失敗:${r.reject}`);
}

export async function drainOutbox(d: OutboxDeps): Promise<DrainResult> {
  const res: DrainResult = { sent: 0, skipped: 0, failed: 0, retry: 0 };
  const queued = (await d.repo.list('line_messages')).filter((m) => m.status === 'queued').sort((a, b) => a.created_at.localeCompare(b.created_at));

  for (const m of queued) {
    const nowIso = d.now();
    if (m.expires_at && Date.parse(m.expires_at) < Date.parse(nowIso)) {
      await update(d, m, { status: 'skipped', status_detail: '已逾時,不再送出' });
      res.skipped++;
      continue;
    }
    const recipients = d.store.activeRecipients(m.patient_id);
    if (recipients.length === 0) {
      await update(d, m, { status: 'skipped', status_detail: '尚未綁定 LINE(請家屬加入官方帳號並輸入綁定碼)' });
      res.skipped++;
      continue;
    }

    const items = m.payload.items;
    let failure: { retryable: boolean; detail: string } | null = null;
    for (const to of recipients) {
      const key = `msg:${m.id}:${to}`;
      if (d.store.hasKey(key)) continue; // 先前已送達的收件者不重送
      const r = await d.api.push(to, items, retryKeyFor(key));
      if (r.ok) d.store.claimKey(key, d.now());
      else failure = { retryable: r.retryable, detail: r.detail };
    }

    const attempts = m.attempts + 1;
    if (!failure) {
      await update(d, m, { status: 'sent', status_detail: null, attempts, sent_at: d.now() });
      res.sent++;
    } else if (failure.retryable && attempts < MAX_ATTEMPTS) {
      await update(d, m, { attempts, status_detail: failure.detail });
      res.retry++;
    } else {
      await update(d, m, { status: 'failed', status_detail: failure.detail, attempts });
      res.failed++;
    }
  }
  return res;
}
