import { describe, expect, it } from 'vitest';
import { buildFamilySummary, summaryToText } from '../src/shared/family';
import { SqliteRepo } from '../src/server/db';
import { DataService } from '../src/shared/service';
import { emptySoap } from '../src/shared/soap';
import { fakeClock, newIdb, patientInput, seqIds, type RepoHandle } from './helpers';

const factories: [string, () => Promise<RepoHandle>][] = [['SQLite', async () => ({ name: 's', repo: new SqliteRepo(':memory:'), close: () => undefined })], ['IndexedDB', () => newIdb()]];

describe.each(factories)('P4 服務層 — %s', (_n, make) => {
  async function setup() {
    const h = await make();
    const svc = new DataService({ repo: h.repo, newId: seqIds(), now: fakeClock('2026-10-18T09:00:00+08:00'), enforceContent: false });
    await svc.seedDictionaries();
    const p = await svc.createPatient(patientInput);
    return { svc, p, h };
  }

  async function signedVisit(svc: DataService, patientId: string, date: string, tug: number, nprs: number) {
    const { encounter } = await svc.startVisit({ patient_id: patientId, service_date: date, start_time: '10:00', end_time: '10:45' });
    const c = emptySoap();
    c.subjective.chief_complaint = '膝痛';
    c.subjective.nprs = { score: nprs, site: [] };
    c.objective.interventions = [{ category: 'exercise', item_id: 'ex-sit-stand', dose: { sets: 3, reps: 10, resistance: null, duration: null } }];
    c.objective.measures = [{ test_id: 'test-tug', value: tug, unit: '秒', measured_at: `${date}T10:20:00.000+08:00` }];
    c.plan.hep = [{ item_id: 'ex-bridge', dose: { sets: 3, reps: 10, resistance: null, duration: null }, video_ref: null }];
    await svc.saveSoapContent(encounter.id, c);
    await svc.signEncounter(encounter.id);
    return encounter;
  }

  it('排入 LINE 訊息(離線可用);到達/完成各只能一則,失敗可重送,已送出不可重送', async () => {
    const { svc, p } = await setup();
    const { encounter } = await svc.startVisit({ patient_id: p.id, service_date: '2026-10-18', start_time: '10:00', end_time: '10:45' });
    const m = await svc.queueLine({ patient_id: p.id, encounter_id: encounter.id, kind: 'arrive', items: [{ type: 'text', text: '到了' }], expiresInMin: 30 });
    expect(m).toMatchObject({ status: 'queued', kind: 'arrive' });
    expect(Date.parse(m.expires_at!) - Date.parse(m.created_at)).toBe(30 * 60_000);
    await expect(svc.queueLine({ patient_id: p.id, encounter_id: encounter.id, kind: 'arrive', items: [{ type: 'text', text: '再到' }] })).rejects.toThrow('已送出過「到達」通知');
    // 摘要可多次排入
    await svc.queueLine({ patient_id: p.id, encounter_id: encounter.id, kind: 'summary', items: [{ type: 'text', text: 'a' }] });
    await svc.queueLine({ patient_id: p.id, encounter_id: encounter.id, kind: 'summary', items: [{ type: 'text', text: 'b' }] });
    expect(await svc.listLineMessages(encounter.id)).toHaveLength(3);

    // 模擬 server 回寫
    const { acceptRow } = await import('../src/shared/rules');
    const repo = (svc as unknown as { repo: RepoHandle['repo'] }).repo;
    await acceptRow(repo, 'line_messages', { ...m, status: 'failed', status_detail: 'HTTP 429', updated_at: '2026-10-18T12:00:00.000+08:00' });
    const re = await svc.requeueLine(m.id);
    expect(re).toMatchObject({ status: 'queued', attempts: 0, status_detail: null });
    await acceptRow(repo, 'line_messages', { ...re, status: 'sent', sent_at: '2026-10-18T13:00:00.000+08:00', updated_at: '2026-10-18T13:00:00.000+08:00' });
    await expect(svc.requeueLine(m.id)).rejects.toThrow('已送出');
    // 已送出的到達通知仍擋重複;失敗過的可重新排入
    await expect(svc.queueLine({ patient_id: p.id, encounter_id: encounter.id, kind: 'arrive', items: [{ type: 'text', text: 'x' }] })).rejects.toThrow('已送出過');
  });

  it('更新動作庫影片網址(4.5)', async () => {
    const { svc } = await setup();
    const e = await svc.updateExercise('ex-bridge', { video_ref: 'https://example.com/bridge' });
    expect(e.video_ref).toBe('https://example.com/bridge');
    expect((await svc.listExercises()).find((x) => x.id === 'ex-bridge')?.video_ref).toBe('https://example.com/bridge');
    await expect(svc.updateExercise('nope', {})).rejects.toThrow('找不到動作');
  });

  it('家屬摘要資料:取日期較早的上次紀錄、趨勢到本次為止、下次預約;產出文字無術語', async () => {
    const { svc, p } = await setup();
    await signedVisit(svc, p.id, '2026-10-04', 18, 6);
    await signedVisit(svc, p.id, '2026-10-11', 16, 5);
    const third = await signedVisit(svc, p.id, '2026-10-18', 14, 3);
    const later = await signedVisit(svc, p.id, '2026-10-25', 12, 2); // 比本次晚的紀錄不可影響本次摘要
    void later;
    await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-25', start: '14:00', end: '15:00' });

    const input = await svc.familySummaryInput(third.id);
    expect(input.prev?.subjective.nprs.score).toBe(5);
    expect(input.trends.get('test-tug')?.map((x) => x.value)).toEqual([18, 16, 14]);
    expect(input.nextAppointment).toEqual({ date: '2026-10-25', time: '14:00' });

    const s = buildFamilySummary(input);
    expect(s.progress).toContain('疼痛程度從上次的 5 分降到 3 分,有減輕');
    expect(s.progress).toContain('起立走路測試:從 16 變成 14 秒,進步了');
    expect(s.chart?.points.map((x) => x.value)).toEqual([18, 16, 14]);
    const t = summaryToText(s, '診所');
    expect(t).toContain('下次預計 10/25(週日) 14:00 到府');
    expect(t).not.toMatch(/TUG|NPRS|HEP/);
  });
});
