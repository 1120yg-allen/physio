// 資料寫入的業務規則。server 收到同步資料、client 本機寫入都經過 acceptRow,
// 因此「簽章後鎖定」「版本不分叉」在兩端皆被強制(CLAUDE.md C2、C3)。
import type { Repo } from './repo';
import type { Appointment, Encounter, LineMessage, LtcRecord, Patient, SoapNote, TableName, TableRows } from './schema';
import { canCorrect, canTransition } from './ltc';
import { compareIso } from './time';
import { DomainError, normalizeRow, rowsEqual, validateShape } from './validate';

export type RejectCode =
  | 'invalid' // 欄位/格式不合法
  | 'stale' // 對方版本較新
  | 'locked' // 已簽章鎖定
  | 'fork' // 版本鏈分叉
  | 'orphan' // 參照的上層資料不存在
  | 'conflict'; // 其他違反規則

export class Rejection extends Error {
  constructor(
    public readonly reject: RejectCode,
    message: string,
  ) {
    super(message);
    this.name = 'Rejection';
  }
}

export type AcceptResult = { applied: true; changed: boolean } | { applied: false; reject: RejectCode; message: string };

/**
 * 驗證並寫入一列資料。內容與現有完全相同時不寫入(changed=false),使同步可重送(冪等)。
 * 失敗不丟例外,回傳 applied=false 與原因。
 */
export async function acceptRow<T extends TableName>(repo: Repo, table: T, incoming: unknown): Promise<AcceptResult> {
  try {
    const shaped = validateShape(table, incoming);
    const row = normalizeRow(table, shaped as unknown as Record<string, unknown>);
    const existing = await repo.get(table, row.id);
    if (existing && rowsEqual(existing, row)) return { applied: true, changed: false };
    await checkTable(repo, table, row, existing);
    await repo.put(table, row);
    return { applied: true, changed: true };
  } catch (e) {
    if (e instanceof Rejection) return { applied: false, reject: e.reject, message: e.message };
    if (e instanceof DomainError) return { applied: false, reject: 'invalid', message: e.message };
    throw e;
  }
}

/** 與 acceptRow 相同,但違規時丟出 DomainError(本機呼叫用)。 */
export async function acceptRowOrThrow<T extends TableName>(repo: Repo, table: T, incoming: unknown): Promise<boolean> {
  const r = await acceptRow(repo, table, incoming);
  if (!r.applied) throw new DomainError(r.reject, r.message);
  return r.changed;
}

async function checkTable<T extends TableName>(
  repo: Repo,
  table: T,
  row: TableRows[T],
  existing: TableRows[T] | null,
): Promise<void> {
  switch (table) {
    case 'patients':
      return checkPatient(row as Patient, existing as Patient | null);
    case 'encounters':
      return checkEncounter(repo, row as Encounter, existing as Encounter | null);
    case 'soap_notes':
      return checkNote(repo, 'soap_notes', row as SoapNote, existing as SoapNote | null);
    case 'ltc_records':
      return checkNote(repo, 'ltc_records', row as LtcRecord, existing as LtcRecord | null);
    case 'ltc_contracts':
    case 'ltc_staff':
    case 'ltc_plans':
    case 'ltc_quotas':
    case 'ltc_suspensions':
      return checkLtcSupport(repo, table, row as unknown as Record<string, unknown> & { updated_at: string; created_at: string }, existing as unknown as { updated_at: string; created_at: string } | null);
    case 'line_messages':
      return checkLineMessage(repo, row as LineMessage, existing as LineMessage | null);
    case 'appointments':
      return checkAppointment(repo, row as Appointment, existing as Appointment | null);
    case 'goals': {
      const g = row as TableRows['goals'];
      if (!(await repo.get('patients', g.patient_id))) throw new Rejection('orphan', '目標所屬個案不存在');
      return checkLww(row as { updated_at: string; created_at: string }, existing as { updated_at: string; created_at: string } | null);
    }
    default:
      return checkLww(row as { updated_at: string; created_at: string }, existing as { updated_at: string; created_at: string } | null);
  }
}

