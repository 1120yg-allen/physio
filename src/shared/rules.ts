// 資料寫入的業務規則。server 收到同步資料、client 本機寫入都經過 acceptRow,
// 因此「簽章後鎖定」「版本不分叉」在兩端皆被強制(CLAUDE.md C2、C3)。
import type { Repo } from './repo';
import type { Encounter, LtcRecord, Patient, SoapNote, TableName, TableRows } from './schema';
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
  if (prev.status === 'submitted') throw new Rejection('conflict', '已送出申報的紀錄須依申報流程處理,不可直接建立新版本');
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
