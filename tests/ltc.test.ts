import { describe, expect, it } from 'vitest';
import {
  addMonths, blockedIds, canCorrect, canTransition, daysBetween, deadlines, ltcReminders, nextMonth, precheck, prevMonth, qd110DraftCsv, qd110Rows, quotaBalances,
  type LtcContext, type LtcItem, type PrecheckInput,
} from '../src/shared/ltc';
import type { Encounter, LtcContract, LtcPlan, LtcQuota, LtcRecord, LtcStaff, LtcSuspension, Patient } from '../src/shared/schema';

const T = '2026-01-01T00:00:00.000+08:00';
const patient: Patient = {
  id: 'p1', name: '王大明', birth_date: '1945-01-01', gender: null, phone: null, address: null, emergency_contact: null, track: 'ltc', ltc_level: 4,
  referral_doc: null, referral_required: false, precautions: null, history_note: null, created_at: T, updated_at: T, archived_at: null,
};
const enc = (id: string, over: Partial<Encounter> = {}): Encounter => ({
  id, patient_id: 'p1', track: 'ltc', service_date: '2026-10-10', start_time: '09:00', end_time: '10:00', service_code: 'CA07', location: 'home',
  status: 'signed', signed_at: T, version: 1, supersedes_id: null, no_show: null, no_show_photo: null, gps: null, created_at: `2026-10-10T10:0${id.slice(-1)}:00.000+08:00`, updated_at: T, ...over,
});
const rec = (encId: string, over: Partial<LtcRecord> = {}): LtcRecord => ({
  id: `r-${encId}`, encounter_id: encId, care_goal_id: 'g1', staff_id: 's1', executed_content: '平衡訓練', completion: '完成 80%', feedback: null, quota_month: '2026-11',
  submission_status: 0, created_at: T, updated_at: T, ...over,
});
const item = (id: string, e: Partial<Encounter> = {}, r: Partial<LtcRecord> | null = {}): LtcItem => ({ encounter: enc(id, e), record: r === null ? null : rec(id, r) });

const contract: LtcContract = { id: 'c1', name: '特約', start_date: '2026-01-01', end_date: '2026-12-31', created_at: T, updated_at: T };
const staff: LtcStaff = { id: 's1', name: '陳治療師', profession: 'PT', ltc_level: 2, valid_from: '2025-01-01', valid_to: '2027-12-31', created_at: T, updated_at: T };
const plan: LtcPlan = { id: 'pl1', patient_id: 'p1', start_date: '2026-01-01', end_date: '2026-12-31', status: 'active', closed_at: null, fa400_done_at: null, note: null, created_at: T, updated_at: T };
const quota: LtcQuota = { id: 'q1', patient_id: 'p1', quota_month: '2026-11', service_code: 'CA07', allowed_count: 3, created_at: T, updated_at: T };

const goodCtx = (): LtcContext => ({ contracts: [contract], staff: [staff], plans: [plan], quotas: [quota], suspensions: [], patients: [patient] });
const run = (over: Partial<PrecheckInput> = {}) => precheck({ today: '2026-11-05', candidates: [item('e1')], submitted: [], context: goodCtx(), ...over });
const checks = (issues: ReturnType<typeof run>, severity?: string) => issues.filter((i) => !severity || i.severity === severity).map((i) => i.check);

describe('預檢引擎:正常資料', () => {
  it('完全正確的紀錄沒有任何問題', () => {
    expect(run()).toEqual([]);
  });
});

