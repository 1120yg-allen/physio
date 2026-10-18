// 資料匯入(P5):欄位自動對應規則庫、值轉換(民國年、手機前導 0、性別…)、逐列驗證與重複偵測。
// 設計原則(SPEC §七):寧可少匯入結構化欄位、把不確定內容整段存進「歷史備註」保留原文,也不要錯誤拆解。
// 處理的資料為個案個資,不得寫入 log。純函式,不碰資料庫。
import type { Gender, Track } from './schema';
import type { NewPatientInput } from './service';

export type TargetField =
  | 'name' | 'birth_date' | 'gender' | 'phone' | 'address' | 'ec_name' | 'ec_relation' | 'ec_phone'
  | 'track' | 'ltc_level' | 'precautions' | 'first_visit' | 'diagnosis' | 'note' | 'history' | 'ignore';

export const TARGET_LABEL: Record<TargetField, string> = {
  name: '姓名', birth_date: '生日', gender: '性別', phone: '電話', address: '地址', ec_name: '緊急聯絡人姓名', ec_relation: '緊急聯絡人關係',
  ec_phone: '緊急聯絡人電話', track: '軌別(自費/長照)', ltc_level: '長照需要等級', precautions: '禁忌症與注意事項', first_visit: '初診日(存入歷史備註)',
  diagnosis: '診斷(存入歷史備註)', note: '備註(存入歷史備註)', history: '其他 → 歷史備註(保留原文)', ignore: '忽略此欄',
};

/** 可作為結構化欄位的目標(其餘皆為歷史備註或忽略) */
export const STRUCTURED: readonly TargetField[] = ['name', 'birth_date', 'gender', 'phone', 'address', 'ec_name', 'ec_relation', 'ec_phone', 'track', 'ltc_level', 'precautions'];

// ───────────── 欄位名稱規則庫(5.2) ─────────────

const SYNONYMS: Record<Exclude<TargetField, 'history' | 'ignore'>, string[]> = {
  name: ['姓名', '名字', '個案姓名', '病人姓名', '病患姓名', '患者姓名', '個案', '病人', '病患', '客戶姓名', '學員姓名', '案主', 'name', 'patient', 'patientname', 'fullname'],
  birth_date: ['生日', '出生日期', '出生年月日', '生年月日', '出生', '民國生日', 'birth', 'birthday', 'birthdate', 'dob', 'dateofbirth'],
  gender: ['性別', '性', 'gender', 'sex'],
  phone: ['電話', '手機', '聯絡電話', '連絡電話', '行動電話', '手機號碼', '聯絡手機', '電話號碼', 'tel', 'telephone', 'phone', 'mobile', 'cell', 'cellphone'],
  address: ['地址', '住址', '居住地址', '通訊地址', '到宅地址', '戶籍地址', '服務地址', 'address', 'addr'],
  ec_name: ['緊急聯絡人', '緊急聯絡人姓名', '家屬姓名', '聯絡人', '聯絡人姓名', '家屬', 'emergencycontact', 'contactname'],
  ec_relation: ['關係', '緊急聯絡人關係', '與病人關係', '與個案關係', '聯絡人關係', '家屬關係', 'relationship', 'relation'],
  ec_phone: ['緊急聯絡人電話', '家屬電話', '聯絡人電話', '緊急電話', '緊急聯絡電話', '家屬手機', 'emergencyphone', 'contactphone'],
  track: ['軌別', '類別', '服務類別', '身分別', '身份別', '自費長照', '服務別', 'track'],
  ltc_level: ['長照等級', '需要等級', '照顧等級', '失能等級', 'cms', 'cms等級', 'ltclevel'],
  precautions: ['禁忌症', '禁忌', '注意事項', '禁忌症與注意事項', '禁忌症及注意事項', '警示', '特殊注意', 'precautions', 'contraindications', 'warning'],
  first_visit: ['初診日', '初診日期', '首次就診', '初診', '首診日', '首次看診', '開案日', 'firstvisit', 'firstvisitdate'],
  diagnosis: ['診斷', '診斷名稱', '病名', '疾病', '主診斷', '診斷碼', '病史診斷', 'diagnosis', 'dx'],
  note: ['備註', '備考', '註記', '說明', '其他', '附註', '備忘', 'note', 'notes', 'remark', 'remarks', 'comment', 'comments'],
};

