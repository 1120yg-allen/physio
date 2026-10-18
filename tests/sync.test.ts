import { describe, expect, it } from 'vitest';
import { handleSync } from '../src/server/app';
import { SqliteRepo } from '../src/server/db';
import { runSync, type Transport } from '../src/client/sync';
import { DataService } from '../src/shared/service';
import { fakeClock, newIdb, patientInput } from './helpers';

/** 模擬一台裝置:本機 IndexedDB + 可斷線的傳輸層 */
async function device(server: SqliteRepo, label: string, startClock: string) {
  const h = await newIdb();
  let online = true;
  let n = 0;
  const svc = new DataService({ repo: h.repo, newId: () => `${label}-${String(++n).padStart(3, '0')}`, now: fakeClock(startClock), enforceContent: false });
  const transport: Transport = async (req) => {
    if (!online) throw new Error('無法連線');
    // 經 JSON 來回,模擬真實網路序列化
    const res = await handleSync(server, JSON.parse(JSON.stringify(req)));
    return JSON.parse(JSON.stringify(res));
  };
  return {
    h,
    svc,
    repo: h.repo,
    sync: () => runSync(h.repo, transport),
    setOnline: (v: boolean) => (online = v),
  };
}

describe('離線儲存與同步(0.4)', () => {
  it('離線可新增個案、服務與 SOAP,連線後同步到 server,無資料遺失', async () => {
    const server = new SqliteRepo(':memory:');
    const d = await device(server, 'A', '2026-10-18T09:00:00+08:00');
    d.setOnline(false);

    const p = await d.svc.createPatient(patientInput);
    const e = await d.svc.createEncounter({ patient_id: p.id, track: 'self_pay', service_date: '2026-10-18', start_time: '14:00', end_time: '14:45' });
    await d.svc.saveSoapNote(e.id, { subjective: { chief_complaint: '膝痛' }, objective: null, assessment: null, plan: null });
    await d.svc.signEncounter(e.id);

    // 離線時同步失敗但不丟例外,本機資料完整可讀
    const off = await d.sync();
    expect(off.ok).toBe(false);
    expect((await d.svc.getPatient(p.id))?.name).toBe('王大明');
    expect(await d.repo.listOutbox()).toHaveLength(3);

    d.setOnline(true);
    const on = await d.sync();
    expect(on).toMatchObject({ ok: true, pushed: 3, needsAttention: 0 });
    expect(await d.repo.listOutbox()).toHaveLength(0);

    // server 上簽章狀態與 SOAP 內容皆到齊
    const srv = new DataService({ repo: server });
    expect((await srv.getEncounter(e.id))?.status).toBe('signed');
    expect((await srv.getSoapNote(e.id))?.subjective).toEqual({ chief_complaint: '膝痛' });
    expect((await srv.getPatient(p.id))?.precautions).toBe(patientInput.precautions);
  });

  it('重複同步是冪等的(重送不產生重複或錯誤)', async () => {
    const server = new SqliteRepo(':memory:');
    const d = await device(server, 'A', '2026-10-18T09:00:00+08:00');
    await d.svc.createPatient(patientInput);
    await d.sync();
    const again = await d.sync();
    expect(again).toMatchObject({ ok: true, pushed: 0, needsAttention: 0 });
    expect(await server.list('patients')).toHaveLength(1);
  });

  it('自己剛推上去的資料被拉回時不算變更(避免背景同步重繪打斷輸入)', async () => {
    const server = new SqliteRepo(':memory:');
    const d = await device(server, 'A', '2026-10-18T09:00:00+08:00');
    await d.svc.createPatient(patientInput);
    const out = await d.sync();
    expect(out).toMatchObject({ pushed: 1, pulled: 0 });
  });

  it('兩台裝置經 server 互相取得資料', async () => {
    const server = new SqliteRepo(':memory:');
    const a = await device(server, 'A', '2026-10-18T09:00:00+08:00');
    const b = await device(server, 'B', '2026-10-18T09:00:00+08:00');
    const p = await a.svc.createPatient(patientInput);
    await a.sync();
    const out = await b.sync();
    expect(out.pulled).toBeGreaterThanOrEqual(1);
    expect((await b.svc.getPatient(p.id))?.name).toBe('王大明');
  });

  it('個案資料最後寫入者勝:較舊的離線修改不會覆蓋較新的', async () => {
    const server = new SqliteRepo(':memory:');
    const a = await device(server, 'A', '2026-10-18T09:00:00+08:00');
    const b = await device(server, 'B', '2026-10-18T09:00:00+08:00');
    const p = await a.svc.createPatient(patientInput);
    await a.sync();
    await b.sync();

    await a.svc.updatePatient(p.id, { phone: '0911000001' }); // 較早
    const bClockLater = await device(server, 'B2', '2026-10-18T12:00:00+08:00');
    await bClockLater.sync();
    await bClockLater.svc.updatePatient(p.id, { phone: '0911000002' }); // 較晚
    await bClockLater.sync();
    const out = await a.sync(); // a 的舊修改被判 stale,並對齊 server
    expect(out.ok).toBe(true);
    expect((await a.svc.getPatient(p.id))?.phone).toBe('0911000002');
    expect((await new DataService({ repo: server }).getPatient(p.id))?.phone).toBe('0911000002');
  });

  it('server 端已簽章的紀錄,另一台裝置的離線修改被鎖定拒絕,但本機內容保留並標記', async () => {
    const server = new SqliteRepo(':memory:');
    const a = await device(server, 'A', '2026-10-18T09:00:00+08:00');
    const b = await device(server, 'B', '2026-10-18T09:00:00+08:00');
    const p = await a.svc.createPatient(patientInput);
    const e = await a.svc.createEncounter({ patient_id: p.id, track: 'self_pay', service_date: '2026-10-18', start_time: '14:00', end_time: '14:45' });
    await a.sync();
    await b.sync(); // b 取得草稿

    // b 離線修改草稿(尚未同步);a 簽章並同步
    b.setOnline(false);
    await b.svc.updateEncounter(e.id, { location: 'facility' });
    await a.svc.signEncounter(e.id);
    await a.sync();

    b.setOnline(true);
    const out = await b.sync();
    expect(out.ok).toBe(true);
    expect(out.needsAttention).toBe(1);
    // server 的簽章版本沒有被改動
    const srv = await new DataService({ repo: server }).getEncounter(e.id);
    expect(srv).toMatchObject({ status: 'signed', location: null });
    // b 的修改仍保留在本機,待人工處理
    expect((await b.svc.getEncounter(e.id))?.location).toBe('facility');
  });

  it('兩台裝置同時對同一版本建立新版本:第二台被拒(fork)且內容保留', async () => {
    const server = new SqliteRepo(':memory:');
    const a = await device(server, 'A', '2026-10-18T09:00:00+08:00');
    const b = await device(server, 'B', '2026-10-18T09:00:00+08:00');
    const p = await a.svc.createPatient(patientInput);
    const e = await a.svc.createEncounter({ patient_id: p.id, track: 'self_pay', service_date: '2026-10-18', start_time: '14:00', end_time: '14:45' });
    await a.svc.signEncounter(e.id);
    await a.sync();
    await b.sync();

    b.setOnline(false);
    const bv2 = await b.svc.reviseEncounter(e.id);
    const av2 = await a.svc.reviseEncounter(e.id);
    await a.sync();
    b.setOnline(true);
    const out = await b.sync();
    expect(out.needsAttention).toBeGreaterThanOrEqual(1);
    expect(await b.svc.getEncounter(bv2.id)).not.toBeNull();
    expect((await server.getSuperseder(e.id))?.id).toBe(av2.id);
  });

  it('簽章在先、SOAP 在後抵達 server 時仍被接受(簽章前完成的內容)', async () => {
    const server = new SqliteRepo(':memory:');
    const d = await device(server, 'A', '2026-10-18T09:00:00+08:00');
    d.setOnline(false);
    const p = await d.svc.createPatient(patientInput);
    const e = await d.svc.createEncounter({ patient_id: p.id, track: 'self_pay', service_date: '2026-10-18', start_time: '14:00', end_time: '14:45' });
    await d.svc.saveSoapNote(e.id, { subjective: { x: 1 }, objective: null, assessment: null, plan: null });
    await d.svc.signEncounter(e.id);
    d.setOnline(true);
    expect((await d.sync()).needsAttention).toBe(0);
  });

  it('簽章之後才寫入的 SOAP 內容(例如竄改)被 server 拒絕', async () => {
    const server = new SqliteRepo(':memory:');
    const d = await device(server, 'A', '2026-10-18T09:00:00+08:00');
    const p = await d.svc.createPatient(patientInput);
    const e = await d.svc.createEncounter({ patient_id: p.id, track: 'self_pay', service_date: '2026-10-18', start_time: '14:00', end_time: '14:45' });
    const note = await d.svc.saveSoapNote(e.id, { subjective: { x: 1 }, objective: null, assessment: null, plan: null });
    const signed = await d.svc.signEncounter(e.id);
    await d.sync();

    const res = await handleSync(server, {
      since: 0,
      changes: [{ table: 'soap_notes', row: { ...note, subjective: { x: 'tampered' }, updated_at: '2099-01-01T00:00:00.000+08:00' } }],
    });
    expect(res.results[0]).toMatchObject({ status: 'rejected', reject: 'locked' });
    expect((await server.getByEncounter('soap_notes', signed.id))?.subjective).toEqual({ x: 1 });
  });

  it('server 收到不合法資料時整筆拒絕,不影響同批其他資料', async () => {
    const server = new SqliteRepo(':memory:');
    const d = await device(server, 'A', '2026-10-18T09:00:00+08:00');
    const p = await d.svc.createPatient(patientInput);
    const res = await handleSync(server, {
      since: 0,
      changes: [
        { table: 'patients', row: { ...p, track: 'bogus' } },
        { table: 'patients', row: { ...p, id: 'ok-1' } },
      ],
    });
    expect(res.results.map((r) => r.status).sort()).toEqual(['accepted', 'rejected']);
  });
});
