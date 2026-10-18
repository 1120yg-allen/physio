import type { AnyRow, Encounter, TableName, TableRows } from './schema';

/**
 * 資料存取介面。server 端由 SQLite 實作、client 端由 IndexedDB 實作,
 * 業務規則(rules.ts / service.ts)只依賴此介面,因此兩端行為一致。
 * 回傳與寫入的皆為個案相關資料,實作不得將其寫入 log。
 */
export interface Repo {
  get<T extends TableName>(table: T, id: string): Promise<TableRows[T] | null>;
  list<T extends TableName>(table: T): Promise<TableRows[T][]>;
  /** 寫入(新增或覆寫同 id 列)。不做業務規則檢查,規則由 acceptRow 負責。 */
  put<T extends TableName>(table: T, row: TableRows[T]): Promise<void>;
  /** 以 encounter_id 取得 1:1 對應的紀錄 */
  getByEncounter<T extends 'soap_notes' | 'ltc_records'>(table: T, encounterId: string): Promise<TableRows[T] | null>;
  /** 找出取代(supersedes_id 指向)某版本的新版本 */
  getSuperseder(encounterId: string): Promise<Encounter | null>;
  listEncountersByPatient(patientId: string): Promise<Encounter[]>;
}

export type Row = AnyRow;