const toHalf = (s: string): string => s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** 欄名正規化:全形轉半形、轉小寫、去除空白與標點 */
export function normalizeHeader(h: string): string {
  return toHalf(h).toLowerCase().replace(/[\s:：()()\[\]【】「」*＊_\-/\\.、,，]/g, '');
}

export interface HeaderMatch {
  field: Exclude<TargetField, 'history' | 'ignore'>;
  /** 完全相同 → 高;包含 → 中 */
  confidence: 'high' | 'medium';
  score: number;
}

/** 以規則庫比對欄名:最長且最精確者勝(例:「聯絡人電話」同時含「電話」與「聯絡人」,取較長者 → 緊急聯絡人電話) */
export function matchHeader(header: string): HeaderMatch | null {
  const h = normalizeHeader(header);
  if (h === '') return null;
  let best: HeaderMatch | null = null;
  for (const [field, syns] of Object.entries(SYNONYMS) as [HeaderMatch['field'], string[]][]) {
    for (const syn of syns) {
      const s = normalizeHeader(syn);
      let score = 0;
      let confidence: HeaderMatch['confidence'] = 'medium';
      if (h === s) {
        score = 1000 + s.length;
        confidence = 'high';
      } else if (s.length >= 2 && h.includes(s)) score = s.length;
      if (score > (best?.score ?? 0)) best = { field, confidence, score };
    }
  }
  return best;
}

// ───────────── 欄位分析(自動偵測) ─────────────

export interface ColumnInfo {
  index: number;
  header: string;
  samples: string[];
  target: TargetField;
  confidence: 'high' | 'medium' | 'low' | 'none';
  reason: string;
}

/** 找標題列:前 10 列中符合規則庫欄名最多者;都沒有則第 1 列 */
export function detectHeaderRow(rows: string[][]): number {
  let best = 0;
  let bestN = 0;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const n = (rows[i] ?? []).filter((c) => matchHeader(c ?? '') !== null).length;
    if (n > bestN) {
      best = i;
      bestN = n;
    }
  }
  return best;
}

const PHONE_RE = /^(?:\+?886-?)?0?9\d{2}-?\d{3}-?\d{3}$|^0\d{1,2}-?\d{6,8}$/;
const nonEmpty = (xs: string[]): string[] => xs.map((x) => (x ?? '').trim()).filter((x) => x !== '');

/** 內容探測(欄名認不得時的備援,信心低):手機號碼、性別、看起來像生日的日期 */
function sniff(values: string[], today: string): { field: TargetField; reason: string } | null {
  const v = nonEmpty(values).slice(0, 50);
  if (v.length < 2) return null;
  const share = (pred: (s: string) => boolean): number => v.filter(pred).length / v.length;
  if (share((s) => PHONE_RE.test(s.replace(/\s/g, ''))) >= 0.8) return { field: 'phone', reason: '內容像電話號碼' };
  if (share((s) => /^(男|女|男性|女性|m|f|male|female)$/i.test(s)) >= 0.9) return { field: 'gender', reason: '內容只有性別值' };
  const year = Number(today.slice(0, 4));
  const plausibleBirth = (s: string): boolean => {
    const d = parseDate(s, { twoDigitYear: 'roc', today });
    return d !== null && 'iso' in d && Number(d.iso.slice(0, 4)) >= year - 110 && Number(d.iso.slice(0, 4)) <= year - 1;
  };
  if (share(plausibleBirth) >= 0.8) return { field: 'birth_date', reason: '內容像出生日期(年齡落在合理範圍)' };
  return null;
}

