// SQLite 資料層(node:sqlite,單檔)。內含個案特種個資,檔案須置於加密磁碟(SPEC §8)。
import { DatabaseSync, type SQLInputValue } from './sqlite';
import type { Repo } from '../shared/repo';
import { tableDef, TABLES, type AnyRow, type ColumnDef, type Encounter, type TableName, type TableRows } from '../shared/schema';

type SqlRow = Record<string, unknown>;

const PREVENT_DELETE: readonly TableName[] = ['patients', 'encounters', 'soap_notes', 'ltc_records'];

function sqlType(c: ColumnDef): string {
  switch (c.type) {
    case 'integer':
    case 'bool':
      return 'INTEGER';
    case 'real':
      return 'REAL';
    default:
      return 'TEXT';
  }
}

function createTableSql(name: TableName): string {
  const def = tableDef(name);
  const cols = def.columns.map((c) => `  ${c.name} ${sqlType(c)}${c.name === 'id' ? ' PRIMARY KEY' : c.required ? ' NOT NULL' : ''}`);
  cols.push('  server_seq INTEGER NOT NULL DEFAULT 0');
  return `CREATE TABLE IF NOT EXISTS ${name} (\n${cols.join(',\n')}\n)`;
}

/** 已簽章服務的欄位凍結條件:除 status/updated_at/server_seq 外任一欄位改動即視為違規。 */
function encounterFrozenCondition(): string {
  const diff = tableDef('encounters')
    .columns.filter((c) => !['status', 'updated_at'].includes(c.name))
    .map((c) => `OLD.${c.name} IS NOT NEW.${c.name}`)
    .join(' OR ');
  return `OLD.signed_at IS NOT NULL AND (${diff} OR NOT (OLD.status = NEW.status OR (OLD.status = 'signed' AND NEW.status = 'submitted')))`;
}

