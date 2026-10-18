import { describe, expect, it } from 'vitest';
import { acceptRow } from '../src/shared/rules';
import { SqliteRepo } from '../src/server/db';
import { DataService } from '../src/shared/service';
import { fakeClock, newIdb, patientInput, seqIds, type RepoHandle } from './helpers';

const factories: [string, () => Promise<RepoHandle>][] = [['SQLite', async () => ({ name: 's', repo: new SqliteRepo(':memory:'), close: () => undefined })], ['IndexedDB', () => newIdb()]];

describe.each(factories)('P3 長照核銷服務層 — %s', (_n, make) => {
  async function setup() {
    const h = await make();
    const svc = new DataService({ repo: h.repo, newId: seqIds(), now: fakeClock('2026-10-01T09:00:00+08:00') });
    const p = await svc.createPatient({ ...patientInput, name: '長照甲', track: 'ltc', ltc_level: 4, referral_required: false });
    const goal = await svc.createGoal({ patient_id: p.id, description: '增加步行距離' });
    const staff = await svc.createLtc('ltc_staff', { name: '陳治療師', profession: 'PT', ltc_level: 2, valid_from: '2025-01-01', valid_to: null });
    await svc.createLtc('ltc_contracts', { name: '特約', start_date: '2026-01-01', end_date: '2026-12-31' });
    await svc.createLtc('ltc_plans', { patient_id: p.id, start_date: '2026-01-01', end_date: '2026-12-31', status: 'active', closed_at: null, fa400_done_at: null, note: null });
    await svc.createLtc('ltc_quotas', { patient_id: p.id, quota_month: '2026-11', service_code: 'CA07', allowed_count: 2 });
    return { h, svc, p, goal, staff };
  }

  async function visit(s: Awaited<ReturnType<typeof setup>>, date: string, over: { code?: string; quota_month?: string } = {}) {
    const e = await s.svc.createEncounter({ patient_id: s.p.id, track: 'ltc', service_date: date, start_time: '09:00', end_time: '10:00', service_code: over.code ?? 'CA07', location: 'home' });
    await s.svc.saveLtcRecord(e.id, { care_goal_id: s.goal.id, staff_id: s.staff.id, executed_content: '步行訓練', completion: '完成 80%', feedback: null, quota_month: over.quota_month ?? s.svc.defaultQuotaMonth(date) });
    return s.svc.signEncounter(e.id);
  }

  it('長照簽章需有必填欄位(代碼、目標、內容、完成度、申報年月、人員)', async () => {
    const s = await setup();
    const e = await s.svc.createEncounter({ patient_id: s.p.id, track: 'ltc', service_date: '2026-10-05', start_time: '09:00', end_time: '10:00' });
    await expect(s.svc.signEncounter(e.id)).rejects.toThrow('簽章前請先填寫:服務代碼、長照申報紀錄');
    await s.svc.updateEncounter(e.id, { service_code: 'CA07' });
    await s.svc.saveLtcRecord(e.id, { care_goal_id: null, staff_id: null, executed_content: '', completion: null, feedback: null, quota_month: null });
    await expect(s.svc.signEncounter(e.id)).rejects.toThrow('照顧目標、本次目標執行內容、完成度、申報年月、服務人員');
    await s.svc.saveLtcRecord(e.id, { care_goal_id: s.goal.id, staff_id: s.staff.id, executed_content: 'x', completion: '80%', feedback: null, quota_month: s.svc.defaultQuotaMonth('2026-10-05') });
    await expect(s.svc.signEncounter(e.id)).resolves.toMatchObject({ status: 'signed' });
  });

  it('預檢:通過才能標記已上傳;超額度被擋、未標記任何一筆', async () => {
    const s = await setup();
    const a = await visit(s, '2026-10-05');
    const b = await visit(s, '2026-10-12');
    const c = await visit(s, '2026-10-19'); // 額度只有 2 次
    const r = await s.svc.runPrecheck({ today: '2026-11-01' });
    expect(r.issues.filter((i) => i.severity === 'error').map((i) => [i.check, i.encounter_id])).toEqual([[1, c.id]]);
    await expect(s.svc.markSubmitted([a.id, b.id, c.id], '2026-11-01')).rejects.toThrow('預檢未通過:1 筆有錯誤');
    expect((await s.svc.getEncounter(a.id))?.status).toBe('signed'); // 全部未動
    // 單獨檢查第 3 筆也要判超額(前兩筆雖未送出,仍占用額度)
    expect((await s.svc.runPrecheck({ today: '2026-11-01', encounterIds: [c.id] })).issues.some((i) => i.check === 1)).toBe(true);
    // 單獨檢查前兩筆則通過
    expect((await s.svc.runPrecheck({ today: '2026-11-01', encounterIds: [a.id] })).issues.filter((i) => i.severity === 'error')).toEqual([]);
    await expect(s.svc.markSubmitted([a.id, b.id], '2026-10-31')).rejects.toThrow('預檢未通過'); // 尚未到 11/1
    const done = await s.svc.markSubmitted([a.id, b.id], '2026-11-01');
    expect(done.map((x) => x.status)).toEqual(['submitted', 'submitted']);
    // 已送出者計入額度:額度滿了,c 仍超額
    expect((await s.svc.runPrecheck({ today: '2026-11-01' })).issues.some((i) => i.check === 1 && i.encounter_id === c.id)).toBe(true);
  });

  it('只有已簽章未送出的長照紀錄可上傳;草稿與重複上傳被拒', async () => {
    const s = await setup();
    const draft = await s.svc.createEncounter({ patient_id: s.p.id, track: 'ltc', service_date: '2026-10-05', start_time: '09:00', end_time: '10:00', service_code: 'CA07' });
    await expect(s.svc.markSubmitted([draft.id], '2026-11-01')).rejects.toThrow('只有已簽章');
    const a = await visit(s, '2026-10-06');
    await s.svc.markSubmitted([a.id], '2026-11-01');
    await expect(s.svc.markSubmitted([a.id], '2026-11-01')).rejects.toThrow('只有已簽章');
  });

  it('申報狀態機:只能前進一格;退件回到 1;終態不可再動;未送出不能記錄', async () => {
    const s = await setup();
    const a = await visit(s, '2026-10-05');
    await expect(s.svc.advanceSubmission(a.id, 1)).rejects.toThrow('請先送出申報');
    await s.svc.markSubmitted([a.id], '2026-11-01');
    expect((await s.svc.getLtcRecord(a.id))?.submission_status).toBe(0);
    await expect(s.svc.advanceSubmission(a.id, 2)).rejects.toThrow('只能前進一格');
    for (const to of [1, 2, 3]) await s.svc.advanceSubmission(a.id, to);
    await expect(s.svc.advanceSubmission(a.id, 2)).rejects.toThrow('只能前進一格'); // 不能後退
    expect((await s.svc.advanceSubmission(a.id, 1)).submission_status).toBe(1); // 縣市退件
    for (const to of [2, 3, 4, 5, 6]) await s.svc.advanceSubmission(a.id, to);
    await expect(s.svc.advanceSubmission(a.id, 1)).rejects.toThrow('只能前進一格'); // 6 為終態
  });

  it('簽章後長照內容仍鎖定,但可更新申報狀態;不能直接寫入非法狀態', async () => {
    const s = await setup();
    const a = await visit(s, '2026-10-05');
    await expect(s.svc.saveLtcRecord(a.id, { care_goal_id: s.goal.id, staff_id: s.staff.id, executed_content: '改', completion: 'x', feedback: null, quota_month: '2026-11' })).rejects.toThrow('簽章鎖定');
    await s.svc.markSubmitted([a.id], '2026-11-01');
    const rec = (await s.svc.getLtcRecord(a.id))!;
    // 狀態與內容一起改 → 內容鎖定
    expect(await acceptRow(s.h.repo, 'ltc_records', { ...rec, submission_status: 1, executed_content: '竄改', updated_at: '2099-01-01T00:00:00.000+08:00' })).toMatchObject({ applied: false, reject: 'locked' });
    // 跳級 → 拒絕
    expect(await acceptRow(s.h.repo, 'ltc_records', { ...rec, submission_status: 3, updated_at: '2099-01-01T00:00:00.000+08:00' })).toMatchObject({ applied: false, reject: 'invalid' });
    // 未送出的服務不可有非 0 狀態
    const b = await visit(s, '2026-10-12');
    const brec = (await s.svc.getLtcRecord(b.id))!;
    expect(await acceptRow(s.h.repo, 'ltc_records', { ...brec, submission_status: 1, updated_at: '2099-01-01T00:00:00.000+08:00' })).toMatchObject({ applied: false });
  });

  it('修正已送出的紀錄:僅狀態 1 可建立新版本;新版本需重新簽章與預檢,舊版不重複計入額度', async () => {
    const s = await setup();
    const a = await visit(s, '2026-10-05');
    await visit(s, '2026-10-12');
    const ids = (await s.svc.runPrecheck({ today: '2026-11-01' })).candidates.map((c) => c.encounter.id);
    await s.svc.markSubmitted(ids, '2026-11-01');
    await expect(s.svc.reviseEncounter(a.id)).rejects.toThrow('僅在狀態 1');
    await s.svc.advanceSubmission(a.id, 1);
    const v2 = await s.svc.reviseEncounter(a.id);
    expect(v2).toMatchObject({ version: 2, status: 'draft', supersedes_id: a.id });
    expect((await s.svc.getLtcRecord(v2.id))).toMatchObject({ submission_status: 0, executed_content: '步行訓練' });
    await s.svc.saveLtcRecord(v2.id, { care_goal_id: s.goal.id, staff_id: s.staff.id, executed_content: '更正後的內容', completion: '完成 90%', feedback: null, quota_month: '2026-11' });
    await s.svc.signEncounter(v2.id);
    // 預檢只看最新版:額度 2 次 = 舊 b(已送出)+ 新 v2,沒有把被取代的舊版 a 再算一次
    const pre = await s.svc.runPrecheck({ today: '2026-11-02' });
    expect(pre.issues.filter((i) => i.severity === 'error')).toEqual([]);
    await s.svc.markSubmitted([v2.id], '2026-11-02');
    expect((await s.svc.ltcItems()).map((i) => i.encounter.version).sort()).toEqual([1, 2]); // 舊版 a 已被取代,只剩 b(v1) 與 v2
  });

  it('核銷資料與自費資料隔離:自費個案的服務不出現在長照清單', async () => {
    const s = await setup();
    await visit(s, '2026-10-05');
    const sp = await s.svc.createPatient({ ...patientInput, name: '自費乙' });
    await s.svc.startVisit({ patient_id: sp.id, service_date: '2026-10-05', start_time: '09:00', end_time: '10:00' });
    const items = await s.svc.ltcItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.encounter.patient_id).toBe(s.p.id);
  });

  it('設定資料驗證:日期格式、起訖順序、個案存在、計畫結案欄位', async () => {
    const s = await setup();
    await expect(s.svc.createLtc('ltc_contracts', { name: 'x', start_date: '2026-13-01', end_date: '2026-12-31' })).rejects.toThrow('日期格式');
    await expect(s.svc.createLtc('ltc_contracts', { name: 'x', start_date: '2026-12-31', end_date: '2026-01-01' })).rejects.toThrow('結束日期不可早於開始日期');
    await expect(s.svc.createLtc('ltc_quotas', { patient_id: s.p.id, quota_month: '2026/11', service_code: 'CA07', allowed_count: 1 })).rejects.toThrow('YYYY-MM');
    await expect(s.svc.createLtc('ltc_quotas', { patient_id: 'nope', quota_month: '2026-11', service_code: 'CC01', allowed_count: 1 })).rejects.toThrow('個案不存在');
    await expect(s.svc.createLtc('ltc_staff', { name: 'x', profession: 'PT', ltc_level: 5, valid_from: '2026-01-01', valid_to: null })).rejects.toThrow('超出範圍');
    await expect(s.svc.createLtc('ltc_staff', { name: 'x', profession: 'PT', ltc_level: 1, valid_from: '2026-05-01', valid_to: '2026-01-01' })).rejects.toThrow('資格結束日期');
    const plan = (await s.svc.listLtc('ltc_plans'))[0]!;
    await expect(s.svc.updateLtc('ltc_plans', plan.id, { status: 'moved' })).rejects.toThrow('須填結案日期');
    await expect(s.svc.updateLtc('ltc_plans', plan.id, { fa400_done_at: '2026-10-10' })).rejects.toThrow('進行中的計畫不可有');
  });

  it('中途結案/移居 → 預檢 #8 提示 → 標記 FA400 完成後不再提示', async () => {
    const s = await setup();
    await visit(s, '2026-10-05');
    const plan = (await s.svc.listLtc('ltc_plans'))[0]!;
    await s.svc.closePlan(plan.id, 'moved', '2026-10-20');
    expect((await s.svc.runPrecheck({ today: '2026-11-01' })).issues.some((i) => i.check === 8)).toBe(true);
    await s.svc.markFa400Done(plan.id, '2026-10-25');
    expect((await s.svc.runPrecheck({ today: '2026-11-01' })).issues.some((i) => i.check === 8)).toBe(false);
  });
});

