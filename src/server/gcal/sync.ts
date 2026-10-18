// Google Calendar 雙向同步引擎。
//
// 設計要點
// - 不重複:事件 id 由行程 id 決定(重送只會變成更新);另用 gcal_map 記住對應與 etag。
// - 不迴圈:本端推送後記下 Google 回傳的 etag,下次拉回時 etag 相同即視為自己的回音,略過。
// - 衝突:雙方都改過時,以較晚的修改時間為準(最後寫入者勝)。
// - 只同步一個專用行事曆(由設定指定),不會讀取使用者的其他行事曆。
// - 已有服務紀錄的行程,即使 Google 端被刪除也不會取消本端行程(病歷依法保存)。
// 本檔處理的資料含個案姓名(特種個資的一部分),不得寫入 log。
import { acceptRow } from '../../shared/rules';
import type { Appointment, Patient } from '../../shared/schema';
import type { SqliteRepo } from '../db';
import { buildEventBody, eventIdFor, eventTimes, type PrivacyLevel } from './privacy';
import { EventExistsError, SyncTokenGoneError, type CalendarApi, type CalendarEvent } from './types';

const TOKEN_KEY = 'gcal_sync_token';

export interface GcalDeps {
  repo: SqliteRepo;
  api: CalendarApi;
  privacy: PrivacyLevel;
  now: () => string;
  newId: () => string;
}

export interface GcalResult {
  /** 從 Google 新增/更新到本機的行程數 */
  pulled: number;
  created: number;
  updated: number;
  deleted: number;
  /** 需人工留意的情況(例如 Google 端刪除了已有服務紀錄的行程) */
  warnings: string[];
}

export async function runGcalSync(d: GcalDeps): Promise<GcalResult> {
  const r: GcalResult = { pulled: 0, created: 0, updated: 0, deleted: 0, warnings: [] };

  // ── A. 拉:Google → 本機 ──
  let listed: { events: CalendarEvent[]; nextSyncToken: string };
  const token = d.repo.getKv(TOKEN_KEY);
  try {
    listed = await d.api.list(token);
  } catch (e) {
    if (!(e instanceof SyncTokenGoneError)) throw e;
    listed = await d.api.list(null); // token 失效:全量重抓(靠 etag/對應表不會重複)
  }
  for (const ev of listed.events) await pullEvent(d, ev, r);

  // ── B. 推:本機 → Google ──
  for (const a of await d.repo.list('appointments')) await pushAppointment(d, a, r);

  d.repo.setKv(TOKEN_KEY, listed.nextSyncToken);
  return r;
}

