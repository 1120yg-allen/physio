import { describe, expect, it } from 'vitest';
import { DatabaseSync } from '../src/server/sqlite';
import { migrate, SqliteRepo } from '../src/server/db';
import { referenceFor, ageOn } from '../src/shared/norms';
import { SEED_TESTS } from '../src/shared/seed';
import { DataService } from '../src/shared/service';
import { emptySoap, parseSoap, prefillFromPrevious, soapMissing, type SoapContent } from '../src/shared/soap';
import { goalPct, goalProgressFor, testsUsedBy, trendFor } from '../src/shared/trend';
import { fakeClock, newIdb, patientInput, seqIds, type RepoHandle } from './helpers';

const strict = (repo: RepoHandle['repo']) => new DataService({ repo, newId: seqIds(), now: fakeClock() });

function content(over: Partial<SoapContent['subjective']> = {}): SoapContent {
  const c = emptySoap();
  c.subjective = { ...c.subjective, chief_complaint: '右膝爬樓梯會痛', nprs: { score: 4, site: ['r_knee'] }, ...over };
  c.objective.interventions = [{ category: 'exercise', item_id: 'ex-sit-stand', dose: { sets: 3, reps: 10, resistance: '2kg', duration: null } }];
  c.objective.measures = [{ test_id: 'test-tug', value: 14, unit: '秒', measured_at: '2026-10-01T10:00:00.000+08:00' }];
  c.objective.vitals.hr = 78;
  c.plan.hep = [{ item_id: 'ex-bridge', dose: { sets: 3, reps: 10, resistance: null, duration: null }, video_ref: null }];
  c.plan.next_focus = '增加坐站次數';
  return c;
}

describe('SOAP 內容(1.2)', () => {
  it('完整 §2.3 欄位可儲存並原樣讀回', async () => {
    const repo = new SqliteRepo(':memory:');
    const svc = strict(repo);
    const p = await svc.createPatient(patientInput);
    const e = await svc.createEncounter({ patient_id: p.id, track: 'self_pay', service_date: '2026-10-01', start_time: '10:00', end_time: '10:45' });
    const c = content();
    c.subjective.borg_rpe = 13;
    c.subjective.flags = { sleep: true, appetite: false, mood: true, note: '睡眠差' };
    c.subjective.hep_adherence = { prescribed: ['ex-bridge'], reported_sessions: 4, note: '週末沒做' };
    c.objective.observations = [{ region: 'r_knee', quality_tag: ['腫脹'], note: '輕微' }];
    c.assessment = { goal_progress: [{ goal_id: 'g1', baseline: 18, current: 14, target: 10, pct: 50 }], clinical_reasoning: '進步中', trend: 'improving', risk_flags: ['fall'] };
    c.plan = { ...c.plan, frequency_change: '改為每週兩次', referral: '回骨科複診' };
    await svc.saveSoapContent(e.id, c);
    expect(await svc.getSoapContent(e.id)).toEqual(c);
  });

  it('缺漏欄位的舊資料以預設值補齊', () => {
    const c = parseSoap({ subjective: { chief_complaint: 'x' }, objective: null, assessment: null, plan: null });
    expect(c.subjective.nprs).toEqual({ score: null, site: [] });
    expect(c.objective.interventions).toEqual([]);
  });
});

describe('簽章內容檢查', () => {
  it('自費簽章需有主訴與至少一項 O 內容;補齊後可簽', async () => {
    const svc = strict(new SqliteRepo(':memory:'));
    const p = await svc.createPatient(patientInput);
    const e = await svc.createEncounter({ patient_id: p.id, track: 'self_pay', service_date: '2026-10-01', start_time: '10:00', end_time: '10:45' });
    await expect(svc.signEncounter(e.id)).rejects.toThrow('簽章前請先填寫:主訴、介入');
    await svc.saveSoapContent(e.id, content());
    await expect(svc.signEncounter(e.id)).resolves.toMatchObject({ status: 'signed' });
  });

  it('soapMissing', () => {
    expect(soapMissing(emptySoap())).toHaveLength(2);
    expect(soapMissing(content())).toEqual([]);
  });
});