describe('P3 資料庫層', () => {
  it('SQLite 觸發器:服務已簽章後,直接 UPDATE 只能改申報狀態,不能改內容', async () => {
    const repo = new SqliteRepo(':memory:');
    const svc = new DataService({ repo, newId: seqIds(), now: fakeClock('2026-10-01T09:00:00+08:00') });
    const p = await svc.createPatient({ ...patientInput, track: 'ltc', ltc_level: 3, referral_required: false });
    const goal = await svc.createGoal({ patient_id: p.id, description: 'g' });
    const staff = await svc.createLtc('ltc_staff', { name: 's', profession: 'PT', ltc_level: 1, valid_from: '2025-01-01', valid_to: null });
    const e = await svc.createEncounter({ patient_id: p.id, track: 'ltc', service_date: '2026-10-05', start_time: '09:00', end_time: '10:00', service_code: 'CA07' });
    await svc.saveLtcRecord(e.id, { care_goal_id: goal.id, staff_id: staff.id, executed_content: '內容', completion: '80%', feedback: null, quota_month: '2026-11' });
    await svc.signEncounter(e.id);
    expect(() => repo.db.prepare("UPDATE ltc_records SET executed_content = '竄改', updated_at = '2099-01-01T00:00:00.000+08:00' WHERE encounter_id = ?").run(e.id)).toThrow('已簽章紀錄不可修改');
    expect(() => repo.db.prepare("UPDATE ltc_records SET submission_status = 1, updated_at = '2099-01-01T00:00:00.000+08:00' WHERE encounter_id = ?").run(e.id)).not.toThrow();
    expect(() => repo.db.prepare("UPDATE ltc_records SET quota_month = '2030-01', updated_at = '2099-01-02T00:00:00.000+08:00' WHERE encounter_id = ?").run(e.id)).toThrow('已簽章紀錄不可修改');
  });
});
