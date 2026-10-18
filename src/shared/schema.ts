// SPEC.md §2 資料模型:單一來源。
// SQLite DDL(server)與 IndexedDB 物件倉庫(client)皆由此產生,欄位名稱與規格一致。
//
// 規格外新增的欄位(僅為同步與稽核基礎設施,不改變規格欄位語意):
//   - encounters / soap_notes / ltc_records / 字典表 的 created_at、updated_at
//   - soap_notes / ltc_records 的 encounter_id(實現「1:1 對應 Encounter」)
//   - ltc_contracts / ltc_staff / ltc_plans / ltc_quotas / ltc_suspensions(長照核銷預檢所需資料;規格 §4.2 要求檢查但 §2 未定義資料表)
//   - patients.history_note、ltc_records.staff_id
//   - line_messages 整張表(LINE 外送佇列)
//   - appointments 整張表(排程;規格 §5 需要但 §2 未定義)
//   - exercises 的 category(介入類別)
//   - favorites 的 kind / ref_id / sort_order(規格僅描述「個人常用清單」)

export type Gender = 'male' | 'female' | 'other';
export type Track = 'ltc' | 'self_pay' | 'both';
export type EncounterTrack = 'ltc' | 'self_pay';
export type Location = 'home' | 'facility' | 'community';
export type EncounterStatus = 'draft' | 'signed' | 'submitted';

/** 緊急聯絡人(含個資) */
export interface EmergencyContact {
  name: string;
  relation: string;
  phone: string;
}

/** 診斷證明/照會單 */
export interface ReferralDoc {
  institution: string;
  physician: string;
  issued_on: string;
  valid_until: string;
  file?: string;
}