describe('預檢 1 額度檢查', () => {
  it('超過分配額度者被攔下(依服務日期先後計入)', () => {
    const cands = ['e1', 'e2', 'e3', 'e4'].map((id, i) => item(id, { service_date: `2026-10-0${i + 1}` }));
    const issues = run({ candidates: cands });
    expect(checks(issues, 'error')).toEqual([1]);
    expect(issues[0]!.encounter_id).toBe('e4');
    expect(issues[0]!.message).toContain('額度 3 次,已用 3 次');
  });
  it('已送出的紀錄也計入已用額度', () => {
    const submitted = [item('s1', { service_date: '2026-10-01', status: 'submitted' }), item('s2', { service_date: '2026-10-02', status: 'submitted' })];
    const issues = run({ candidates: [item('e1', { service_date: '2026-10-05' }), item('e2', { service_date: '2026-10-06' })], submitted });
    expect(issues.filter((i) => i.check === 1).map((i) => i.encounter_id)).toEqual(['e2']);
  });
  it('沒有設定該月該代碼額度 → 錯誤;其他代碼/月份的額度不通用', () => {
    expect(checks(run({ context: { ...goodCtx(), quotas: [] } }), 'error')).toEqual([1]);
    expect(checks(run({ context: { ...goodCtx(), quotas: [{ ...quota, service_code: 'CC01' }] } }), 'error')).toEqual([1]);
    expect(checks(run({ context: { ...goodCtx(), quotas: [{ ...quota, quota_month: '2026-12' }] } }), 'error')).toEqual([1]);
  });
  it('額度 0 次一筆都不能報', () => {
    expect(checks(run({ context: { ...goodCtx(), quotas: [{ ...quota, allowed_count: 0 }] } }), 'error')).toEqual([1]);
  });
});

describe('預檢 2 特約有效期間', () => {
  it('服務日期不在特約內 / 未設定特約', () => {
    expect(checks(run({ candidates: [item('e1', { service_date: '2027-01-02' }, { quota_month: '2027-02' })], today: '2027-02-05', context: { ...goodCtx(), quotas: [{ ...quota, quota_month: '2027-02' }], plans: [{ ...plan, end_date: '2027-12-31' }] } }), 'error')).toEqual([2]);
    expect(checks(run({ context: { ...goodCtx(), contracts: [] } }), 'error')).toEqual([2]);
  });
  it('起訖當日含在內', () => {
    expect(run({ candidates: [item('e1', { service_date: '2026-12-31' }, { quota_month: '2027-01' })], today: '2027-01-05', context: { ...goodCtx(), quotas: [{ ...quota, quota_month: '2027-01' }], plans: [{ ...plan, end_date: '2027-12-31' }] } }).filter((i) => i.check === 2)).toEqual([]);
  });
});

describe('預檢 3 人員資格', () => {
  it('找不到人員、資格過期、尚未生效、Level 不足', () => {
    expect(checks(run({ candidates: [item('e1', {}, { staff_id: 'nope' })] }), 'error')).toEqual([3]);
    expect(checks(run({ context: { ...goodCtx(), staff: [{ ...staff, valid_to: '2026-09-30' }] } }), 'error')).toEqual([3]);
    expect(checks(run({ context: { ...goodCtx(), staff: [{ ...staff, valid_from: '2026-10-11' }] } }), 'error')).toEqual([3]);
    expect(run({ context: { ...goodCtx(), staff: [{ ...staff, ltc_level: 1 }] } }).filter((i) => i.check === 3)).toEqual([]); // CA07 假設 Level 1 即可
  });
  it('代碼需要的 Level 高於人員 Level 時被攔下(以 CC01 min_level 驗證邏輯)', async () => {
    const mod = await import('../src/shared/ltc');
    const saved = mod.LTC_CODES.CA07!.min_level;
    mod.LTC_CODES.CA07!.min_level = 3;
    try {
      const issues = run();
      expect(issues.filter((i) => i.check === 3)).toHaveLength(1);
      expect(issues.find((i) => i.check === 3)!.message).toContain('需要 Level 3 以上');
    } finally {
      mod.LTC_CODES.CA07!.min_level = saved;
    }
  });
  it('valid_to 為空表示長期有效', () => {
    expect(run({ context: { ...goodCtx(), staff: [{ ...staff, valid_to: null }] } })).toEqual([]);
  });
});

describe('預檢 4 計畫有效區間', () => {
  it('沒有計畫 / 日期在計畫外', () => {
    expect(checks(run({ context: { ...goodCtx(), plans: [] } }), 'error')).toEqual([4]);
    expect(checks(run({ context: { ...goodCtx(), plans: [{ ...plan, start_date: '2026-10-11' }] } }), 'error')).toEqual([4]);
    expect(checks(run({ context: { ...goodCtx(), plans: [{ ...plan, patient_id: 'other' }] } }), 'error')).toEqual([4]); // 別人的計畫不算
  });
});

