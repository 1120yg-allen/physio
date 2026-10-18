// 長照核銷:服務代碼、預檢引擎、申報狀態機、6 個月死線、額度餘額、月度提醒、QD110 匯出整理。
// 全部為純函式(不讀寫資料庫、不含網路),便於單元測試。這是全系統法遵風險最高的模組。
// 處理的資料含個案姓名、服務內容,不得寫入 log。
import type { Encounter, LtcContract, LtcPlan, LtcQuota, LtcRecord, LtcStaff, LtcSuspension, Patient } from './schema';

// ───────────── 服務代碼 ─────────────

export interface LtcCodeInfo {
  name: string;
  /** 每次(實際完成)可請領金額,新台幣元整數。CA07:4,500 元/組(3 次)→ 每次 1,500;依 CLAUDE.md「按實際完成次數請領」 */
  unit_amount: number;
  /** 需要的服務人員長照 Level 下限。⚠ 假設值,尚待依實際特約規定確認 */
  min_level: number;
}

export const LTC_CODES: Record<string, LtcCodeInfo> = {
  CA07: { name: 'IADLs/ADLs 復能照護', unit_amount: 1500, min_level: 1 },
  CC01: { name: '居家環境安全或無障礙空間規劃', unit_amount: 2000, min_level: 1 },
};

export const LTC_CODE_LIST = Object.keys(LTC_CODES);

// ───────────── 日期工具(YYYY-MM-DD / YYYY-MM) ─────────────

export const monthOf = (date: string): string => date.slice(0, 7);

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** 日期加 N 個月(日不存在時取當月最後一天,例 8/31 + 6 個月 = 2/28) */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const inRange = (d: string, start: string, end: string | null): boolean => d >= start && (end === null || d <= end);

// ───────────── 申報狀態機(SPEC §2.4) ─────────────

export const SUBMISSION_STATUS: readonly string[] = ['待審核', '待通知收件', '已通知待收件', '審核中', '等待總表', '審計待審', '結案'];

/** 狀態 s 是否可修正/補上傳(規格:僅狀態 1)。狀態 2 之後須洽縣市承辦退件。 */
export const canCorrect = (s: number): boolean => s === 1;

/**
 * 狀態轉換是否合法:
 * - 只能前進一格(0→1→…→6);6 為終態
 * - 退件:縣市承辦退件後,由狀態 2–5 回到 1(由使用者手動記錄)
 */
export function canTransition(from: number, to: number): boolean {
  if (from === to) return false;
  if (to === from + 1 && to <= 6) return true;
  return to === 1 && from >= 2 && from <= 5;
}

/** 長照紀錄簽章/上傳必備欄位;回傳缺少的欄位名稱 */
export function ltcMissingFields(e: Encounter, r: LtcRecord | null): string[] {
  const miss: string[] = [];
  if (!e.service_code) miss.push('服務代碼');
  if (!r) {
    miss.push('長照申報紀錄');
    return miss;
  }
  if (!r.care_goal_id) miss.push('照顧目標');
  if (!r.executed_content?.trim()) miss.push('本次目標執行內容');
  if (!r.completion?.trim()) miss.push('完成度');
  if (!r.quota_month) miss.push('申報年月');
  if (!r.staff_id) miss.push('服務人員');
  return miss;
}

// ───────────── 預檢引擎(SPEC §4.2) ─────────────

export type Severity = 'error' | 'warn' | 'notice';

/** check 1–8 為規格的 8 項;9–11 為本系統加的時序/死線/完整性檢查 */
export interface PrecheckIssue {
  check: number;
  severity: Severity;
  encounter_id: string | null;
  patient_id: string;
  message: string;
}

export const CHECK_NAMES: Record<number, string> = {
  1: '額度檢查', 2: '特約有效期間', 3: '人員資格', 4: '計畫有效區間', 5: '暫停服務區間', 6: '時間邏輯',
  7: '重複申報偵測', 8: '中途結案偵測', 9: '申報時序', 10: '6 個月死線', 11: '必填欄位',
};

export interface LtcItem {
  encounter: Encounter;
  record: LtcRecord | null;
}

export interface LtcContext {
  contracts: LtcContract[];
  staff: LtcStaff[];
  plans: LtcPlan[];
  quotas: LtcQuota[];
  suspensions: LtcSuspension[];
  patients: Patient[];
}

export interface PrecheckInput {
  /** 今天(YYYY-MM-DD,台北) */
  today: string;
  /** 本次要檢查的候選紀錄(各版本鏈的最新版、長照軌) */
  candidates: LtcItem[];
  /** 已送出申報者(計入額度與重複判斷,不重複檢查) */
  submitted: LtcItem[];
  context: LtcContext;
}