describe('快速模式:複製上次治療(1.3)', () => {
  it('開啟即帶入上次介入與 HEP,不帶入舊的測驗值/主訴/NPRS', async () => {
    const svc = strict(new SqliteRepo(':memory:'));
    const p = await svc.createPatient(patientInput);
    const first = await svc.startVisit({ patient_id: p.id, service_date: '2026-10-01', start_time: '10:00', end_time: '10:45' });
    expect(first.prefilled).toBe(false);
    await svc.saveSoapContent(first.encounter.id, content());
    await svc.signEncounter(first.encounter.id);

    const second = await svc.startVisit({ patient_id: p.id, service_date: '2026-10-08', start_time: '10:00', end_time: '10:45' });
    expect(second.prefilled).toBe(true);
    const c = await svc.getSoapContent(second.encounter.id);
    expect(c.objective.interventions).toHaveLength(1);
    expect(c.objective.interventions[0]?.dose.resistance).toBe('2kg');
    expect(c.plan.hep.map((h) => h.item_id)).toEqual(['ex-bridge']);
    expect(c.plan.next_focus).toBe('增加坐站次數');
    expect(c.subjective.hep_adherence.prescribed).toEqual(['ex-bridge']);
    expect(c.objective.measures).toEqual([]);
    expect(c.objective.vitals.hr).toBeNull();
    expect(c.subjective.chief_complaint).toBe('');
    expect(c.subjective.nprs.score).toBeNull();
  });

  it('複製是深拷貝,改新紀錄不影響上次', () => {
    const prev = content();
    const next = prefillFromPrevious(prev);
    (next.objective.interventions[0] as { dose: { sets: number | null } }).dose.sets = 99;
    expect(prev.objective.interventions[0]?.dose.sets).toBe(3);
  });

  it('上次是被更正過的紀錄時,取最新版本', async () => {
    const svc = strict(new SqliteRepo(':memory:'));
    const p = await svc.createPatient(patientInput);
    const a = await svc.startVisit({ patient_id: p.id, service_date: '2026-10-01', start_time: '10:00', end_time: '10:45' });
    await svc.saveSoapContent(a.encounter.id, content());
    await svc.signEncounter(a.encounter.id);
    const v2 = await svc.reviseEncounter(a.encounter.id);
    const c2 = await svc.getSoapContent(v2.id);
    c2.objective.interventions[0]!.dose.sets = 5;
    await svc.saveSoapContent(v2.id, c2);
    await svc.signEncounter(v2.id);
    const next = await svc.startVisit({ patient_id: p.id, service_date: '2026-10-08', start_time: '10:00', end_time: '10:45' });
    expect((await svc.getSoapContent(next.encounter.id)).objective.interventions[0]?.dose.sets).toBe(5);
  });
});

describe('字典表與常模(1.1)', () => {
  it('測驗庫含規定的六項以上;seed 可重複執行且不覆蓋使用者修改', async () => {
    const repo = new SqliteRepo(':memory:');
    const svc = strict(repo);
    await svc.seedDictionaries();
    const codes = (await svc.listTests()).map((t) => t.code);
    for (const c of ['TUG', '30CST', 'BBS', 'GS4', 'GS10', 'SPPB', 'GRIP', 'SLS', 'MMSE']) expect(codes).toContain(c);
    const tug = (await repo.get('tests', 'test-tug'))!;
    await repo.put('tests', { ...tug, name: '我改過的名稱' });
    await svc.seedDictionaries();
    expect((await repo.get('tests', 'test-tug'))?.name).toBe('我改過的名稱');
    expect((await svc.listExercises()).length).toBeGreaterThan(10);
  });

  it('依年齡/性別比對常模,只陳述數字不下判斷', () => {
    const tug = SEED_TESTS.find((t) => t.id === 'test-tug')!;
    const r = referenceFor(tug, { birth_date: '1950-03-02', gender: 'male' }, '2026-10-18', 14);
    expect(r.normLine).toContain('9.2 秒'); // 76 歲 → 70–79
    expect(r.cutoffLine).toContain('12 秒');
    expect(r.relation).toBe('高於切點');
    expect(JSON.stringify(r)).not.toMatch(/異常|風險|警示|危險/);
  });

  it('30 秒坐站依性別取不同界線;性別未填則無對應', () => {
    const t = SEED_TESTS.find((x) => x.id === 'test-30scs')!;
    expect(referenceFor(t, { birth_date: '1950-01-01', gender: 'female' }, '2026-10-18', 9).normLine).toContain('10 次');
    expect(referenceFor(t, { birth_date: '1950-01-01', gender: 'male' }, '2026-10-18', 9).normLine).toContain('11 次');
    expect(referenceFor(t, { birth_date: '1950-01-01', gender: null }, '2026-10-18', 9).normLine).toBeNull();
  });

  it('年齡計算考慮是否已過生日', () => {
    expect(ageOn('1950-10-19', '2026-10-18')).toBe(75);
    expect(ageOn('1950-10-18', '2026-10-18')).toBe(76);
  });
});