/** 分析每一欄並給出對應建議。同一目標只留最可信的一欄,其餘改為「歷史備註」。 */
export function analyzeColumns(rows: string[][], headerRow: number, today: string): ColumnInfo[] {
  const header = rows[headerRow] ?? [];
  const body = rows.slice(headerRow + 1);
  const width = Math.max(header.length, ...body.slice(0, 50).map((r) => r.length), 0);
  const cols: (ColumnInfo & { score: number })[] = [];
  for (let i = 0; i < width; i++) {
    const h = (header[i] ?? '').trim();
    const samples = nonEmpty(body.map((r) => r[i] ?? '')).slice(0, 3);
    const m = matchHeader(h);
    if (m) {
      cols.push({ index: i, header: h, samples, target: m.field, confidence: m.confidence, reason: m.confidence === 'high' ? '欄名完全符合' : '欄名包含關鍵字', score: m.score });
      continue;
    }
    const sn = sniff(body.map((r) => r[i] ?? ''), today);
    cols.push(sn
      ? { index: i, header: h, samples, target: sn.field, confidence: 'low', reason: `${sn.reason}(猜測,請確認)`, score: 0 }
      : { index: i, header: h, samples, target: samples.length ? 'history' : 'ignore', confidence: 'none', reason: samples.length ? '無法辨識,保留原文到歷史備註' : '整欄空白', score: 0 });
  }
  // 同一結構化目標只保留一欄(分數高者;同分取前面),其餘改歷史備註
  const owner = new Map<TargetField, number>();
  for (const c of cols) {
    if (c.target === 'history' || c.target === 'ignore') continue;
    const cur = owner.get(c.target);
    if (cur === undefined || c.score > (cols[cur] as { score: number }).score) owner.set(c.target, c.index);
  }
  for (const c of cols) {
    if (c.target !== 'history' && c.target !== 'ignore' && owner.get(c.target) !== c.index) {
      c.target = 'history';
      c.confidence = 'none';
      c.reason = '同一欄位已有更符合的欄,此欄保留原文到歷史備註';
    }
  }
  return cols.map(({ score: _s, ...c }) => c);
}

// ───────────── 值轉換 ─────────────

export interface DateOptions {
  /** 兩位數年份視為民國或西元 */
  twoDigitYear: 'roc' | 'ad';
  today: string;
}

export type DateResult = { iso: string; note: string | null } | { error: string } | null;

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const iso = (y: number, m: number, d: number): string => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * 解析日期:西元(2020-03-02、2020/3/2、2020年3月2日、20200302)、民國(65/3/2、065-03-02、650302、0650302)、Excel 序號(28000)。
 * 無法確定時回傳 error(例如 3/2/1976 無法判斷月日順序),不猜測。空字串回傳 null。
 */
export function parseDate(raw: string, opt: DateOptions): DateResult {
  const s = toHalf(raw).trim().replace(/\s+/g, '');
  if (s === '') return null;
  const roc = (y: number, m: number, d: number, note: string): DateResult => (validYmd(y + 1911, m, d) ? { iso: iso(y + 1911, m, d), note } : { error: `不是有效日期:「${raw.trim()}」` });
  const ad = (y: number, m: number, d: number, note: string | null): DateResult => (validYmd(y, m, d) ? { iso: iso(y, m, d), note } : { error: `不是有效日期:「${raw.trim()}」` });

  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s);
  if (m) return ad(Number(m[1]), Number(m[2]), Number(m[3]), null);

  m = /^(\d{1,3})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    if ((m[1] as string).length <= 2 && opt.twoDigitYear === 'ad') return ad(1900 + y, Number(m[2]), Number(m[3]), '兩位數年份視為西元 19xx');
    return roc(y, Number(m[2]), Number(m[3]), `民國 ${y} 年 → 西元 ${y + 1911}`);
  }
  if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(s)) return { error: `日期格式不明確(月日順序無法判斷):「${raw.trim()}」,請改成 西元年-月-日` };

  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m && Number(m[1]) >= 1850 && Number(m[1]) <= 2100) return ad(Number(m[1]), Number(m[2]), Number(m[3]), null);
  m = /^(\d{3})(\d{2})(\d{2})$/.exec(s);
  if (m) return roc(Number(m[1]), Number(m[2]), Number(m[3]), `民國 ${Number(m[1])} 年 → 西元 ${Number(m[1]) + 1911}`);
  m = /^(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    return opt.twoDigitYear === 'ad' ? ad(1900 + y, Number(m[2]), Number(m[3]), '兩位數年份視為西元 19xx') : roc(y, Number(m[2]), Number(m[3]), `民國 ${y} 年 → 西元 ${y + 1911}`);
  }
  m = /^(\d{1,5})(?:\.\d+)?$/.exec(s);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 60000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(m[1]) * 86_400_000).toISOString().slice(0, 10);
    return { iso: d, note: `Excel 日期序號 ${m[1]} → ${d}` };
  }
  return { error: `無法辨識的日期:「${raw.trim()}」` };
}

