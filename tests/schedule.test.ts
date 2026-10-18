import { describe, expect, it } from 'vitest';
import { SqliteRepo } from '../src/server/db';
import { acceptRow } from '../src/shared/rules';
import { addDays, addressOrder, appointmentsOn, dateOf, makeIso, orderDiffersFromTime, overlappingIds, parseAddress, timeOf, weekDates, weekStart } from '../src/shared/schedule';
import type { Appointment } from '../src/shared/schema';
import { DataService } from '../src/shared/service';
import { fakeClock, newIdb, newSqlite, patientInput, seqIds, type RepoHandle } from './helpers';

const appt = (id: string, date: string, s: string, e: string, addr: string | null, status: Appointment['status'] = 'scheduled'): Appointment => ({
  id, patient_id: null, title: id, track: 'self_pay', start_at: makeIso(date, s), end_at: makeIso(date, e),
  location_text: addr, status, encounter_id: null, note: null, created_at: 't', updated_at: 't',
});

describe('日期運算', () => {
  it('加減日、週一起算、跨月跨年', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(weekStart('2026-10-18')).toBe('2026-10-12'); // 週日 → 當週週一
    expect(weekStart('2026-10-12')).toBe('2026-10-12');
    expect(weekDates('2026-10-14')).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
  });
  it('ISO 與台北日期時刻互轉,含跨日邊界', () => {
    expect(dateOf('2026-10-20T14:30:00+08:00')).toBe('2026-10-20');
    expect(timeOf('2026-10-20T14:30:00+08:00')).toBe('14:30');
    expect(dateOf('2026-10-20T20:00:00Z')).toBe('2026-10-21'); // UTC 20:00 = 台北隔日 04:00
    expect(timeOf('2026-10-20T20:00:00Z')).toBe('04:00');
  });
});

describe('同日行程', () => {
  it('依時間排序、排除已取消;偵測重疊', () => {
    const l = [appt('b', '2026-10-20', '11:00', '12:00', null), appt('a', '2026-10-20', '09:00', '10:00', null), appt('x', '2026-10-20', '09:30', '10:30', null, 'cancelled'), appt('c', '2026-10-21', '09:00', '10:00', null)];
    expect(appointmentsOn(l, '2026-10-20').map((x) => x.id)).toEqual(['a', 'b']);
    expect(overlappingIds(l).size).toBe(0); // 已取消的不算重疊
    const o = [...l, appt('d', '2026-10-20', '09:45', '10:30', null)];
    expect([...overlappingIds(o)].sort()).toEqual(['a', 'd']);
  });
  it('剛好銜接(10:00 結束、10:00 開始)不算重疊', () => {
    expect(overlappingIds([appt('a', '2026-10-20', '09:00', '10:00', null), appt('b', '2026-10-20', '10:00', '11:00', null)]).size).toBe(0);
  });
});

describe('地址排序提示(2.4)', () => {
  it('解析縣市/區/路/門牌', () => {
    expect(parseAddress('台北市大安區忠孝東路四段100號5樓')).toMatchObject({ city: '台北市', district: '大安區', number: 100 });
    expect(parseAddress('臺北市大安區忠孝東路四段100號').city).toBe('台北市');
    expect(parseAddress('100台北市中正區重慶南路一段122號').district).toBe('中正區');
    expect(parseAddress('').city).toBe('');
  });
  it('相近地址排在一起、門牌由小到大、無地址最後;不做路線規劃', () => {
    const l = [
      appt('板橋', '2026-10-20', '09:00', '10:00', '新北市板橋區文化路一段188號'),
      appt('大安2', '2026-10-20', '10:30', '11:30', '台北市大安區忠孝東路四段200號'),
      appt('無址', '2026-10-20', '11:00', '12:00', null),
      appt('大安1', '2026-10-20', '13:00', '14:00', '台北市大安區忠孝東路四段100號'),
      appt('信義', '2026-10-20', '15:00', '16:00', '台北市信義區松仁路7號'),
    ];
    expect(addressOrder(l).map((x) => x.id)).toEqual(['大安1', '大安2', '信義', '板橋', '無址']);
    expect(orderDiffersFromTime(l)).toBe(true);
  });
  it('段數數字大小正確(二段在十段之前)', () => {
    const l = [appt('十', '2026-10-20', '09:00', '10:00', '台北市大安區忠孝東路十段1號'), appt('二', '2026-10-20', '10:00', '11:00', '台北市大安區忠孝東路二段1號')];
    expect(addressOrder(l).map((x) => x.id)).toEqual(['二', '十']);
  });
  it('順序與時間一致時不提示', () => {
    const l = [appt('a', '2026-10-20', '09:00', '10:00', '台北市大安區甲路1號'), appt('b', '2026-10-20', '10:00', '11:00', '台北市大安區甲路9號')];
    expect(orderDiffersFromTime(l)).toBe(false);
  });
});

const factories: [string, () => Promise<RepoHandle>][] = [['SQLite', async () => newSqlite()], ['IndexedDB', () => newIdb()]];