/** SPEC §2.1 個案主檔(特種個資) */
export interface Patient {
  id: string;
  name: string;
  birth_date: string;
  gender: Gender | null;
  phone: string | null;
  address: string | null;
  emergency_contact: EmergencyContact | null;
  track: Track;
  ltc_level: number | null;
  referral_doc: ReferralDoc | null;
  referral_required: boolean;
  precautions: string | null;
  /** 歷史備註:匯入時無法結構化的原文(規格外新增,P5) */
  history_note: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** SPEC §2.2 單次服務 */
export interface Encounter {
  id: string;
  patient_id: string;
  track: EncounterTrack;
  service_date: string;
  start_time: string;
  end_time: string;
  service_code: string | null;
  location: Location | null;
  status: EncounterStatus;
  signed_at: string | null;
  version: number;
  supersedes_id: string | null;
  no_show: boolean | null;
  no_show_photo: string | null;
  gps: { lat: number; lng: number; at: string } | null;
  created_at: string;
  updated_at: string;
}

/** SPEC §2.3 自費紀錄;四段以 JSON 存放,內部結構於 P1 細化 */
export interface SoapNote {
  id: string;
  encounter_id: string;
  subjective: Record<string, unknown> | null;
  objective: Record<string, unknown> | null;
  assessment: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** SPEC §2.4 長照申報紀錄 */
export interface LtcRecord {
  id: string;
  encounter_id: string;
  care_goal_id: string | null;
  /** 服務人員(規格外新增:預檢「人員資格」需要) */
  staff_id: string | null;
  executed_content: string | null;
  completion: string | null;
  feedback: string | null;
  quota_month: string | null;
  submission_status: number;
  created_at: string;
  updated_at: string;
}

/** SPEC §2.5 tests:標準化測驗庫 */
export interface TestDef {
  id: string;
  code: string;
  name: string;
  unit: string;
  norms: Record<string, unknown> | null;
  cutoffs: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** SPEC §2.5 exercises:動作庫(與 HEP 共用) */
export interface Exercise {
  id: string;
  name: string;
  /** 介入類別(規格外新增,快速模式依類別篩選) */
  category: 'manual' | 'exercise' | 'functional' | 'education';
  region: string | null;
  video_ref: string | null;
  default_dose: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** SPEC §2.5 goals:SMART 目標 */
export interface Goal {
  id: string;
  patient_id: string;
  description: string;
  baseline_value: number | null;
  target_value: number | null;
  deadline: string | null;
  test_id: string | null;
  created_at: string;
  updated_at: string;
}

/** SPEC §2.5 favorites:治療師個人常用清單 */
export interface Favorite {
  id: string;
  kind: 'test' | 'exercise';
  ref_id: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type AppointmentStatus = 'scheduled' | 'cancelled';

/**
 * 排程(SPEC §5)。規格 §2 未定義此表,為實現「本機排程表」新增。
 * 取消以 status 表示(同步協定不支援刪除)。patient_id 為空表示從 Google 行事曆匯入、尚未指定個案的行程。
 */
export interface Appointment {
  id: string;
  patient_id: string | null;
  /** 未指定個案時顯示用的標題(來自 Google 行事曆) */
  title: string | null;
  track: EncounterTrack;
  /** ISO 8601 含時區,例 2026-10-20T14:00:00+08:00 */
  start_at: string;
  end_at: string;
  /** 到宅地址(建立時由個案地址帶入,可改) */
  location_text: string | null;
  status: AppointmentStatus;
  /** 由此行程開啟的服務紀錄 */
  encounter_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export type LineMessageKind = 'arrive' | 'depart' | 'summary' | 'hep' | 'reminder';
export type LineMessageStatus = 'queued' | 'sent' | 'skipped' | 'failed';

/**
 * LINE 外送訊息佇列(P4)。裝置離線時先排入,同步到 server 後由 server 送出並回寫狀態。
 * payload.items 為 LINE Messaging API 的 message 物件(最多 5 則)。內容含健康資料,不得寫入 log。
 * 規格 §2 未定義此表,為實現 SPEC §六 新增。
 */
export interface LineMessage {
  id: string;
  patient_id: string;
  encounter_id: string | null;
  appointment_id: string | null;
  kind: LineMessageKind;
  payload: { items: Record<string, unknown>[] };
  /** 逾時不再送出(到達/完成通知過時就失去意義) */
  expires_at: string | null;
  status: LineMessageStatus;
  status_detail: string | null;
  attempts: number;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export type PlanStatus = 'active' | 'closed_early' | 'moved';

/** 特約有效期間(預檢 #2)。規格 §2 未定義,為核銷預檢新增 */
export interface LtcContract {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  created_at: string;
  updated_at: string;
}

/** 服務人員資格(預檢 #3):長照 Level 與證照有效期間 */
export interface LtcStaff {
  id: string;
  name: string;
  profession: string;
  ltc_level: number;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
}

/** 照顧計畫(預檢 #4)與中途結案/移居(預檢 #8、FA400) */
export interface LtcPlan {
  id: string;
  patient_id: string;
  start_date: string;
  end_date: string;
  status: PlanStatus;
  closed_at: string | null;
  /** 已在照管系統完成 FA400 提前結案設定的日期 */
  fa400_done_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** 個案當月分配額度(預檢 #1):某申報年月、某服務代碼可申報的次數 */
export interface LtcQuota {
  id: string;
  patient_id: string;
  quota_month: string;
  service_code: string;
  allowed_count: number;
  created_at: string;
  updated_at: string;
}

/** 暫停服務區間(預檢 #5) */
export interface LtcSuspension {
  id: string;
  patient_id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface TableRows {
  patients: Patient;
  encounters: Encounter;
  soap_notes: SoapNote;
  ltc_records: LtcRecord;
  tests: TestDef;
  exercises: Exercise;
  goals: Goal;
  favorites: Favorite;
  appointments: Appointment;
  line_messages: LineMessage;
  ltc_contracts: LtcContract;
  ltc_staff: LtcStaff;
  ltc_plans: LtcPlan;
  ltc_quotas: LtcQuota;
  ltc_suspensions: LtcSuspension;
}

export type TableName = keyof TableRows;
export type AnyRow = TableRows[TableName];

export type ColType = 'text' | 'integer' | 'real' | 'bool' | 'json';

export interface ColumnDef {
  name: string;
  type: ColType;
  required?: boolean;
  enum?: readonly string[];
  /** 整數/實數範圍(含端點) */
  min?: number;
  max?: number;
}

export interface TableDef {
  name: TableName;
  columns: readonly ColumnDef[];
  /** 需建立的 SQLite 索引(欄位名) */
  indexes?: readonly string[];
}

const ts: ColumnDef[] = [
  { name: 'created_at', type: 'text', required: true },
  { name: 'updated_at', type: 'text', required: true },
];

export const TABLES: readonly TableDef[] = [
  {
    name: 'patients',
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'name', type: 'text', required: true },
      { name: 'birth_date', type: 'text', required: true },
      { name: 'gender', type: 'text', enum: ['male', 'female', 'other'] },
      { name: 'phone', type: 'text' },
      { name: 'address', type: 'text' },
      { name: 'emergency_contact', type: 'json' },
      { name: 'track', type: 'text', required: true, enum: ['ltc', 'self_pay', 'both'] },
      { name: 'ltc_level', type: 'integer', min: 1, max: 8 },
      { name: 'referral_doc', type: 'json' },
      { name: 'referral_required', type: 'bool', required: true },
      { name: 'precautions', type: 'text' },
      { name: 'history_note', type: 'text' },
      ...ts,
      { name: 'archived_at', type: 'text' },
    ],
  },
  {
    name: 'encounters',
    indexes: ['patient_id', 'service_date'],
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'patient_id', type: 'text', required: true },
      { name: 'track', type: 'text', required: true, enum: ['ltc', 'self_pay'] },
      { name: 'service_date', type: 'text', required: true },
      { name: 'start_time', type: 'text', required: true },
      { name: 'end_time', type: 'text', required: true },
      { name: 'service_code', type: 'text' },
      { name: 'location', type: 'text', enum: ['home', 'facility', 'community'] },
      { name: 'status', type: 'text', required: true, enum: ['draft', 'signed', 'submitted'] },
      { name: 'signed_at', type: 'text' },
      { name: 'version', type: 'integer', required: true, min: 1 },
      { name: 'supersedes_id', type: 'text' },
      { name: 'no_show', type: 'bool' },
      { name: 'no_show_photo', type: 'text' },
      { name: 'gps', type: 'json' },
      ...ts,
    ],
  },
  {
    name: 'soap_notes',
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'encounter_id', type: 'text', required: true },
      { name: 'subjective', type: 'json' },
      { name: 'objective', type: 'json' },
      { name: 'assessment', type: 'json' },
      { name: 'plan', type: 'json' },
      ...ts,
    ],
  },
  {
    name: 'ltc_records',
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'encounter_id', type: 'text', required: true },
      { name: 'care_goal_id', type: 'text' },
      { name: 'staff_id', type: 'text' },
      { name: 'executed_content', type: 'text' },
      { name: 'completion', type: 'text' },
      { name: 'feedback', type: 'text' },
      { name: 'quota_month', type: 'text' },
      { name: 'submission_status', type: 'integer', required: true, min: 0, max: 6 },
      ...ts,
    ],
  },
  {
    name: 'tests',
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'code', type: 'text', required: true },
      { name: 'name', type: 'text', required: true },
      { name: 'unit', type: 'text', required: true },
      { name: 'norms', type: 'json' },
      { name: 'cutoffs', type: 'json' },
      ...ts,
    ],
  },
  {
    name: 'exercises',
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'name', type: 'text', required: true },
      { name: 'category', type: 'text', required: true, enum: ['manual', 'exercise', 'functional', 'education'] },
      { name: 'region', type: 'text' },
      { name: 'video_ref', type: 'text' },
      { name: 'default_dose', type: 'json' },
      ...ts,
    ],
  },
  {
    name: 'goals',
    indexes: ['patient_id'],
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'patient_id', type: 'text', required: true },
      { name: 'description', type: 'text', required: true },
      { name: 'baseline_value', type: 'real' },
      { name: 'target_value', type: 'real' },
      { name: 'deadline', type: 'text' },
      { name: 'test_id', type: 'text' },
      ...ts,
    ],
  },
  {
    name: 'appointments',
    indexes: ['patient_id', 'start_at'],
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'patient_id', type: 'text' },
      { name: 'title', type: 'text' },
      { name: 'track', type: 'text', required: true, enum: ['ltc', 'self_pay'] },
      { name: 'start_at', type: 'text', required: true },
      { name: 'end_at', type: 'text', required: true },
      { name: 'location_text', type: 'text' },
      { name: 'status', type: 'text', required: true, enum: ['scheduled', 'cancelled'] },
      { name: 'encounter_id', type: 'text' },
      { name: 'note', type: 'text' },
      ...ts,
    ],
  },
  {
    name: 'line_messages',
    indexes: ['patient_id', 'encounter_id'],
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'patient_id', type: 'text', required: true },
      { name: 'encounter_id', type: 'text' },
      { name: 'appointment_id', type: 'text' },
      { name: 'kind', type: 'text', required: true, enum: ['arrive', 'depart', 'summary', 'hep', 'reminder'] },
      { name: 'payload', type: 'json', required: true },
      { name: 'expires_at', type: 'text' },
      { name: 'status', type: 'text', required: true, enum: ['queued', 'sent', 'skipped', 'failed'] },
      { name: 'status_detail', type: 'text' },
      { name: 'attempts', type: 'integer', required: true, min: 0 },
      { name: 'sent_at', type: 'text' },
      ...ts,
    ],
  },
  {
    name: 'ltc_contracts',
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'name', type: 'text', required: true },
      { name: 'start_date', type: 'text', required: true },
      { name: 'end_date', type: 'text', required: true },
      ...ts,
    ],
  },
  {
    name: 'ltc_staff',
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'name', type: 'text', required: true },
      { name: 'profession', type: 'text', required: true },
      { name: 'ltc_level', type: 'integer', required: true, min: 1, max: 3 },
      { name: 'valid_from', type: 'text', required: true },
      { name: 'valid_to', type: 'text' },
      ...ts,
    ],
  },
  {
    name: 'ltc_plans',
    indexes: ['patient_id'],
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'patient_id', type: 'text', required: true },
      { name: 'start_date', type: 'text', required: true },
      { name: 'end_date', type: 'text', required: true },
      { name: 'status', type: 'text', required: true, enum: ['active', 'closed_early', 'moved'] },
      { name: 'closed_at', type: 'text' },
      { name: 'fa400_done_at', type: 'text' },
      { name: 'note', type: 'text' },
      ...ts,
    ],
  },
  {
    name: 'ltc_quotas',
    indexes: ['patient_id'],
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'patient_id', type: 'text', required: true },
      { name: 'quota_month', type: 'text', required: true },
      { name: 'service_code', type: 'text', required: true },
      { name: 'allowed_count', type: 'integer', required: true, min: 0 },
      ...ts,
    ],
  },
  {
    name: 'ltc_suspensions',
    indexes: ['patient_id'],
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'patient_id', type: 'text', required: true },
      { name: 'start_date', type: 'text', required: true },
      { name: 'end_date', type: 'text', required: true },
      { name: 'reason', type: 'text' },
      ...ts,
    ],
  },
  {
    name: 'favorites',
    columns: [
      { name: 'id', type: 'text', required: true },
      { name: 'kind', type: 'text', required: true, enum: ['test', 'exercise'] },
      { name: 'ref_id', type: 'text', required: true },
      { name: 'sort_order', type: 'integer', required: true },
      ...ts,
    ],
  },
];

export const TABLE_NAMES: readonly TableName[] = TABLES.map((t) => t.name);

export function tableDef(name: TableName): TableDef {
  const def = TABLES.find((t) => t.name === name);
  if (!def) throw new Error(`未知資料表:${name}`);
  return def;
}

export function isTableName(v: unknown): v is TableName {
  return typeof v === 'string' && (TABLE_NAMES as readonly string[]).includes(v);
}
