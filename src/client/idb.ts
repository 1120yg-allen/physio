// IndexedDB 本機主儲存(C4 離線)。含特種個資,僅存於使用者自己的裝置。
// 每次 put 與「待同步佇列」在同一個交易內寫入,斷電/閃退不會產生有資料卻未排入同步的狀況。
import type { Repo } from '../shared/repo';
import { TABLE_NAMES, type AnyRow, type Encounter, type TableName, type TableRows } from '../shared/schema';

const DB_VERSION = 4; // v2:appointments、v3:line_messages、v4:長照核銷資料表(onupgradeneeded 會補建缺少的倉庫)

export interface OutboxItem {
  key: string; // `${table}:${id}`
  table: TableName;
  id: string;
  queued_at: number;
  /** 被 server 拒絕且無法自動對齊時的原因;保留於本機供人工處理,不會被丟棄 */
  rejected?: string;
}

function reqToPromise<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB 錯誤'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 交易失敗'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 交易中止'));
  });
}

export function openPhysioDb(name = 'physio', factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const t of TABLE_NAMES) {
        if (db.objectStoreNames.contains(t)) continue;
        const s = db.createObjectStore(t, { keyPath: 'id' });
        if (t === 'encounters') {
          s.createIndex('patient_id', 'patient_id');
          s.createIndex('supersedes_id', 'supersedes_id');
        }
        if (t === 'soap_notes' || t === 'ltc_records') s.createIndex('encounter_id', 'encounter_id', { unique: true });
      }
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('無法開啟本機資料庫'));
  });
}

export class IdbRepo implements Repo {
  constructor(private readonly db: IDBDatabase) {}

  async get<T extends TableName>(table: T, id: string): Promise<TableRows[T] | null> {
    const r = await reqToPromise(this.db.transaction(table).objectStore(table).get(id));
    return (r as TableRows[T] | undefined) ?? null;
  }

  async list<T extends TableName>(table: T): Promise<TableRows[T][]> {
    return (await reqToPromise(this.db.transaction(table).objectStore(table).getAll())) as TableRows[T][];
  }

  /** 本機寫入:資料與待同步佇列同一交易 */
  async put<T extends TableName>(table: T, row: TableRows[T]): Promise<void> {
    const tx = this.db.transaction([table, 'outbox'], 'readwrite');
    tx.objectStore(table).put(row);
    const item: OutboxItem = { key: `${table}:${row.id}`, table, id: row.id, queued_at: Date.now() };
    tx.objectStore('outbox').put(item);
    await txDone(tx);
  }

  /** 套用 server 來的資料:不進待同步佇列 */
  async putSynced<T extends TableName>(table: T, row: TableRows[T]): Promise<void> {
    const tx = this.db.transaction(table, 'readwrite');
    tx.objectStore(table).put(row);
    await txDone(tx);
  }

  async getByEncounter<T extends 'soap_notes' | 'ltc_records'>(table: T, encounterId: string): Promise<TableRows[T] | null> {
    const r = await reqToPromise(this.db.transaction(table).objectStore(table).index('encounter_id').get(encounterId));
    return (r as TableRows[T] | undefined) ?? null;
  }

  async getSuperseder(encounterId: string): Promise<Encounter | null> {
    const r = await reqToPromise(this.db.transaction('encounters').objectStore('encounters').index('supersedes_id').get(encounterId));
    return (r as Encounter | undefined) ?? null;
  }

  async listEncountersByPatient(patientId: string): Promise<Encounter[]> {
    return (await reqToPromise(this.db.transaction('encounters').objectStore('encounters').index('patient_id').getAll(patientId))) as Encounter[];
  }

  // ── 佇列與同步游標 ──

  async listOutbox(): Promise<OutboxItem[]> {
    return (await reqToPromise(this.db.transaction('outbox').objectStore('outbox').getAll())) as OutboxItem[];
  }

  async clearOutbox(key: string): Promise<void> {
    const tx = this.db.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').delete(key);
    await txDone(tx);
  }

  async markRejected(key: string, reason: string): Promise<void> {
    const tx = this.db.transaction('outbox', 'readwrite');
    const store = tx.objectStore('outbox');
    const cur = (await reqToPromise(store.get(key))) as OutboxItem | undefined;
    if (cur) store.put({ ...cur, rejected: reason });
    await txDone(tx);
  }

  async getCursor(): Promise<number> {
    const r = (await reqToPromise(this.db.transaction('meta').objectStore('meta').get('cursor'))) as { key: string; value: number } | undefined;
    return r?.value ?? 0;
  }

  async setCursor(value: number): Promise<void> {
    const tx = this.db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: 'cursor', value });
    await txDone(tx);
  }

  async getRowForOutbox(item: OutboxItem): Promise<AnyRow | null> {
    return this.get(item.table, item.id);
  }
}
