import { tableDef, type AnyRow, type ColumnDef, type TableName, type TableRows } from './schema';

/** 資料驗證/業務規則違反。訊息為繁體中文,可直接顯示給使用者(不得夾帶個案內容)。 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkColumn(table: TableName, col: ColumnDef, value: unknown): void {
  const label = `${table}.${col.name}`;
  if (value === null || value === undefined) {
    if (col.required) throw new DomainError('required', `必填欄位未填:${label}`);
    return;
  }
  switch (col.type) {
    case 'text':
      if (typeof value !== 'string') throw new DomainError('type', `欄位型別錯誤(應為文字):${label}`);
      if (col.required && value.length === 0) throw new DomainError('required', `必填欄位未填:${label}`);
      if (col.enum && !col.enum.includes(value)) throw new DomainError('enum', `欄位值不合法:${label}`);
      return;
    case 'integer':
    case 'real': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new DomainError('type', `欄位型別錯誤(應為數字):${label}`);
      }
      if (col.type === 'integer' && !Number.isInteger(value)) {
        throw new DomainError('type', `欄位型別錯誤(應為整數):${label}`);
      }
      if (col.min !== undefined && value < col.min) throw new DomainError('range', `欄位值超出範圍:${label}`);
      if (col.max !== undefined && value > col.max) throw new DomainError('range', `欄位值超出範圍:${label}`);
      return;
    }
    case 'bool':
      if (typeof value !== 'boolean') throw new DomainError('type', `欄位型別錯誤(應為布林):${label}`);
      return;
    case 'json':
      if (!isPlainObject(value)) throw new DomainError('type', `欄位型別錯誤(應為物件):${label}`);
      return;
  }
}

/** 依 schema 驗證一列資料的欄位型別、必填與列舉;多餘欄位視為錯誤。 */
export function validateShape<T extends TableName>(table: T, row: unknown): TableRows[T] {
  if (!isPlainObject(row)) throw new DomainError('type', `資料格式錯誤:${table}`);
  const def = tableDef(table);
  const known = new Set(def.columns.map((c) => c.name));
  for (const key of Object.keys(row)) {
    if (!known.has(key)) throw new DomainError('unknown_field', `未知欄位:${table}.${key}`);
  }
  for (const col of def.columns) checkColumn(table, col, row[col.name]);
  return row as unknown as TableRows[T];
}

/** 補齊缺漏的選填欄位為 null,確保每列欄位齊全(便於比對與儲存)。 */
export function normalizeRow<T extends TableName>(table: T, row: Record<string, unknown>): TableRows[T] {
  const out: Record<string, unknown> = {};
  for (const col of tableDef(table).columns) {
    const v = row[col.name];
    out[col.name] = v === undefined ? null : v;
  }
  return out as unknown as TableRows[T];
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isPlainObject(v)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
    return o;
  }
  return v;
}

/** 兩列資料內容是否完全相同(欄位順序無關)。 */
export function rowsEqual(a: AnyRow, b: AnyRow): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