describe.each(factories)('行程服務 — %s', (_n, make) => {
  async function setup() {
    const h = await make();
    const svc = new DataService({ repo: h.repo, newId: seqIds(), now: fakeClock(), enforceContent: false });
    const p = await svc.createPatient({ ...patientInput, address: '台北市大安區忠孝東路四段100號' });
    return { h, svc, p };
  }

  it('新增行程:地址預設帶入個案地址;依日期區間查詢(2.1)', async () => {
    const { svc, p } = await setup();
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    expect(a.location_text).toBe('台北市大安區忠孝東路四段100號');
    await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-27', start: '14:00', end: '15:00' });
    expect((await svc.listAppointments('2026-10-19', '2026-10-25')).map((x) => x.id)).toEqual([a.id]);
    expect(await svc.appointmentsOnDate('2026-10-20')).toHaveLength(1);
  });

  it('改期、改地點;結束早於開始被拒;軌別需符合個案', async () => {
    const { svc, p } = await setup();
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    const u = await svc.updateAppointment(a.id, { date: '2026-10-21', start: '09:00', end: '10:00', location_text: '新北市板橋區文化路一段188號' });
    expect(u.start_at).toBe('2026-10-21T09:00:00+08:00');
    expect(u.location_text).toContain('板橋');
    await expect(svc.updateAppointment(a.id, { start: '16:00', end: '15:00' })).rejects.toThrow('結束時間必須晚於開始時間');
    await expect(svc.createAppointment({ patient_id: p.id, track: 'ltc', date: '2026-10-20', start: '14:00', end: '15:00' })).rejects.toThrow('平行軌');
  });

  it('取消與恢復;取消不刪除資料', async () => {
    const { svc, p, h } = await setup();
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    expect((await svc.cancelAppointment(a.id)).status).toBe('cancelled');
    expect(await h.repo.list('appointments')).toHaveLength(1);
    expect((await svc.restoreAppointment(a.id)).status).toBe('scheduled');
  });

  it('一鍵開啟服務紀錄:個案、時間自動帶入、自費帶入上次治療(2.2)', async () => {
    const { svc, p } = await setup();
    // 先有一次已簽章的上次紀錄
    const first = await svc.startVisit({ patient_id: p.id, service_date: '2026-10-13', start_time: '10:00', end_time: '10:45' });
    const c = await svc.getSoapContent(first.encounter.id);
    c.subjective.chief_complaint = '膝痛';
    c.objective.interventions = [{ category: 'exercise', item_id: 'ex-sit-stand', dose: { sets: 3, reps: 10, resistance: null, duration: null } }];
    await svc.saveSoapContent(first.encounter.id, c);
    await svc.signEncounter(first.encounter.id);

    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '14:45' });
    const r = await svc.startFromAppointment(a.id);
    expect(r).toMatchObject({ created: true, prefilled: true });
    expect(r.encounter).toMatchObject({ patient_id: p.id, track: 'self_pay', service_date: '2026-10-20', start_time: '14:00', end_time: '14:45', status: 'draft' });
    expect((await svc.getSoapContent(r.encounter.id)).objective.interventions).toHaveLength(1);
    expect((await svc.getAppointment(a.id))?.encounter_id).toBe(r.encounter.id);

    // 再按一次不會重複建立
    const again = await svc.startFromAppointment(a.id);
    expect(again).toMatchObject({ created: false });
    expect(again.encounter.id).toBe(r.encounter.id);
  });

  it('已開啟服務紀錄的行程:不可取消、不可換個案', async () => {
    const { svc, p } = await setup();
    const p2 = await svc.createPatient({ ...patientInput, name: '別人' });
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '14:45' });
    await svc.startFromAppointment(a.id);
    await expect(svc.cancelAppointment(a.id)).rejects.toThrow('不可取消');
    await expect(svc.updateAppointment(a.id, { patient_id: p2.id })).rejects.toThrow('不可更換個案');
  });

  it('未指定個案或已取消的行程不能開啟服務紀錄', async () => {
    const { svc, p, h } = await setup();
    const g = appt('g1', '2026-10-20', '09:00', '10:00', null);
    expect((await acceptRow(h.repo, 'appointments', { ...g, created_at: '2026-10-01T00:00:00.000+08:00', updated_at: '2026-10-01T00:00:00.000+08:00' })).applied).toBe(true);
    await expect(svc.startFromAppointment('g1')).rejects.toThrow('指定個案');
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    await svc.cancelAppointment(a.id);
    await expect(svc.startFromAppointment(a.id)).rejects.toThrow('已取消');
    // 為 Google 匯入的行程指定個案後即可開啟
    await svc.updateAppointment('g1', { patient_id: p.id });
    await expect(svc.startFromAppointment('g1')).resolves.toMatchObject({ created: true });
  });

  it('長照行程開啟長照服務草稿(地點為居家)', async () => {
    const { svc } = await setup();
    const lp = await svc.createPatient({ ...patientInput, name: '長照個案', track: 'ltc', ltc_level: 4 });
    const a = await svc.createAppointment({ patient_id: lp.id, track: 'ltc', date: '2026-10-20', start: '09:00', end: '10:00' });
    const r = await svc.startFromAppointment(a.id);
    expect(r.encounter).toMatchObject({ track: 'ltc', location: 'home', start_time: '09:00' });
  });
});

describe('行程同步規則', () => {
  it('行程連結不存在或他人的服務紀錄會被拒絕', async () => {
    const repo = new SqliteRepo(':memory:');
    const svc = new DataService({ repo, newId: seqIds(), now: fakeClock(), enforceContent: false });
    const p1 = await svc.createPatient(patientInput);
    const p2 = await svc.createPatient({ ...patientInput, name: '乙' });
    const e2 = await svc.createEncounter({ patient_id: p2.id, track: 'self_pay', service_date: '2026-10-20', start_time: '09:00', end_time: '10:00' });
    const a = await svc.createAppointment({ patient_id: p1.id, track: 'self_pay', date: '2026-10-20', start: '09:00', end: '10:00' });
    expect(await acceptRow(repo, 'appointments', { ...a, encounter_id: 'nope', updated_at: '2030-01-01T00:00:00.000+08:00' })).toMatchObject({ applied: false, reject: 'orphan' });
    expect(await acceptRow(repo, 'appointments', { ...a, encounter_id: e2.id, updated_at: '2030-01-01T00:00:00.000+08:00' })).toMatchObject({ applied: false, reject: 'conflict' });
  });
});