export function parseGender(raw: string): Gender | null | 'unknown' {
  const s = toHalf(raw).trim().toLowerCase();
  if (s === '') return null;
  if (/^(男|男性|先生|m|male|man)$/.test(s)) return 'male';
  if (/^(女|女性|小姐|女士|f|female|woman)$/.test(s)) return 'female';
  if (/^(其他|other|x)$/.test(s)) return 'other';
  return 'unknown';
}

/** 電話:去空白;Excel 吃掉前導 0 的手機(9 碼 9 開頭)補回;科學記號還原。 */
export function normalizePhone(raw: string): { phone: string | null; note: string | null } {
  let s = toHalf(raw).trim().replace(/\s+/g, '');
  if (s === '') return { phone: null, note: null };
  let note: string | null = null;
  if (/^\d(\.\d+)?e\+?\d+$/i.test(s)) {
    s = Number(s).toFixed(0);
    note = '電話為科學記號格式,已還原(請核對)';
  }
  if (/^9\d{8}$/.test(s)) {
    s = `0${s}`;
    note = note ?? '手機缺少前導 0,已補上';
  }
  return { phone: s, note };
}

export function parseTrack(raw: string): Track | null {
  const s = toHalf(raw).trim().toLowerCase().replace(/\s/g, '');
  if (s === '') return null;
  const ltc = /長照|ltc|cms/.test(s);
  const self = /自費|self/.test(s);
  if ((ltc && self) || /兩者|雙軌|both|自費\+長照|長照\+自費/.test(s)) return 'both';
  if (ltc) return 'ltc';
  if (self) return 'self_pay';
  return null;
}

// ───────────── 轉換、驗證、重複偵測 ─────────────

export interface ImportOptions {
  headerRow: number;
  /** 每一欄的目標(與欄位索引對齊) */
  mapping: TargetField[];
  twoDigitYear: 'roc' | 'ad';
  defaultTrack: Track;
  /** 長照個案缺少等級時採用;null 表示視為錯誤 */
  defaultLtcLevel: number | null;
  referralRequired: boolean;
  sourceName: string;
  today: string;
}

export interface ImportRow {
  /** 資料列序號(標題列之後第幾筆,從 1 起算,不含空白列) */
  rowNumber: number;
  input: NewPatientInput;
  notes: string[];
}

export interface ImportError {
  rowNumber: number;
  kind: 'invalid' | 'duplicate_in_file' | 'exists';
  reason: string;
  cells: string[];
}

export interface ConvertResult {
  total: number;
  valid: ImportRow[];
  errors: ImportError[];
}

const FIRST_LABEL: Partial<Record<TargetField, string>> = { first_visit: '初診日', diagnosis: '診斷', note: '備註' };

