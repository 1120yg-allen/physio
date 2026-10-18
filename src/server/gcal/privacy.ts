// 行事曆內容與隱私:Google 行事曆在第三方雲端,個案姓名、地址屬個資,預設只送最少資訊。
import { createHash } from 'node:crypto';
import type { Appointment, Patient } from '../../shared/schema';
import { dateOf, timeOf } from '../../shared/schedule';
import type { EventBody } from './types';

export type PrivacyLevel = 'minimal' | 'full';

const TRACK = { self_pay: '自費', ltc: '長照' } as const;
const TZ = 'Asia/Taipei';

/** 王大明 → 王○○;單字名 → ○ */
export function maskName(name: string): string {
  const chars = [...name.trim()];
  if (chars.length <= 1) return '○';
  return `${chars[0]}${'○'.repeat(chars.length - 1)}`;
}

/** 由行程 id 決定性地產生合法的 Google 事件 id(base32hex 字元:0-9、a-v),確保重送不會產生重複事件 */
export function eventIdFor(appointmentId: string): string {
  return `p${createHash('sha1').update(appointmentId).digest('hex')}`;
}

/**
 * 組出要送到 Google 的事件內容。
 * - minimal(預設):標題為「王○○・自費」,不含地址與備註
 * - full:完整姓名、地址、備註(使用者明確同意個資存放於 Google 才使用)
 * 只放在 extendedProperties 的 physio_id 是不含個資的行程 id,供之後辨識同一筆事件。
 */
export function buildEventBody(a: Appointment, patient: Patient | null, level: PrivacyLevel): EventBody {
  const track = TRACK[a.track];
  const who = patient ? (level === 'full' ? patient.name : maskName(patient.name)) : (a.title ?? '未指定個案');
  const body: EventBody = {
    summary: `${who}・${track}`,
    start: { dateTime: a.start_at, timeZone: TZ },
    end: { dateTime: a.end_at, timeZone: TZ },
    extendedProperties: { private: { physio_id: a.id } },
  };
  if (level === 'full') {
    if (a.location_text) body.location = a.location_text;
    if (a.note) body.description = a.note;
  }
  return body;
}

/** 事件的日期/時刻(台北);全天事件回傳 null */
export function eventTimes(ev: { start?: { dateTime?: string }; end?: { dateTime?: string } }): { start_at: string; end_at: string } | null {
  const s = ev.start?.dateTime;
  const e = ev.end?.dateTime;
  if (!s || !e) return null;
  const norm = (iso: string): string => `${dateOf(iso)}T${timeOf(iso)}:00+08:00`;
  return { start_at: norm(s), end_at: norm(e) };
}