describe('趨勢與目標(1.6)', () => {
  async function seedVisits() {
    const repo = new SqliteRepo(':memory:');
    const svc = strict(repo);
    const p = await svc.createPatient(patientInput);
    const vals: [string, number][] = [['2026-10-01', 18], ['2026-10-08', 16], ['2026-10-15', 14]];
    const ids: string[] = [];
    for (const [d, v] of vals) {
      const { encounter } = await svc.startVisit({ patient_id: p.id, service_date: d, start_time: '10:00', end_time: '10:45' });
      const c = content();
      c.objective.measures = [{ test_id: 'test-tug', value: v, unit: '秒', measured_at: `${d}T10:20:00.000+08:00` }];
      await svc.saveSoapContent(encounter.id, c);
      await svc.signEncounter(encounter.id);
      ids.push(encounter.id);
    }
    return { repo, svc, p, ids };
  }

  it('同一測驗跨次數自動串成趨勢,依時間排序', async () => {
    const { repo, p } = await seedVisits();
    const pts = await trendFor(repo, p.id, 'test-tug');
    expect(pts.map((x) => x.value)).toEqual([18, 16, 14]);
    expect(await testsUsedBy(repo, p.id)).toEqual(['test-tug']);
  });

  it('更正後只計最新版本,不重複', async () => {
    const { repo, svc, p, ids } = await seedVisits();
    const v2 = await svc.reviseEncounter(ids[2]!);
    const c = await svc.getSoapContent(v2.id);
    c.objective.measures[0]!.value = 13;
    await svc.saveSoapContent(v2.id, c);
    await svc.signEncounter(v2.id);
    expect((await trendFor(repo, p.id, 'test-tug')).map((x) => x.value)).toEqual([18, 16, 13]);
  });

  it('目標進度:越低越好的目標也能算百分比', async () => {
    const { repo, svc, p } = await seedVisits();
    const g = await svc.createGoal({ patient_id: p.id, description: 'TUG 降到 10 秒', baseline_value: 18, target_value: 10, test_id: 'test-tug' });
    expect(await goalProgressFor(repo, g)).toEqual({ current: 14, pct: 50 });
    expect(goalPct(18, 10, 10)).toBe(100);
    expect(goalPct(18, 20, 10)).toBe(-25);
    expect(goalPct(5, 5, 5)).toBeNull();
    expect(goalPct(null, 5, 10)).toBeNull();
  });
});

describe('個人常用清單', () => {
  it('加入/移出,重複加入不重複,移出後可再加入', async () => {
    const repo = new SqliteRepo(':memory:');
    const svc = strict(repo);
    await svc.setFavorite('exercise', 'ex-bridge', true);
    await svc.setFavorite('exercise', 'ex-bridge', true);
    await svc.setFavorite('exercise', 'ex-slr', true);
    expect((await svc.listFavorites('exercise')).map((f) => f.ref_id)).toEqual(['ex-bridge', 'ex-slr']);
    await svc.setFavorite('exercise', 'ex-bridge', false);
    expect((await svc.listFavorites('exercise')).map((f) => f.ref_id)).toEqual(['ex-slr']);
    await svc.setFavorite('exercise', 'ex-bridge', true);
    expect((await svc.listFavorites('exercise')).map((f) => f.ref_id)).toContain('ex-bridge');
    expect(await svc.listFavorites('test')).toEqual([]);
  });
});

describe('同步到 IndexedDB 後規則一致', () => {
  it('startVisit 與簽章內容檢查在 IndexedDB 上同樣成立', async () => {
    const h = await newIdb();
    const svc = strict(h.repo);
    const p = await svc.createPatient(patientInput);
    const { encounter } = await svc.startVisit({ patient_id: p.id, service_date: '2026-10-01', start_time: '10:00', end_time: '10:45' });
    await expect(svc.signEncounter(encounter.id)).rejects.toThrow('簽章前請先填寫');
    h.close();
  });
});

describe('舊版資料庫升級', () => {
  it('P0 建立的資料庫(exercises 無 category)升級後補欄位,舊資料保留', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    // 模擬 P0:移除 category 欄位後回到 migration 2 之前的狀態
    db.exec('ALTER TABLE exercises DROP COLUMN category');
    db.exec('DELETE FROM schema_migrations WHERE version = 3');
    db.exec("INSERT INTO exercises (id, name, created_at, updated_at) VALUES ('e1','舊動作','t','t')");
    migrate(db);
    const row = db.prepare("SELECT category FROM exercises WHERE id='e1'").get() as { category: string };
    expect(row.category).toBe('exercise');
  });
});
