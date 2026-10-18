import { describe, expect, it } from 'vitest';
import { runGcalSync } from '../src/server/gcal/sync';
import { buildEventBody, eventIdFor, maskName } from '../src/server/gcal/privacy';
import { SqliteRepo } from '../src/server/db';
import { DataService } from '../src/shared/service';
import { fakeClock, patientInput, seqIds } from './helpers';
import { FakeCalendar } from './fakeCalendar';

function setup(privacy: 'minimal' | 'full' = 'minimal') {
  const clock = fakeClock('2026-10-18T09:00:00+08:00');
  const repo = new SqliteRepo(':memory:');
  const svc = new DataService({ repo, newId: seqIds(), now: clock, enforceContent: false });
  const cal = new FakeCalendar(clock);
  let n = 0;
  const sync = () => runGcalSync({ repo, api: cal, privacy, now: clock, newId: () => `g-${++n}` });
  return { repo, svc, cal, sync };
}

const iso = (d: string, t: string) => `${d}T${t}:00+08:00`;

describe('Google 行事曆隱私', () => {
  it('預設只送遮罩姓名與軌別,不含地址與備註', async () => {
    const { svc, cal, sync } = setup('minimal');
    const p = await svc.createPatient({ ...patientInput, address: '台北市大安區忠孝東路四段100號' });
    await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00', note: '備註內容' });
    await sync();
    const ev = cal.liveEvents()[0]!;
    expect(ev.summary).toBe('王○○・自費');
    expect(ev.location).toBeUndefined();
    expect(ev.description).toBeUndefined();
    expect(JSON.stringify(ev)).not.toContain('大明');
    expect(JSON.stringify(ev)).not.toContain('忠孝');
  });

  it('full 模式才送完整姓名、地址、備註', async () => {
    const { svc, cal, sync } = setup('full');
    const both = await svc.createPatient({ ...patientInput, name: '李小華', track: 'both', ltc_level: 3, address: '新北市板橋區文化路一段188號' });
    await svc.createAppointment({ patient_id: both.id, track: 'ltc', date: '2026-10-20', start: '16:00', end: '17:00', note: '備註內容' });
    await sync();
    const ev = cal.liveEvents()[0]!;
    expect(ev.summary).toBe('李小華・長照');
    expect(ev.location).toContain('板橋');
    expect(ev.description).toBe('備註內容');
  });

  it('姓名遮罩與事件 id 格式', () => {
    expect(maskName('王大明')).toBe('王○○');
    expect(maskName('歐陽小華')).toBe('歐○○○');
    expect(maskName('王')).toBe('○');
    expect(eventIdFor('abc')).toMatch(/^[0-9a-v]{5,}$/);
    expect(eventIdFor('abc')).toBe(eventIdFor('abc'));
    expect(eventIdFor('abc')).not.toBe(eventIdFor('abd'));
  });

  it('事件內容帶 physio_id 供辨識,不含個資', async () => {
    const { svc } = setup();
    const p = await svc.createPatient(patientInput);
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    const body = buildEventBody(a, p, 'minimal');
    expect(body.extendedProperties?.private).toEqual({ physio_id: a.id });
  });
});