describe('預檢 5 暫停服務區間', () => {
  const susp: LtcSuspension = { id: 'x1', patient_id: 'p1', start_date: '2026-10-05', end_date: '2026-10-15', reason: '住院', created_at: T, updated_at: T };
  it('落在暫停期間內被攔下,含起訖當日;區間外通過;別人的暫停不影響', () => {
    expect(checks(run({ context: { ...goodCtx(), suspensions: [susp] } }), 'error')).toEqual([5]);
    expect(run({ candidates: [item('e1', { service_date: '2026-10-05' })], context: { ...goodCtx(), suspensions: [susp] } }).some((i) => i.check === 5)).toBe(true);
    expect(run({ candidates: [item('e1', { service_date: '2026-10-15' })], context: { ...goodCtx(), suspensions: [susp] } }).some((i) => i.check === 5)).toBe(true);
    expect(run({ candidates: [item('e1', { service_date: '2026-10-16' })], context: { ...goodCtx(), suspensions: [susp] } }).some((i) => i.check === 5)).toBe(false);
    expect(run({ context: { ...goodCtx(), suspensions: [{ ...susp, patient_id: 'other' }] } })).toEqual([]);
  });
});

describe('預檢 6 時間邏輯', () => {
  it('14:00~14:00 與結束早於開始 → 錯誤', () => {
    expect(checks(run({ candidates: [item('e1', { start_time: '14:00', end_time: '14:00' })] }), 'error')).toEqual([6]);
    expect(checks(run({ candidates: [item('e1', { start_time: '15:00', end_time: '14:00' })] }), 'error')).toEqual([6]);
  });
  it('過短或過長 → 警告(不擋)', () => {
    const a = run({ candidates: [item('e1', { start_time: '14:00', end_time: '14:10' })] });
    expect(checks(a)).toEqual([6]);
    expect(a[0]!.severity).toBe('warn');
    expect(run({ candidates: [item('e1', { start_time: '08:00', end_time: '13:00' })] })[0]!.severity).toBe('warn');
    expect(blockedIds(a).size).toBe(0);
  });
});

describe('預檢 7 重複申報偵測', () => {
  it('同個案同日同代碼:候選內重複、與已送出重複都被攔下;不同代碼或不同日不算', () => {
    const dup = run({ candidates: [item('e1'), item('e2', { start_time: '14:00', end_time: '15:00' })] });
    expect(dup.filter((i) => i.check === 7).map((i) => i.encounter_id)).toEqual(['e2']);
    const withSubmitted = run({ candidates: [item('e1')], submitted: [item('s1', { status: 'submitted' })] });
    expect(withSubmitted.filter((i) => i.check === 7)).toHaveLength(1);
    expect(run({ candidates: [item('e1'), item('e2', { service_code: 'CC01' })], context: { ...goodCtx(), quotas: [quota, { ...quota, id: 'q2', service_code: 'CC01' }] } }).some((i) => i.check === 7)).toBe(false);
    expect(run({ candidates: [item('e1'), item('e2', { service_date: '2026-10-11' })] }).some((i) => i.check === 7)).toBe(false);
  });
});

describe('預檢 8 中途結案偵測(FA400)', () => {
  it('標記中途結案/移居且尚未完成 FA400 → 提示;完成後不再提示', () => {
    const closed = { ...goodCtx(), plans: [{ ...plan, status: 'closed_early' as const, closed_at: '2026-10-20' }] };
    const a = run({ context: closed });
    expect(a.filter((i) => i.check === 8)).toHaveLength(1);
    expect(a.find((i) => i.check === 8)!.severity).toBe('notice');
    expect(a.find((i) => i.check === 8)!.message).toContain('FA400');
    expect(run({ context: { ...closed, plans: [{ ...closed.plans[0]!, status: 'moved', fa400_done_at: '2026-10-25' }] } }).some((i) => i.check === 8)).toBe(false);
    expect(run({ context: { ...closed, plans: [{ ...closed.plans[0]!, status: 'moved' }] } }).find((i) => i.check === 8)!.message).toContain('移居');
  });
});