/** 最後寫入者勝(以 updated_at 判斷);created_at 不可變。 */
function checkLww(row: { updated_at: string; created_at: string }, existing: { updated_at: string; created_at: string } | null): void {
  if (!existing) return;
  if (row.created_at !== existing.created_at) throw new Rejection('conflict', 'created_at 不可修改');
  if (compareIso(row.updated_at, existing.updated_at) < 0) throw new Rejection('stale', '對方資料較新,未覆寫');
}

function checkPatient(row: Patient, existing: Patient | null): void {
  if ((row.track === 'ltc' || row.track === 'both') && row.ltc_level === null) {
    throw new Rejection('invalid', '長照個案須填寫長照需要等級');
  }
  checkLww(row, existing);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** 長照核銷預檢所需的設定資料:日期格式、起訖順序、個案存在、計畫結案欄位一致 */
async function checkLtcSupport(
  repo: Repo,
  table: 'ltc_contracts' | 'ltc_staff' | 'ltc_plans' | 'ltc_quotas' | 'ltc_suspensions',
  row: Record<string, unknown> & { updated_at: string; created_at: string },
  existing: { updated_at: string; created_at: string } | null,
): Promise<void> {
  const date = (k: string, optional = false): void => {
    const v = row[k];
    if (v === null || v === undefined) {
      if (!optional) throw new Rejection('invalid', `${k} 必填`);
      return;
    }
    if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new Rejection('invalid', `${k} 日期格式須為 YYYY-MM-DD`);
  };
  if (table !== 'ltc_quotas' && table !== 'ltc_staff') {
    date('start_date');
    date('end_date');
    if ((row.end_date as string) < (row.start_date as string)) throw new Rejection('invalid', '結束日期不可早於開始日期');
  }
  if (table === 'ltc_staff') {
    date('valid_from');
    date('valid_to', true);
    if (row.valid_to && (row.valid_to as string) < (row.valid_from as string)) throw new Rejection('invalid', '資格結束日期不可早於開始日期');
  }
  if (table === 'ltc_quotas' && !MONTH_RE.test(row.quota_month as string)) throw new Rejection('invalid', '申報年月格式須為 YYYY-MM');
  if (table === 'ltc_plans' || table === 'ltc_quotas' || table === 'ltc_suspensions') {
    if (!(await repo.get('patients', row.patient_id as string))) throw new Rejection('orphan', '所屬個案不存在');
  }
  if (table === 'ltc_plans') {
    const closed = row.status !== 'active';
    if (closed && !row.closed_at) throw new Rejection('invalid', '中途結案/移居須填結案日期');
    if (!closed && (row.closed_at || row.fa400_done_at)) throw new Rejection('invalid', '進行中的計畫不可有結案日期或 FA400 完成日期');
    date('closed_at', true);
    date('fa400_done_at', true);
  }
  checkLww(row as { updated_at: string; created_at: string }, existing);
}

async function checkLineMessage(repo: Repo, row: LineMessage, existing: LineMessage | null): Promise<void> {
  if (!(await repo.get('patients', row.patient_id))) throw new Rejection('orphan', '訊息所屬個案不存在');
  if (row.encounter_id !== null) {
    const enc = await repo.get('encounters', row.encounter_id);
    if (!enc) throw new Rejection('orphan', '訊息連結的服務紀錄不存在');
    if (enc.patient_id !== row.patient_id) throw new Rejection('conflict', '訊息與服務紀錄的個案不一致');
  }
  const items = (row.payload as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 5) throw new Rejection('invalid', 'LINE 一次最多 5 則訊息,至少 1 則');
  if (existing) {
    if (row.created_at !== existing.created_at) throw new Rejection('conflict', 'created_at 不可修改');
    if (compareIso(row.updated_at, existing.updated_at) < 0) throw new Rejection('stale', '對方資料較新,未覆寫');
    // 已送出的訊息不可被改回待送(避免重複發送)
    if (existing.status === 'sent') throw new Rejection('locked', '訊息已送出,不可修改');
  }
}

async function checkAppointment(repo: Repo, row: Appointment, existing: Appointment | null): Promise<void> {
  if (!(Date.parse(row.end_at) > Date.parse(row.start_at))) throw new Rejection('invalid', '行程結束時間必須晚於開始時間');
  let patient = null;
  if (row.patient_id !== null) {
    patient = await repo.get('patients', row.patient_id);
    if (!patient) throw new Rejection('orphan', '行程所屬個案不存在');
    if (patient.track !== 'both' && patient.track !== row.track) {
      throw new Rejection('conflict', '自費與長照為平行軌,個案軌別與行程軌別不符');
    }
  }
  if (row.encounter_id !== null) {
    const enc = await repo.get('encounters', row.encounter_id);
    if (!enc) throw new Rejection('orphan', '行程連結的服務紀錄不存在');
    if (enc.patient_id !== row.patient_id) throw new Rejection('conflict', '行程與服務紀錄的個案不一致');
  }
  checkLww(row, existing);
}

function sameExceptStatus(a: Encounter, b: Encounter): boolean {
  const strip = (e: Encounter): Encounter => ({ ...e, status: 'draft', updated_at: '' });
  return rowsEqual(strip(a), strip(b));
}

async function checkEncounter(repo: Repo, row: Encounter, existing: Encounter | null): Promise<void> {
  // 狀態與簽章時間必須一致:僅 draft 可無簽章時間
  if ((row.status === 'draft') !== (row.signed_at === null)) {
    throw new Rejection('invalid', '狀態與簽章時間不一致');
  }
  if ((row.version === 1) !== (row.supersedes_id === null)) {
    throw new Rejection('invalid', '版本號與取代關係不一致');
  }

  const patient = await repo.get('patients', row.patient_id);
  if (!patient) throw new Rejection('orphan', '服務紀錄所屬個案不存在');
  if (patient.track !== 'both' && patient.track !== row.track) {
    throw new Rejection('conflict', '自費與長照為平行軌,個案軌別與服務軌別不符');
  }

  if (!existing) return checkNewEncounter(repo, row);

  // 已簽章 → 鎖定。唯一允許的變動:signed → submitted(僅改狀態)。
  if (existing.signed_at !== null) {
    const toSubmitted = existing.status === 'signed' && row.status === 'submitted' && sameExceptStatus(existing, row);
    if (!toSubmitted) throw new Rejection('locked', '紀錄已簽章鎖定,修改請建立新版本');
    return;
  }

  // 草稿:身分欄位不可變
  if (row.patient_id !== existing.patient_id || row.version !== existing.version || row.supersedes_id !== existing.supersedes_id || row.created_at !== existing.created_at) {
    throw new Rejection('conflict', '草稿的個案、版本、建立時間不可修改');
  }
  if (row.track !== existing.track) throw new Rejection('conflict', '服務軌別建立後不可修改');
  if (compareIso(row.updated_at, existing.updated_at) < 0) throw new Rejection('stale', '對方資料較新,未覆寫');
  if (row.status === 'submitted') throw new Rejection('conflict', '草稿須先簽章才能送出申報');
  if (row.status === 'signed') assertSignable(row);
}

async function checkNewEncounter(repo: Repo, row: Encounter): Promise<void> {
  if (row.status === 'submitted') throw new Rejection('conflict', '新建立的紀錄不可直接為已送出狀態');
  if (row.status === 'signed') assertSignable(row);

  if (row.supersedes_id === null) return;

  const prev = await repo.get('encounters', row.supersedes_id);
  if (!prev) throw new Rejection('orphan', '被取代的前一版本不存在');
  if (prev.signed_at === null) throw new Rejection('conflict', '只有已簽章的版本可被取代');
  if (prev.status === 'submitted') {
    // 已送出申報:僅長照紀錄在狀態 1(待通知收件)可修正;狀態 2 之後須洽縣市承辦退件
    const lr = prev.track === 'ltc' ? await repo.getByEncounter('ltc_records', prev.id) : null;
    if (!lr || !canCorrect(lr.submission_status)) {
      throw new Rejection('conflict', '已送出申報的紀錄僅在狀態 1(待通知收件)可修正;狀態 2 之後須洽縣市承辦退件');
    }
  }
  if (row.version !== prev.version + 1) throw new Rejection('invalid', '版本號必須為前一版本 + 1');
  if (row.patient_id !== prev.patient_id || row.track !== prev.track) {
    throw new Rejection('conflict', '新版本的個案與軌別必須與前一版本相同');
  }
  const taken = await repo.getSuperseder(prev.id);
  if (taken && taken.id !== row.id) throw new Rejection('fork', '該版本已有後續版本,版本鏈不可分叉');
}

/** 簽章前提:結束時間須晚於開始時間(防 14:00~14:00)。 */
export function assertSignable(e: Encounter): void {
  if (!(e.end_time > e.start_time)) {
    throw new Rejection('invalid', '結束時間必須晚於開始時間');
  }
  if (e.signed_at === null && e.status !== 'draft') throw new Rejection('invalid', '狀態與簽章時間不一致');
}

async function checkNote<T extends 'soap_notes' | 'ltc_records'>(
  repo: Repo,
  table: T,
  row: TableRows[T],
  existing: TableRows[T] | null,
): Promise<void> {
  const enc = await repo.get('encounters', row.encounter_id);
  if (!enc) throw new Rejection('orphan', '紀錄所屬的服務不存在');

  // C3:自費 SOAP 與長照申報紀錄資料流隔離
  const expectedTrack = table === 'soap_notes' ? 'self_pay' : 'ltc';
  if (enc.track !== expectedTrack) {
    throw new Rejection('conflict', table === 'soap_notes' ? 'SOAP 紀錄只能掛在自費服務下' : '長照申報紀錄只能掛在長照服務下');
  }

  const sibling = await repo.getByEncounter(table, row.encounter_id);
  if (sibling && sibling.id !== row.id) throw new Rejection('conflict', '該服務已有對應紀錄(1:1)');
  if (existing && existing.encounter_id !== row.encounter_id) throw new Rejection('conflict', '紀錄不可改掛到其他服務');

  if (table === 'ltc_records') {
    const lr = row as unknown as LtcRecord;
    if (lr.staff_id !== null && !(await repo.get('ltc_staff', lr.staff_id))) throw new Rejection('orphan', '服務人員資料不存在');
    if (lr.quota_month !== null && !MONTH_RE.test(lr.quota_month)) throw new Rejection('invalid', '申報年月格式須為 YYYY-MM');
    const ex = existing as unknown as LtcRecord | null;
    // 申報狀態只有在服務已送出申報後才有意義;狀態轉換須符合狀態機
    if (enc.status !== 'submitted' && lr.submission_status !== 0) throw new Rejection('invalid', '尚未送出申報的紀錄,申報狀態必須為 0');
    if (ex && ex.submission_status !== lr.submission_status) {
      if (enc.status !== 'submitted') throw new Rejection('conflict', '請先送出申報,才能記錄申報狀態');
      if (!canTransition(ex.submission_status, lr.submission_status)) throw new Rejection('invalid', '申報狀態只能前進一格;退件(狀態 2–5)才可回到 1');
      // 只允許改申報狀態(其餘內容仍受簽章鎖定)
      const same = (a: LtcRecord, b: LtcRecord): boolean => rowsEqual({ ...a, submission_status: 0, updated_at: '' } as never, { ...b, submission_status: 0, updated_at: '' } as never);
      if (!same(ex, lr)) throw new Rejection('locked', '紀錄已簽章鎖定,只能更新申報狀態');
      if (compareIso(lr.updated_at, ex.updated_at) < 0) throw new Rejection('stale', '對方資料較新,未覆寫');
      return;
    }
  }

  // C2:簽章後鎖定。離線時「寫內容 → 簽章」會一起同步,簽章在先、內容在後抵達;
  // 因此只接受簽章時間(含)之前完成的內容(updated_at ≤ signed_at),簽章之後的任何寫入一律拒絕。
  if (enc.signed_at !== null) {
    if (compareIso(row.updated_at, enc.signed_at) > 0) {
      throw new Rejection('locked', '紀錄已簽章鎖定,簽章後不可修改內容');
    }
    if (existing && compareIso(row.updated_at, existing.updated_at) < 0) {
      throw new Rejection('stale', '對方資料較新,未覆寫');
    }
    return;
  }
  checkLww(row, existing);
}