/** 轉換並驗證全部資料列。existing:系統內已有的個案(姓名+生日相同視為已存在,不重複匯入)。 */
export function convertRows(rows: string[][], opt: ImportOptions, existing: { name: string; birth_date: string }[]): ConvertResult {
  const header = rows[opt.headerRow] ?? [];
  const body = rows.slice(opt.headerRow + 1);
  const seen = new Set(existing.map((p) => `${p.name.replace(/\s+/g, '')}|${p.birth_date}`));
  const valid: ImportRow[] = [];
  const errors: ImportError[] = [];

  body.forEach((cells, idx) => {
    const rowNumber = idx + 1;
    const get = (t: TargetField): string => (cells[opt.mapping.indexOf(t)] ?? '').trim();
    const has = (t: TargetField): boolean => opt.mapping.includes(t);
    const notes: string[] = [];
    const history: string[] = [];
    const fail = (reason: string, kind: ImportError['kind'] = 'invalid'): void => {
      errors.push({ rowNumber, kind, reason, cells });
    };

    const name = (has('name') ? get('name') : '').replace(/\s+/g, ' ').trim();
    if (!name) return fail('缺少姓名');

    const rawBirth = has('birth_date') ? get('birth_date') : '';
    const bd = parseDate(rawBirth, { twoDigitYear: opt.twoDigitYear, today: opt.today });
    if (bd === null) return fail('缺少生日');
    if ('error' in bd) return fail(bd.error);
    if (bd.iso > opt.today) return fail(`生日是未來日期:「${rawBirth}」`);
    if (Number(opt.today.slice(0, 4)) - Number(bd.iso.slice(0, 4)) > 120) return fail(`生日距今超過 120 年,請確認:「${rawBirth}」`);
    if (bd.note) notes.push(`生日:${bd.note}`);

    const key = `${name.replace(/\s+/g, '')}|${bd.iso}`;
    if (seen.has(key)) {
      const inFile = valid.some((v) => `${v.input.name.replace(/\s+/g, '')}|${v.input.birth_date}` === key);
      return fail(inFile ? '檔案內有姓名與生日完全相同的另一筆' : '系統內已有同姓名同生日的個案', inFile ? 'duplicate_in_file' : 'exists');
    }

    // 性別
    let gender: Gender | null = null;
    if (has('gender')) {
      const g = parseGender(get('gender'));
      if (g === 'unknown') history.push(`性別:${get('gender')}`);
      else gender = g;
    }
    // 電話
    let phone: string | null = null;
    if (has('phone')) {
      const p = normalizePhone(get('phone'));
      phone = p.phone;
      if (p.note) notes.push(`電話:${p.note}`);
    }
    // 軌別與等級
    let track: Track = opt.defaultTrack;
    if (has('track') && get('track') !== '') {
      const t = parseTrack(get('track'));
      if (t) track = t;
      else history.push(`軌別:${get('track')}`);
    }
    let level: number | null = null;
    if (has('ltc_level') && get('ltc_level') !== '') {
      const n = Number(toHalf(get('ltc_level')).replace(/[^\d]/g, ''));
      if (Number.isInteger(n) && n >= 1 && n <= 8) level = n;
      else history.push(`長照等級:${get('ltc_level')}`);
    }
    if ((track === 'ltc' || track === 'both') && level === null) {
      if (opt.defaultLtcLevel !== null) {
        level = opt.defaultLtcLevel;
        notes.push(`長照等級缺漏,使用預設值 ${level}`);
      } else return fail('長照個案缺少長照需要等級');
    }

    // 緊急聯絡人
    const ecName = has('ec_name') ? get('ec_name') : '';
    const ecRel = has('ec_relation') ? get('ec_relation') : '';
    const ecPhone = has('ec_phone') ? normalizePhone(get('ec_phone')).phone ?? '' : '';
    const emergency = ecName || ecRel || ecPhone ? { name: ecName, relation: ecRel, phone: ecPhone } : null;

    // 歷史備註:初診日/診斷/備註/其他欄(保留原文)
    for (const t of ['first_visit', 'diagnosis', 'note'] as const) {
      const v = has(t) ? get(t) : '';
      if (v) history.push(`${FIRST_LABEL[t]}:${v}`);
    }
    opt.mapping.forEach((t, i) => {
      if (t !== 'history') return;
      const v = (cells[i] ?? '').trim();
      if (v) history.push(`${(header[i] ?? '').trim() || `第 ${i + 1} 欄`}:${v}`);
    });
    const historyNote = history.length ? `【匯入自 ${opt.sourceName},${opt.today}】\n${history.join('\n')}` : null;

    seen.add(key);
    valid.push({
      rowNumber, notes,
      input: {
        name, birth_date: bd.iso, track, referral_required: opt.referralRequired, gender, phone,
        address: has('address') ? get('address') || null : null, emergency_contact: emergency, ltc_level: level,
        precautions: has('precautions') ? get('precautions') || null : null, history_note: historyNote,
      },
    });
  });

  return { total: body.length, valid, errors };
}

/** 錯誤清單 → 可下載的 CSV 列(含原始資料,方便修正後重新匯入) */
export function errorRows(res: ConvertResult, header: string[]): (string | number)[][] {
  return [['資料列', '原因', ...header], ...res.errors.map((e) => [e.rowNumber, e.reason, ...e.cells])];
}