/** 依序執行的 migration。只能新增,不可修改既有項目。 */
interface Migration {
  version: number;
  name: string;
  sql: string[];
  run?: (db: DatabaseSync) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '初始資料表(SPEC §2)',
    sql: [
      ...TABLES.map((t) => createTableSql(t.name)),
      ...TABLES.flatMap((t) => (t.indexes ?? []).map((c) => `CREATE INDEX IF NOT EXISTS idx_${t.name}_${c} ON ${t.name}(${c})`)),
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_soap_notes_encounter ON soap_notes(encounter_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_ltc_records_encounter ON ltc_records(encounter_id)',
      // 版本鏈不可分叉:同一版本只能被一個新版本取代
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_encounters_supersedes ON encounters(supersedes_id) WHERE supersedes_id IS NOT NULL',
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
      "INSERT OR IGNORE INTO meta (key, value) VALUES ('server_seq', 0)",
    ],
  },
  {
    version: 2,
    name: '法遵防線:簽章後鎖定、禁止刪除(資料庫層)',
    sql: [
      // C2:資料庫層保底。即使應用層有漏洞,已簽章紀錄也無法被改寫或刪除。
      `CREATE TRIGGER IF NOT EXISTS trg_encounters_locked BEFORE UPDATE ON encounters
         WHEN ${encounterFrozenCondition()}
         BEGIN SELECT RAISE(ABORT, '已簽章紀錄不可修改'); END`,
      ...(['soap_notes', 'ltc_records'] as const).flatMap((t) => [
        `CREATE TRIGGER IF NOT EXISTS trg_${t}_locked_update BEFORE UPDATE ON ${t}
           WHEN EXISTS (SELECT 1 FROM encounters e WHERE e.id = OLD.encounter_id AND e.signed_at IS NOT NULL
                          AND julianday(NEW.updated_at) > julianday(e.signed_at))
           BEGIN SELECT RAISE(ABORT, '已簽章紀錄不可修改'); END`,
        `CREATE TRIGGER IF NOT EXISTS trg_${t}_locked_insert BEFORE INSERT ON ${t}
           WHEN EXISTS (SELECT 1 FROM encounters e WHERE e.id = NEW.encounter_id AND e.signed_at IS NOT NULL
                          AND julianday(NEW.updated_at) > julianday(e.signed_at))
           BEGIN SELECT RAISE(ABORT, '已簽章紀錄不可新增內容'); END`,
      ]),
      ...PREVENT_DELETE.map(
        (t) => `CREATE TRIGGER IF NOT EXISTS trg_${t}_no_delete BEFORE DELETE ON ${t}
           BEGIN SELECT RAISE(ABORT, '病歷資料依法保存十年,不可刪除'); END`,
      ),
    ],
  },
  {
    version: 3,
    name: '補齊新增欄位(exercises.category)',
    sql: [],
    // 既有資料庫補上 schema 新增、但舊版 CREATE TABLE 沒有的欄位;全新資料庫不受影響
    run: (db) => ensureColumns(db),
  },
  {
    version: 4,
    name: '排程表 appointments 與 Google 行事曆對應表(僅 server)',
    sql: [
      createTableSql('appointments'),
      ...(tableDef('appointments').indexes ?? []).map((c) => `CREATE INDEX IF NOT EXISTS idx_appointments_${c} ON appointments(${c})`),
      // Google 對應資料只存在 server,不隨同步下發,避免被 client 的整列覆寫洗掉
      `CREATE TABLE IF NOT EXISTS gcal_map (
         appointment_id TEXT PRIMARY KEY,
         event_id TEXT NOT NULL UNIQUE,
         etag TEXT,
         synced_at TEXT NOT NULL,
         remote_deleted INTEGER NOT NULL DEFAULT 0
       )`,
      'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ],
  },
];

function toSql(c: ColumnDef, v: unknown): SQLInputValue {
  if (v === null || v === undefined) return null;
  if (c.type === 'json') return JSON.stringify(v);
  if (c.type === 'bool') return v ? 1 : 0;
  return v as SQLInputValue;
}

function fromSql(c: ColumnDef, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (c.type === 'json') return JSON.parse(v as string) as unknown;
  if (c.type === 'bool') return v === 1 || v === 1n;
  if (c.type === 'integer' || c.type === 'real') return Number(v);
  return v;
}

export interface GcalMapRow {
  appointment_id: string;
  event_id: string;
  etag: string | null;
  synced_at: string;
  remote_deleted: boolean;
}

interface GcalMapRaw {
  appointment_id: string;
  event_id: string;
  etag: string | null;
  synced_at: string;
  remote_deleted: number | bigint;
}

const toMap = (r: GcalMapRaw): GcalMapRow => ({ ...r, remote_deleted: Number(r.remote_deleted) === 1 });

export class SqliteRepo implements Repo {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  private decode<T extends TableName>(table: T, r: SqlRow): TableRows[T] {
    const out: SqlRow = {};
    for (const c of tableDef(table).columns) out[c.name] = fromSql(c, r[c.name]);
    return out as unknown as TableRows[T];
  }

  async get<T extends TableName>(table: T, id: string): Promise<TableRows[T] | null> {
    const r = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as SqlRow | undefined;
    return r ? this.decode(table, r) : null;
  }

  async list<T extends TableName>(table: T): Promise<TableRows[T][]> {
    return (this.db.prepare(`SELECT * FROM ${table}`).all() as SqlRow[]).map((r) => this.decode(table, r));
  }

  async put<T extends TableName>(table: T, row: TableRows[T]): Promise<void> {
    const cols = tableDef(table).columns;
    const names = cols.map((c) => c.name);
    const values = cols.map((c) => toSql(c, (row as unknown as SqlRow)[c.name]));
    const seq = this.nextSeq();
    const updates = names.filter((n) => n !== 'id').map((n) => `${n} = excluded.${n}`);
    updates.push('server_seq = excluded.server_seq');
    this.db
      .prepare(
        `INSERT INTO ${table} (${names.join(', ')}, server_seq) VALUES (${names.map(() => '?').join(', ')}, ?)
         ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}`,
      )
      .run(...values, seq);
  }

