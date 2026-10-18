// SPEC.md §2 資料模型:單一來源。
// SQLite DDL(server)與 IndexedDB 物件倉庫(client)皆由此產生,欄位名稱與規格一致。
//
// 規格外新增的欄位(僅為同步與稽核基礎設施,不改變規格欄位語意):
//   - encounters / soap_notes / ltc_records / 字典表 的 created_at、updated_at
//   - soap_notes / ltc_records 的 encounter_id(實現「1:1 對應 Encounter」)
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

export interface TableRows {
  patients: Patient;
  encounters: Encounter;
  soap_notes: SoapNote;
  ltc_records: LtcRecord;
  tests: TestDef;
  exercises: Exercise;
  goals: Goal;
  favorites: Favorite;
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