async function pullEvent(d: GcalDeps, ev: CalendarEvent, r: GcalResult): Promise<void> {
  const times = eventTimes(ev);
  if (ev.status !== 'cancelled' && !times) return; // 全天事件等:不處理

  let map = d.repo.getMapByEvent(ev.id);
  if (!map) {
    // 對應表遺失(例如推送後、記錄前中斷)時,由事件上的 physio_id 認回
    const pid = ev.extendedProperties?.private?.physio_id;
    if (pid && (await d.repo.get('appointments', pid))) {
      map = { appointment_id: pid, event_id: ev.id, etag: null, synced_at: '1970-01-01T00:00:00.000+08:00', remote_deleted: false };
      d.repo.putMap(map);
    }
  }

  if (ev.status === 'cancelled') {
    if (!map) return;
    const a = await d.repo.get('appointments', map.appointment_id);
    if (!a || map.remote_deleted) return;
    if (a.status === 'scheduled') {
      if (a.encounter_id !== null) {
        r.warnings.push('Google 行事曆刪除了一筆已開啟服務紀錄的行程;本機行程已保留。');
        d.repo.putMap({ ...map, etag: ev.etag, remote_deleted: true, synced_at: d.now() });
        return;
      }
      const t = d.now();
      await acceptRow(d.repo, 'appointments', { ...a, status: 'cancelled', updated_at: t });
      r.pulled++;
      d.repo.putMap({ ...map, etag: ev.etag, remote_deleted: true, synced_at: t });
    } else {
      d.repo.putMap({ ...map, etag: ev.etag, remote_deleted: true });
    }
    return;
  }
  if (!times) return;

  if (!map) {
    // Google 端新增的事件:建立「未指定個案」的行程,待使用者指定個案
    const t = d.now();
    const row: Appointment = {
      id: d.newId(), patient_id: null, title: ev.summary ?? '(無標題)', track: 'self_pay', ...times,
      location_text: ev.location ?? null, status: 'scheduled', encounter_id: null, note: null, created_at: t, updated_at: t,
    };
    const res = await acceptRow(d.repo, 'appointments', row);
    if (res.applied) {
      d.repo.putMap({ appointment_id: row.id, event_id: ev.id, etag: ev.etag, synced_at: t, remote_deleted: false });
      r.pulled++;
    }
    return;
  }

  if (map.etag === ev.etag) return; // 自己推上去的回音
  const a = await d.repo.get('appointments', map.appointment_id);
  if (!a) return;

  const remoteAt = Date.parse(ev.updated ?? '') || 0;
  const localChanged = Date.parse(a.updated_at) > Date.parse(map.synced_at);
  if (localChanged && Date.parse(a.updated_at) >= remoteAt) {
    // 本機較新:保留本機,稍後推送覆蓋;先記下 etag 避免重複判斷
    d.repo.putMap({ ...map, etag: ev.etag });
    return;
  }

  const t = d.now();
  const same = a.start_at === times.start_at && a.end_at === times.end_at && !map.remote_deleted;
  if (same) {
    // 時間相同:只記下 etag。若本機另有未推送的變更(如地點),保留待推送狀態
    d.repo.putMap({ ...map, etag: ev.etag, synced_at: localChanged ? map.synced_at : t });
    return;
  }
  const row: Appointment = { ...a, ...times, status: a.status, updated_at: t };
  if (d.privacy === 'full' && ev.location !== undefined) row.location_text = ev.location;
  const res = await acceptRow(d.repo, 'appointments', row);
  if (res.applied) {
    r.pulled++;
    d.repo.putMap({ ...map, etag: ev.etag, synced_at: t, remote_deleted: false });
  }
}

async function pushAppointment(d: GcalDeps, a: Appointment, r: GcalResult): Promise<void> {
  const map = d.repo.getMap(a.id);
  const patient: Patient | null = a.patient_id ? await d.repo.get('patients', a.patient_id) : null;

  if (!map) {
    if (a.status === 'cancelled') return;
    const id = eventIdFor(a.id);
    const body = buildEventBody(a, patient, d.privacy);
    let ev: CalendarEvent;
    try {
      ev = await d.api.insert(id, body);
      r.created++;
    } catch (e) {
      if (!(e instanceof EventExistsError)) throw e;
      ev = await d.api.patch(id, { ...body, status: 'confirmed' }); // 已存在(上次中斷):改為更新,不產生重複
      r.updated++;
    }
    d.repo.putMap({ appointment_id: a.id, event_id: id, etag: ev.etag, synced_at: d.now(), remote_deleted: false });
    return;
  }

  if (!(Date.parse(a.updated_at) > Date.parse(map.synced_at))) return; // 沒有本機變更

  if (a.status === 'cancelled') {
    if (!map.remote_deleted) {
      await d.api.remove(map.event_id);
      r.deleted++;
    }
    d.repo.putMap({ ...map, synced_at: d.now(), remote_deleted: true });
    return;
  }

  const body = buildEventBody(a, patient, d.privacy);
  const ev = await d.api.patch(map.event_id, map.remote_deleted ? { ...body, status: 'confirmed' } : body);
  r.updated++;
  d.repo.putMap({ ...map, etag: ev.etag, synced_at: d.now(), remote_deleted: false });
}