  async getByEncounter<T extends 'soap_notes' | 'ltc_records'>(table: T, encounterId: string): Promise<TableRows[T] | null> {
    const r = this.db.prepare(`SELECT * FROM ${table} WHERE encounter_id = ?`).get(encounterId) as SqlRow | undefined;
    return r ? this.decode(table, r) : null;
  }

  async getSuperseder(encounterId: string): Promise<Encounter | null> {
    const r = this.db.prepare('SELECT * FROM encounters WHERE supersedes_id = ?').get(encounterId) as SqlRow | undefined;
    return r ? this.decode('encounters', r) : null;
  }

  async listEncountersByPatient(patientId: string): Promise<Encounter[]> {
    return (this.db.prepare('SELECT * FROM encounters WHERE patient_id = ?').all(patientId) as SqlRow[]).map((r) =>
      this.decode('encounters', r),
    );
  }

  // ── Google 行事曆對應(僅 server) ──

  getMap(appointmentId: string): GcalMapRow | null {
    const r = this.db.prepare('SELECT * FROM gcal_map WHERE appointment_id = ?').get(appointmentId) as GcalMapRaw | undefined;
    return r ? toMap(r) : null;
  }

  getMapByEvent(eventId: string): GcalMapRow | null {
    const r = this.db.prepare('SELECT * FROM gcal_map WHERE event_id = ?').get(eventId) as GcalMapRaw | undefined;
    return r ? toMap(r) : null;
  }

  putMap(m: GcalMapRow): void {
    this.db
      .prepare(
        `INSERT INTO gcal_map (appointment_id, event_id, etag, synced_at, remote_deleted) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(appointment_id) DO UPDATE SET event_id = excluded.event_id, etag = excluded.etag, synced_at = excluded.synced_at, remote_deleted = excluded.remote_deleted`,
      )
      .run(m.appointment_id, m.event_id, m.etag, m.synced_at, m.remote_deleted ? 1 : 0);
  }

  getKv(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setKv(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ── 同步用 ──

  currentSeq(): number {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = 'server_seq'").get() as { value: number };
    return Number(r.value);
  }

  private nextSeq(): number {
    this.db.exec("UPDATE meta SET value = value + 1 WHERE key = 'server_seq'");
    return this.currentSeq();
  }

  /** 取得 seq 之後的所有變更(依 seq 排序) */
  changesSince(seq: number): { table: TableName; row: AnyRow; seq: number }[] {
    const out: { table: TableName; row: AnyRow; seq: number }[] = [];
    for (const t of TABLES) {
      const rows = this.db.prepare(`SELECT * FROM ${t.name} WHERE server_seq > ?`).all(seq) as SqlRow[];
      for (const r of rows) out.push({ table: t.name, row: this.decode(t.name, r), seq: Number(r.server_seq) });
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  /** 以 BEGIN/COMMIT 包住一段(僅含微任務的)非同步操作 */
  async transaction<R>(fn: () => Promise<R>): Promise<R> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = await fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => Number(r.version)));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      for (const stmt of m.sql) db.exec(stmt);
      m.run?.(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** 比對 schema 與實際資料表,缺少的欄位以 ALTER TABLE 補上(選填欄位;exercises.category 補預設值) */
function ensureColumns(db: DatabaseSync): void {
  for (const t of TABLES) {
    const have = new Set((db.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string }[]).map((c) => c.name));
    for (const c of t.columns) {
      if (have.has(c.name)) continue;
      const dflt = t.name === 'exercises' && c.name === 'category' ? " NOT NULL DEFAULT 'exercise'" : '';
      db.exec(`ALTER TABLE ${t.name} ADD COLUMN ${c.name} ${sqlType(c)}${dflt}`);
    }
  }
}
