import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { SqliteRepo } from '../src/server/db';
import { GcalService } from '../src/server/gcal/service';
import { DataService } from '../src/shared/service';
import { fakeClock, patientInput, seqIds } from './helpers';
import { FakeCalendar } from './fakeCalendar';

let close: (() => void) | undefined;
afterEach(() => close?.());

async function boot(enabled: boolean) {
  const clock = fakeClock('2026-10-18T09:00:00+08:00');
  const repo = new SqliteRepo(':memory:');
  const cal = new FakeCalendar(clock);
  const gcal = new GcalService(repo, enabled ? cal : null, 'minimal', enabled ? undefined : '尚未授權');
  const server = createApp(repo, '/nonexistent', { gcal });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { repo, cal, base, svc: new DataService({ repo, newId: seqIds(), now: clock, enforceContent: false }) };
}

describe('Google 行事曆 HTTP 端點', () => {
  it('未啟用:狀態說明原因,手動同步不做事', async () => {
    const { base } = await boot(false);
    expect(await (await fetch(`${base}/api/gcal/status`)).json()).toMatchObject({ enabled: false, reason: '尚未授權' });
    expect(await (await fetch(`${base}/api/gcal/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).toMatchObject({ enabled: false });
  });

  it('啟用:POST /api/gcal/sync 把行程推到 Google,狀態回報結果', async () => {
    const { base, svc, cal } = await boot(true);
    const p = await svc.createPatient(patientInput);
    await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    const st = (await (await fetch(`${base}/api/gcal/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as { enabled: boolean; last_ok: boolean; last_result: { created: number } };
    expect(st).toMatchObject({ enabled: true, last_ok: true });
    expect(st.last_result.created).toBe(1);
    expect(cal.liveEvents()).toHaveLength(1);
  });

  it('裝置經 /api/sync 送來行程後,背景自動推到 Google', async () => {
    const { base, svc, cal } = await boot(true);
    const p = await svc.createPatient(patientInput);
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    const res = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ since: 0, changes: [{ table: 'appointments', row: { ...a, note: '裝置修改', updated_at: '2026-10-19T09:00:00.000+08:00' } }] }) });
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(cal.liveEvents()).toHaveLength(1);
  });
});
