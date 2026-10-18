// 預約提醒:服務前一日(預設 18:00 起)自動排入一則提醒;提醒內容不含任何健康資訊。
import { randomUUID } from 'node:crypto';
import { dateOf, timeOf, weekdayLabel, addDays } from '../../shared/schedule';
import { reminderMessages } from '../../shared/linemsg';
import { acceptRow } from '../../shared/rules';
import type { SqliteRepo } from '../db';
import type { LineStore } from './store';

export interface ReminderDeps {
  repo: SqliteRepo;
  store: LineStore;
  now: () => string;
  clinicName: string;
  contact: string | null;
  /** 幾點起發送前一日提醒(台北時間,0–23) */
  hour: number;
}

/** 掃描並排入應發送的提醒,回傳新排入的數量。重複執行不會重複排入。 */
export async function enqueueReminders(d: ReminderDeps): Promise<number> {
  const nowIso = d.now();
  const nowMs = Date.parse(nowIso);
  let n = 0;
  for (const a of await d.repo.list('appointments')) {
    if (a.status !== 'scheduled' || a.patient_id === null) continue;
    const start = Date.parse(a.start_at);
    if (start - nowMs < 3600_000) continue; // 一小時內就要開始或已開始:不再提醒
    const day = dateOf(a.start_at);
    const windowStart = Date.parse(`${addDays(day, -1)}T${String(d.hour).padStart(2, '0')}:00:00+08:00`);
    if (nowMs < windowStart) continue;
    if (d.store.activeRecipients(a.patient_id).length === 0) continue;

    // 改期後(start_at 不同)會是新的 key,可再提醒一次
    if (!d.store.claimKey(`rem:${a.id}:${a.start_at}`, nowIso)) continue;

    const today = dateOf(nowIso);
    const label = day === addDays(today, 1) ? '明天' : day === today ? '今天' : day.slice(5).replace('-', '/');
    const items = reminderMessages(d.clinicName, `${label}(${weekdayLabel(day)})`, timeOf(a.start_at), d.contact);
    const r = await acceptRow(d.repo, 'line_messages', {
      id: randomUUID(), patient_id: a.patient_id, encounter_id: null, appointment_id: a.id, kind: 'reminder', payload: { items },
      expires_at: a.start_at, status: 'queued', status_detail: null, attempts: 0, sent_at: null, created_at: nowIso, updated_at: nowIso,
    });
    if (r.applied) n++;
  }
  return n;
}