describe('預檢 9–11:申報時序、6 個月死線、必填欄位', () => {
  it('9:申報年月不得早於/等於服務年月;未到 1 日不可上傳;非次月為警告', () => {
    expect(checks(run({ candidates: [item('e1', {}, { quota_month: '2026-10' })], context: { ...goodCtx(), quotas: [{ ...quota, quota_month: '2026-10' }] } }), 'error')).toEqual([9]);
    expect(checks(run({ today: '2026-10-31' }), 'error')).toEqual([9]); // 11/1 才可上傳
    expect(run({ today: '2026-11-01' })).toEqual([]);
    const late = run({ candidates: [item('e1', {}, { quota_month: '2026-12' })], today: '2026-12-02', context: { ...goodCtx(), quotas: [{ ...quota, quota_month: '2026-12' }] } });
    expect(late.filter((i) => i.check === 9).map((i) => i.severity)).toEqual(['warn']);
  });
  it('10:逾 6 個月為錯誤,30 天內為警告', () => {
    expect(checks(run({ candidates: [item('e1', { service_date: '2026-03-31' }, { quota_month: '2026-04' })], today: '2026-10-05', context: { ...goodCtx(), quotas: [{ ...quota, quota_month: '2026-04' }] } }), 'error')).toEqual([10]);
    const near = run({ candidates: [item('e1', { service_date: '2026-04-20' }, { quota_month: '2026-05' })], today: '2026-10-05', context: { ...goodCtx(), quotas: [{ ...quota, quota_month: '2026-05' }] } });
    expect(near.filter((i) => i.check === 10).map((i) => i.severity)).toEqual(['warn']);
  });
  it('11:缺必填欄位(照顧目標、執行內容、完成度、申報年月、人員、代碼、整筆長照紀錄)', () => {
    const miss = (r: Partial<LtcRecord>) => run({ candidates: [item('e1', {}, r)] }).find((i) => i.check === 11)?.message ?? '';
    expect(miss({ care_goal_id: null })).toContain('照顧目標');
    expect(miss({ executed_content: ' ' })).toContain('本次目標執行內容');
    expect(miss({ completion: null })).toContain('完成度');
    expect(miss({ staff_id: null })).toContain('服務人員');
    expect(run({ candidates: [item('e1', {}, null)] }).find((i) => i.check === 11)!.message).toContain('長照申報紀錄');
    expect(run({ candidates: [item('e1', { service_code: null })] }).find((i) => i.check === 11)!.message).toContain('服務代碼');
  });
});

describe('預檢整體:刻意製造多種錯誤一次攔下', () => {
  it('每種錯誤各自被抓到,且回報順序為 error → warn → notice', () => {
    const issues = run({
      candidates: [
        item('e1', { start_time: '14:00', end_time: '14:00', service_date: '2027-03-01' }, { staff_id: 'nope', quota_month: '2026-11' }),
        item('e2', { service_date: '2026-10-12' }),
        item('e3', { service_date: '2026-10-12', start_time: '13:00', end_time: '14:00' }),
      ],
      context: { ...goodCtx(), plans: [{ ...plan, status: 'moved', closed_at: '2026-10-30' }], suspensions: [{ id: 'x', patient_id: 'p1', start_date: '2026-10-12', end_date: '2026-10-12', reason: null, created_at: T, updated_at: T }] },
    });
    const got = new Set(issues.map((i) => i.check));
    for (const c of [2, 3, 4, 5, 6, 7, 8, 9]) expect(got.has(c), `check ${c}`).toBe(true);
    const sev = issues.map((i) => i.severity);
    expect(sev).toEqual([...sev].sort((a, b) => ['error', 'warn', 'notice'].indexOf(a) - ['error', 'warn', 'notice'].indexOf(b)));
    expect(blockedIds(issues).has('e2')).toBe(true);
  });
});