const nameOf = (ctx: LtcContext, patientId: string): string => ctx.patients.find((p) => p.id === patientId)?.name ?? '個案';

export function precheck(input: PrecheckInput): PrecheckIssue[] {
  const { today, context: ctx } = input;
  const issues: PrecheckIssue[] = [];
  const add = (check: number, severity: Severity, it: LtcItem | null, patientId: string, message: string): void => {
    issues.push({ check, severity, encounter_id: it?.encounter.id ?? null, patient_id: patientId, message });
  };
  const label = (it: LtcItem): string => `${nameOf(ctx, it.encounter.patient_id)} ${it.encounter.service_date}${it.encounter.service_code ? ` ${it.encounter.service_code}` : ''}`;

  // 規格外的第 11 項:必填欄位(CA07/CC01 須有的資料;缺了上傳必退)
  const required = (it: LtcItem): void => {
    const miss = ltcMissingFields(it.encounter, it.record);
    if (miss.length) add(11, 'error', it, it.encounter.patient_id, `${label(it)}:缺少 ${miss.join('、')}`);
  };

  for (const it of input.candidates) {
    const e = it.encounter;
    const r = it.record;
    const pid = e.patient_id;
    const date = e.service_date;
    required(it);

    // 2 特約有效期間
    if (ctx.contracts.length === 0) add(2, 'error', it, pid, `${label(it)}:尚未設定特約有效期間`);
    else if (!ctx.contracts.some((c) => inRange(date, c.start_date, c.end_date))) add(2, 'error', it, pid, `${label(it)}:服務日期不在任何特約有效期間內`);

    // 3 人員資格(長照 Level 綁定)
    if (r?.staff_id) {
      const s = ctx.staff.find((x) => x.id === r.staff_id);
      const need = e.service_code ? LTC_CODES[e.service_code]?.min_level : undefined;
      if (!s) add(3, 'error', it, pid, `${label(it)}:找不到服務人員資料`);
      else if (!inRange(date, s.valid_from, s.valid_to)) add(3, 'error', it, pid, `${label(it)}:服務人員 ${s.name} 的資格登錄在服務日期已失效或尚未生效`);
      else if (need !== undefined && s.ltc_level < need) add(3, 'error', it, pid, `${label(it)}:服務人員 ${s.name} 長照 Level ${s.ltc_level},此代碼需要 Level ${need} 以上`);
    }

    // 4 計畫有效區間
    const plans = ctx.plans.filter((p) => p.patient_id === pid);
    if (plans.length === 0) add(4, 'error', it, pid, `${label(it)}:尚未建立照顧計畫`);
    else if (!plans.some((p) => inRange(date, p.start_date, p.end_date))) add(4, 'error', it, pid, `${label(it)}:服務日期不在照顧計畫有效期間內`);

    // 5 暫停服務區間
    const hit = ctx.suspensions.find((s) => s.patient_id === pid && inRange(date, s.start_date, s.end_date));
    if (hit) add(5, 'error', it, pid, `${label(it)}:服務日期落在暫停服務期間(${hit.start_date} ~ ${hit.end_date}${hit.reason ? `,${hit.reason}` : ''})`);

    // 6 時間邏輯
    if (!(e.end_time > e.start_time)) add(6, 'error', it, pid, `${label(it)}:結束時間(${e.end_time})必須晚於開始時間(${e.start_time})`);
    else {
      const [sh, sm] = e.start_time.split(':').map(Number) as [number, number];
      const [eh, em] = e.end_time.split(':').map(Number) as [number, number];
      const mins = eh * 60 + em - (sh * 60 + sm);
      if (mins < 15 || mins > 240) add(6, 'warn', it, pid, `${label(it)}:服務時間 ${mins} 分鐘,請確認是否正確`);
    }

    // 8 中途結案偵測(FA400 前置)
    const closed = plans.find((p) => p.status !== 'active' && !p.fa400_done_at);
    if (closed) add(8, 'notice', it, pid, `${nameOf(ctx, pid)} 已標記${closed.status === 'moved' ? '移居' : '中途結案'}:上傳前請先在照管系統完成 FA400「提前結案設定」,完成後在系統標記`);

    // 9 申報時序:申報年月須晚於服務年月,且到了該月 1 日才可上傳
    if (r?.quota_month) {
      if (r.quota_month <= monthOf(date)) add(9, 'error', it, pid, `${label(it)}:申報年月(${r.quota_month})必須晚於服務年月(${monthOf(date)}),當月紀錄須隔月申報`);
      else if (today < `${r.quota_month}-01`) add(9, 'error', it, pid, `${label(it)}:尚未到可上傳日(${r.quota_month}-01 起)`);
      else if (r.quota_month !== nextMonth(monthOf(date))) add(9, 'warn', it, pid, `${label(it)}:申報年月不是服務年月的次月(${nextMonth(monthOf(date))}),請確認為補申報`);
    }

    // 10 6 個月死線:待申報紀錄僅保留服務日期近 6 個月
    const deadline = addMonths(date, 6);
    const left = daysBetween(today, deadline);
    if (left < 0) add(10, 'error', it, pid, `${label(it)}:服務日期已逾 6 個月(${deadline}),照管系統會刪除待申報紀錄`);
    else if (left <= 30) add(10, 'warn', it, pid, `${label(it)}:距 6 個月死線(${deadline})剩 ${left} 天`);
  }

  // 1 額度檢查:同(個案、申報年月、代碼)依服務日期先後計入,超過額度者為錯
  const groups = new Map<string, LtcItem[]>();
  for (const it of input.candidates) {
    const key = `${it.encounter.patient_id}|${it.record?.quota_month ?? ''}|${it.encounter.service_code ?? ''}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
  }
  for (const [key, list] of groups) {
    const [pid, month, code] = key.split('|') as [string, string, string];
    if (!month || !code) continue; // 缺欄位已由 #11 回報
    const quota = ctx.quotas.find((q) => q.patient_id === pid && q.quota_month === month && q.service_code === code);
    const used = input.submitted.filter((s) => s.encounter.patient_id === pid && s.record?.quota_month === month && s.encounter.service_code === code).length;
    const sorted = list.slice().sort((a, b) => a.encounter.service_date.localeCompare(b.encounter.service_date) || a.encounter.start_time.localeCompare(b.encounter.start_time));
    if (!quota) {
      for (const it of sorted) add(1, 'error', it, pid, `${label(it)}:尚未設定 ${month} 的 ${code} 分配額度`);
      continue;
    }
    sorted.forEach((it, i) => {
      if (used + i + 1 > quota.allowed_count) {
        add(1, 'error', it, pid, `${label(it)}:超過 ${month} ${code} 額度(額度 ${quota.allowed_count} 次,已用 ${used + i} 次)`);
      }
    });
  }

  // 7 重複申報偵測:同個案同日同代碼不得重複(已送出者優先保留,候選中較晚建立者為重複)
  const seen = new Map<string, LtcItem>();
  for (const s of input.submitted) seen.set(`${s.encounter.patient_id}|${s.encounter.service_date}|${s.encounter.service_code ?? ''}`, s);
  const cands = input.candidates.slice().sort((a, b) => a.encounter.created_at.localeCompare(b.encounter.created_at));
  for (const it of cands) {
    if (!it.encounter.service_code) continue;
    const k = `${it.encounter.patient_id}|${it.encounter.service_date}|${it.encounter.service_code}`;
    if (seen.has(k)) add(7, 'error', it, it.encounter.patient_id, `${label(it)}:同個案同日同代碼已有一筆申報紀錄,不得重複申報`);
    else seen.set(k, it);
  }

  return issues.sort((a, b) => Number(a.severity === 'error' ? 0 : a.severity === 'warn' ? 1 : 2) - Number(b.severity === 'error' ? 0 : b.severity === 'warn' ? 1 : 2) || a.check - b.check);
}

/** 依紀錄分組:每筆候選是否通過(無 error) */
export function blockedIds(issues: PrecheckIssue[]): Set<string> {
  return new Set(issues.filter((i) => i.severity === 'error' && i.encounter_id).map((i) => i.encounter_id as string));
}

// ───────────── 額度餘額儀表板 ─────────────

export interface QuotaBalance {
  patient_id: string;
  quota_month: string;
  service_code: string;
  allowed: number;
  used: number;
  remaining: number;
  /** 已用比例(0–1+),供「接近上限」提示 */
  ratio: number;
}

/** 各額度已使用次數(以已簽章或已送出、最新版本的紀錄計) */
export function quotaBalances(quotas: LtcQuota[], items: LtcItem[], month?: string): QuotaBalance[] {
  return quotas
    .filter((q) => !month || q.quota_month === month)
    .map((q) => {
      const used = items.filter((it) => it.encounter.patient_id === q.patient_id && it.record?.quota_month === q.quota_month && it.encounter.service_code === q.service_code).length;
      return { patient_id: q.patient_id, quota_month: q.quota_month, service_code: q.service_code, allowed: q.allowed_count, used, remaining: q.allowed_count - used, ratio: q.allowed_count === 0 ? (used > 0 ? 2 : 0) : used / q.allowed_count };
    })
    .sort((a, b) => a.quota_month.localeCompare(b.quota_month) || a.patient_id.localeCompare(b.patient_id) || a.service_code.localeCompare(b.service_code));
}

// ───────────── 提醒:每月 1 日上傳、6 個月死線、FA400 ─────────────

export interface LtcReminder {
  severity: Severity;
  message: string;
}

/** 待申報紀錄(已簽章、尚未送出)的死線倒數 */
export function deadlines(items: LtcItem[], today: string): { encounter_id: string; patient_id: string; service_date: string; deadline: string; days_left: number }[] {
  return items
    .filter((it) => it.encounter.status === 'signed')
    .map((it) => {
      const deadline = addMonths(it.encounter.service_date, 6);
      return { encounter_id: it.encounter.id, patient_id: it.encounter.patient_id, service_date: it.encounter.service_date, deadline, days_left: daysBetween(today, deadline) };
    })
    .sort((a, b) => a.days_left - b.days_left);
}

export function ltcReminders(today: string, pending: LtcItem[], plans: LtcPlan[]): LtcReminder[] {
  const out: LtcReminder[] = [];
  const thisMonth = monthOf(today);
  // 可上傳:申報年月 ≤ 本月
  const ready = pending.filter((it) => it.encounter.status === 'signed' && it.record?.quota_month && it.record.quota_month <= thisMonth);
  if (ready.length > 0) {
    const first = today.slice(8, 10) === '01';
    out.push({ severity: first ? 'warn' : 'notice', message: `${first ? '今天是 1 日,' : ''}有 ${ready.length} 筆 ${prevMonth(thisMonth)} 服務的紀錄可以上傳(FA100)` });
  }
  const dl = deadlines(pending, today);
  const expired = dl.filter((d) => d.days_left < 0);
  const soon = dl.filter((d) => d.days_left >= 0 && d.days_left <= 30);
  if (expired.length) out.push({ severity: 'error', message: `${expired.length} 筆紀錄已逾 6 個月死線,照管系統會刪除待申報紀錄` });
  if (soon.length) out.push({ severity: 'warn', message: `${soon.length} 筆紀錄 30 天內到 6 個月死線(最近:${soon[0]!.deadline},剩 ${soon[0]!.days_left} 天)` });
  const fa400 = plans.filter((p) => p.status !== 'active' && !p.fa400_done_at);
  if (fa400.length) out.push({ severity: 'warn', message: `${fa400.length} 位個案已標記中途結案/移居,尚未完成 FA400 提前結案設定` });
  return out;
}

// ───────────── QD110 匯出整理(格式層待官方規範) ─────────────

export interface Qd110Row {
  patient_name: string;
  birth_date: string;
  service_date: string;
  start_time: string;
  end_time: string;
  service_code: string;
  quota_month: string;
  unit_amount: number;
  executed_content: string;
  completion: string;
  /** 照管系統個案識別(身分證字號等)尚未納入本系統資料,留空待補 */
  national_id: '';
}

/**
 * 整理成 QD110 匯入所需的資料列。**自費紀錄一律排除**(CLAUDE.md C3):
 * 只收長照軌服務、已簽章或已送出、且個案軌別含長照者。
 */
export function qd110Rows(items: LtcItem[], patients: Patient[]): Qd110Row[] {
  const rows: Qd110Row[] = [];
  for (const it of items) {
    const e = it.encounter;
    if (e.track !== 'ltc' || e.signed_at === null || !it.record) continue;
    const p = patients.find((x) => x.id === e.patient_id);
    if (!p || p.track === 'self_pay') continue;
    rows.push({
      patient_name: p.name, birth_date: p.birth_date, service_date: e.service_date, start_time: e.start_time, end_time: e.end_time,
      service_code: e.service_code ?? '', quota_month: it.record.quota_month ?? '', unit_amount: LTC_CODES[e.service_code ?? '']?.unit_amount ?? 0,
      executed_content: it.record.executed_content ?? '', completion: it.record.completion ?? '', national_id: '',
    });
  }
  return rows.sort((a, b) => a.service_date.localeCompare(b.service_date) || a.start_time.localeCompare(b.start_time));
}

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * 草稿格式 CSV(**不是官方 QD110**):欄位對照待向照管平台客服取得規範後補上(TASKS 3.6)。
 * 首行註明,避免被誤當成正式檔案上傳。
 */
export function qd110DraftCsv(rows: Qd110Row[]): string {
  const head = ['個案姓名', '生日', '身分證字號(待補)', '服務日期', '開始', '結束', '服務代碼', '申報年月', '單價', '執行內容', '完成度'];
  const body = rows.map((r) => [r.patient_name, r.birth_date, r.national_id, r.service_date, r.start_time, r.end_time, r.service_code, r.quota_month, r.unit_amount, r.executed_content, r.completion]);
  return ['# 草稿格式,非官方 QD110;欄位須依照管平台規範調整後才能匯入', head, ...body].map((l) => (typeof l === 'string' ? l : l.map(csvCell).join(','))).join('\n');
}