describe('雙向同步(2.3)', () => {
  it('本機新增 → Google 出現一筆;重複同步不重複建立', async () => {
    const { svc, cal, sync } = setup();
    const p = await svc.createPatient(patientInput);
    await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    expect((await sync()).created).toBe(1);
    expect(cal.liveEvents()).toHaveLength(1);
    for (let i = 0; i < 3; i++) await sync();
    expect(cal.liveEvents()).toHaveLength(1);
    expect(cal.calls.insert).toBe(1);
    expect(cal.calls.patch).toBe(0); // 沒有變更就不寫,也不會因自己的回音來回更新
  });

  it('本機改期 → Google 更新同一筆', async () => {
    const { svc, cal, sync } = setup();
    const p = await svc.createPatient(patientInput);
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    await sync();
    await svc.updateAppointment(a.id, { date: '2026-10-21', start: '09:00', end: '10:00' });
    expect((await sync()).updated).toBe(1);
    expect(cal.liveEvents()).toHaveLength(1);
    expect(cal.liveEvents()[0]!.start?.dateTime).toBe(iso('2026-10-21', '09:00'));
    await sync();
    expect(cal.calls.patch).toBe(1);
  });

  it('本機取消 → Google 刪除;之後不再來回', async () => {
    const { svc, cal, sync } = setup();
    const p = await svc.createPatient(patientInput);
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    await sync();
    await svc.cancelAppointment(a.id);
    expect((await sync()).deleted).toBe(1);
    expect(cal.liveEvents()).toHaveLength(0);
    await sync();
    await sync();
    expect(cal.calls.remove).toBe(1);
    expect((await svc.getAppointment(a.id))?.status).toBe('cancelled');
  });

  it('Google 改期 → 本機跟著更新', async () => {
    const { svc, cal, sync, repo } = setup();
    const p = await svc.createPatient(patientInput);
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    await sync();
    cal.userMove(repo.getMap(a.id)!.event_id, iso('2026-10-22', '10:30'), iso('2026-10-22', '11:30'));
    const r = await sync();
    expect(r.pulled).toBe(1);
    const got = await svc.getAppointment(a.id);
    expect(got?.start_at).toBe(iso('2026-10-22', '10:30'));
    await sync();
    expect(cal.calls.patch).toBe(0); // 不會把剛拉下來的變更又推回去
  });

  it('Google 刪除 → 本機取消(未開服務紀錄者)', async () => {
    const { svc, cal, sync, repo } = setup();
    const p = await svc.createPatient(patientInput);
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    await sync();
    cal.userDelete(repo.getMap(a.id)!.event_id);
    await sync();
    expect((await svc.getAppointment(a.id))?.status).toBe('cancelled');
    await sync();
    expect(cal.liveEvents()).toHaveLength(0);
  });

  it('Google 刪除已開啟服務紀錄的行程:本機保留並警示,不取消病歷相關行程', async () => {
    const { svc, cal, sync, repo } = setup();
    const p = await svc.createPatient(patientInput);
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    await svc.startFromAppointment(a.id);
    await sync();
    cal.userDelete(repo.getMap(a.id)!.event_id);
    const r = await sync();
    expect(r.warnings).toHaveLength(1);
    expect((await svc.getAppointment(a.id))?.status).toBe('scheduled');
  });

  it('Google 新增的事件 → 本機出現「未指定個案」行程;指定個案後可開服務紀錄;不重複', async () => {
    const { svc, cal, sync, repo } = setup();
    cal.userCreate('abcde12345', '王媽媽復健', iso('2026-10-21', '09:00'), iso('2026-10-21', '10:00'), '台北市中山區南京東路一段1號');
    cal.userCreate('allday', '全天事件', '', '');
    cal.events.get('allday')!.start = { date: '2026-10-21' };
    cal.events.get('allday')!.end = { date: '2026-10-22' };
    const r = await sync();
    expect(r.pulled).toBe(1); // 全天事件略過
    await sync();
    await sync();
    const list = await svc.listAppointments('2026-10-21', '2026-10-21');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ patient_id: null, title: '王媽媽復健', location_text: '台北市中山區南京東路一段1號' });
    expect(repo.getMapByEvent('abcde12345')).not.toBeNull();
    expect(cal.calls.insert).toBe(0); // 不會把 Google 自己的事件再建立一份

    const p = await svc.createPatient(patientInput);
    await svc.updateAppointment(list[0]!.id, { patient_id: p.id });
    await sync();
    // 指定個案後推回 Google:標題改為遮罩姓名格式,仍是同一筆事件
    expect(cal.events.get('abcde12345')!.summary).toBe('王○○・自費');
    expect(cal.liveEvents().filter((e) => e.id !== 'allday')).toHaveLength(1);
  });

  it('雙方都改過:較晚修改者勝', async () => {
    // 本機較晚
    {
      const { svc, cal, sync, repo } = setup();
      const p = await svc.createPatient(patientInput);
      const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
      await sync();
      cal.userMove(repo.getMap(a.id)!.event_id, iso('2026-10-22', '10:00'), iso('2026-10-22', '11:00')); // 較早
      await svc.updateAppointment(a.id, { start: '16:00', end: '17:00' }); // 較晚
      await sync();
      expect((await svc.getAppointment(a.id))?.start_at).toBe(iso('2026-10-20', '16:00'));
      expect(cal.events.get(repo.getMap(a.id)!.event_id)!.start?.dateTime).toBe(iso('2026-10-20', '16:00'));
    }
    // Google 較晚
    {
      const { svc, cal, sync, repo } = setup();
      const p = await svc.createPatient(patientInput);
      const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
      await sync();
      await svc.updateAppointment(a.id, { start: '16:00', end: '17:00' }); // 較早
      cal.userMove(repo.getMap(a.id)!.event_id, iso('2026-10-22', '10:00'), iso('2026-10-22', '11:00')); // 較晚
      await sync();
      expect((await svc.getAppointment(a.id))?.start_at).toBe(iso('2026-10-22', '10:00'));
      expect(cal.events.get(repo.getMap(a.id)!.event_id)!.start?.dateTime).toBe(iso('2026-10-22', '10:00'));
    }
  });

  it('推送後對應表遺失(中斷)時,重跑不會產生重複事件', async () => {
    const { svc, cal, sync, repo } = setup();
    const p = await svc.createPatient(patientInput);
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    await sync();
    repo.db.exec('DELETE FROM gcal_map'); // 模擬記錄遺失
    repo.setKv('gcal_sync_token', '');
    await sync();
    expect(cal.liveEvents()).toHaveLength(1);
    expect(repo.getMap(a.id)).not.toBeNull();
  });

  it('syncToken 失效時全量重抓,結果仍一致且不重複', async () => {
    const { svc, cal, sync } = setup();
    const p = await svc.createPatient(patientInput);
    await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    cal.userCreate('gcal-only-1', '外部事件', iso('2026-10-23', '09:00'), iso('2026-10-23', '10:00'));
    await sync();
    cal.invalidateToken = true;
    await sync();
    expect(cal.liveEvents()).toHaveLength(2);
    expect((await svc.listAppointments('2026-10-01', '2026-10-31')).filter((x) => x.status === 'scheduled')).toHaveLength(2);
  });

  it('Google 端刪除後本機恢復行程:同 id 事件被重新啟用而非重複建立', async () => {
    const { svc, cal, sync } = setup();
    const p = await svc.createPatient(patientInput);
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    await sync();
    await svc.cancelAppointment(a.id);
    await sync();
    await svc.restoreAppointment(a.id);
    await sync();
    expect(cal.liveEvents()).toHaveLength(1);
    expect(cal.calls.insert).toBe(1);
  });
});