describe('申報狀態機', () => {
  it('只可前進一格;狀態 2–5 可退回 1(縣市承辦退件);6 為終態', () => {
    for (let s = 0; s < 6; s++) expect(canTransition(s, s + 1)).toBe(true);
    expect(canTransition(0, 2)).toBe(false);
    expect(canTransition(1, 3)).toBe(false);
    expect(canTransition(3, 2)).toBe(false);
    expect(canTransition(2, 1)).toBe(true);
    expect(canTransition(5, 1)).toBe(true);
    expect(canTransition(1, 1)).toBe(false);
    expect(canTransition(0, 1)).toBe(true);
    expect(canTransition(6, 1)).toBe(false);
    expect(canTransition(6, 7)).toBe(false);
    expect(canTransition(0, 0)).toBe(false);
  });
  it('僅狀態 1 可修正', () => {
    expect([0, 1, 2, 3, 4, 5, 6].filter(canCorrect)).toEqual([1]);
  });
});

describe('日期、死線、額度餘額、提醒', () => {
  it('月份與日期運算(含跨年、月底)', () => {
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(prevMonth('2026-01')).toBe('2025-12');
    expect(addMonths('2026-08-31', 6)).toBe('2027-02-28');
    expect(addMonths('2026-10-10', 6)).toBe('2027-04-10');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
  });
  it('死線倒數:只算已簽章待申報者,由近到遠', () => {
    const d = deadlines([item('e1', { service_date: '2026-04-20' }), item('e2', { service_date: '2026-06-01' }), item('e3', { service_date: '2026-04-01', status: 'submitted' })], '2026-10-01');
    expect(d.map((x) => [x.encounter_id, x.days_left])).toEqual([['e1', 19], ['e2', 61]]);
  });
  it('額度餘額與接近上限比例', () => {
    const b = quotaBalances([quota], [item('e1'), item('e2', { service_date: '2026-10-11' })]);
    expect(b).toEqual([{ patient_id: 'p1', quota_month: '2026-11', service_code: 'CA07', allowed: 3, used: 2, remaining: 1, ratio: 2 / 3 }]);
    expect(quotaBalances([quota], [], '2026-12')).toEqual([]);
  });
  it('每月 1 日提醒上傳;其他日為一般提示;死線與 FA400 提醒', () => {
    const pending = [item('e1'), item('e2', { service_date: '2026-04-20' }, { quota_month: '2026-05' })];
    const first = ltcReminders('2026-11-01', pending, []);
    expect(first[0]!.message).toContain('今天是 1 日');
    expect(first.some((r) => r.severity === 'error' && r.message.includes('逾 6 個月'))).toBe(true);
    const mid = ltcReminders('2026-11-15', [item('e1')], []);
    expect(mid[0]).toMatchObject({ severity: 'notice' });
    expect(mid[0]!.message).not.toContain('今天是 1 日');
    expect(ltcReminders('2026-10-05', [item('e1')], [])).toEqual([]); // 尚未到申報月:無提醒
    expect(ltcReminders('2026-11-15', [], [{ ...plan, status: 'moved' }]).some((r) => r.message.includes('FA400'))).toBe(true);
  });
});

describe('QD110 整理(3.6):自費紀錄自動排除', () => {
  it('只含長照軌、已簽章、個案軌別含長照者', () => {
    const selfPay = item('e9', { track: 'self_pay', service_code: null }, null);
    const selfPayPatient: Patient = { ...patient, id: 'p2', name: '自費個案', track: 'self_pay' };
    const wrongPatientTrack = item('e8', { patient_id: 'p2' }); // 長照服務卻掛在自費個案:不應匯出
    const draft = item('e7', { signed_at: null, status: 'draft' });
    const rows = qd110Rows([item('e1'), selfPay, wrongPatientTrack, draft], [patient, selfPayPatient]);
    expect(rows.map((r) => r.patient_name)).toEqual(['王大明']);
    expect(rows[0]).toMatchObject({ service_code: 'CA07', unit_amount: 1500, quota_month: '2026-11', national_id: '' });
  });
  it('草稿格式 CSV:首行聲明非官方、欄位值含逗號/引號時正確跳脫', () => {
    const csv = qd110DraftCsv(qd110Rows([item('e1', {}, { executed_content: '平衡,"站立"訓練' })], [patient]));
    expect(csv.split('\n')[0]).toContain('非官方 QD110');
    expect(csv).toContain('"平衡,""站立""訓練"');
    expect(csv.split('\n')).toHaveLength(3);
  });
});
