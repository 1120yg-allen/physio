import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { SqliteRepo } from '../src/server/db';
import { HttpLineApi, retryKeyFor, verifySignature, type LineApi, type LineMessageObj, type PushResult } from '../src/server/line/api';
import { drainOutbox } from '../src/server/line/outbox';
import { enqueueReminders } from '../src/server/line/reminders';
import { createLineService, LineService, parseHour } from '../src/server/line/service';
import { createWebhookServer } from '../src/server/line/server';
import { LineStore } from '../src/server/line/store';
import { handleWebhook } from '../src/server/line/webhook';
import { acceptRow } from '../src/shared/rules';
import type { LineMessage } from '../src/shared/schema';
import { DataService } from '../src/shared/service';
import { fakeClock, patientInput, seqIds } from './helpers';

const SECRET = 'channel-secret';
const OK: PushResult = { ok: true };

class FakeLine implements LineApi {
  pushes: { to: string; messages: LineMessageObj[]; key: string }[] = [];
  replies: { token: string; messages: LineMessageObj[] }[] = [];
  results: PushResult[] = [];
  /** 依收件者指定結果 */
  byUser = new Map<string, PushResult>();
  async push(to: string, messages: LineMessageObj[], key: string): Promise<PushResult> {
    const r = this.byUser.get(to) ?? this.results.shift() ?? OK;
    this.pushes.push({ to, messages, key });
    return r;
  }
  async reply(token: string, messages: LineMessageObj[]): Promise<PushResult> {
    this.replies.push({ token, messages });
    return OK;
  }
  replyText(i = -1): string {
    const r = this.replies.at(i)!;
    return r.messages.map((m) => m.text as string).join('\n');
  }
}

function setup(startNow = '2026-10-19T18:30:00+08:00') {
  const clock = fakeClock(startNow);
  const repo = new SqliteRepo(':memory:');
  let ms = Date.parse(startNow);
  const store = new LineStore(repo, () => ms);
  const api = new FakeLine();
  const svc = new DataService({ repo, newId: seqIds(), now: clock, enforceContent: false });
  return { repo, store, api, svc, clock, advance: (d: number) => (ms += d), setMs: (v: number) => (ms = v) };
}

const sign = (body: string): string => createHmac('sha256', SECRET).update(body).digest('base64');
const eventBody = (events: unknown[]): string => JSON.stringify({ destination: 'U-dest', events });
const msgEvent = (userId: string, text: string, token = 'rt'): unknown => ({ type: 'message', replyToken: token, source: { type: 'user', userId }, message: { type: 'text', text } });

function wh(s: ReturnType<typeof setup>) {
  return (events: unknown[], sig?: string) => {
    const raw = eventBody(events);
    return handleWebhook({ repo: s.repo, store: s.store, api: s.api, channelSecret: SECRET, clinicName: '診所', now: s.clock }, Buffer.from(raw), sig ?? sign(raw));
  };
}

async function queue(repo: SqliteRepo, over: Partial<LineMessage> & Pick<LineMessage, 'id' | 'patient_id'>): Promise<LineMessage> {
  const row: LineMessage = {
    encounter_id: null, appointment_id: null, kind: 'arrive', payload: { items: [{ type: 'text', text: '到了' }] }, expires_at: null,
    status: 'queued', status_detail: null, attempts: 0, sent_at: null, created_at: '2026-10-19T18:00:00.000+08:00', updated_at: '2026-10-19T18:00:00.000+08:00', ...over,
  };
  const r = await acceptRow(repo, 'line_messages', row);
  if (!r.applied) throw new Error(r.message);
  return row;
}

describe('4.1 簽章與 API', () => {
  it('webhook 簽章:正確通過,竄改/缺漏/錯誤密鑰被拒', () => {
    const body = '{"events":[]}';
    expect(verifySignature(body, SECRET, sign(body))).toBe(true);
    expect(verifySignature(body + ' ', SECRET, sign(body))).toBe(false);
    expect(verifySignature(body, 'other', sign(body))).toBe(false);
    expect(verifySignature(body, SECRET, undefined)).toBe(false);
    expect(verifySignature(body, SECRET, '!!!')).toBe(false);
  });

  it('push 請求格式:授權標頭、retry key、訊息;錯誤碼對應中文說明且不帶回應本文', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const mk = (status: number) => new HttpLineApi('TOKEN', async (url, init) => { calls.push({ url, init: init! }); return new Response(JSON.stringify({ message: '王大明' }), { status }); });
    const ok = await mk(200).push('U1', [{ type: 'text', text: 'hi' }], 'key-1');
    expect(ok).toEqual({ ok: true });
    expect(calls[0]!.url).toBe('https://api.line.me/v2/bot/message/push');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer TOKEN');
    expect(h['x-line-retry-key']).toBe('key-1');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ to: 'U1', messages: [{ type: 'text', text: 'hi' }] });
    const r429 = await mk(429).push('U1', [], 'k');
    expect(r429).toMatchObject({ ok: false, retryable: false });
    expect((r429 as { detail: string }).detail).toContain('本月訊息上限');
    expect(await mk(503).push('U1', [], 'k')).toMatchObject({ retryable: true });
    expect(await mk(401).push('U1', [], 'k')).toMatchObject({ retryable: false });
    const net = await new HttpLineApi('T', async () => { throw new Error('ECONNRESET'); }).push('U', [], 'k');
    expect(net).toMatchObject({ ok: false, retryable: true });
    expect(JSON.stringify(r429)).not.toContain('王大明');
  });

  it('retry key 為決定性的 UUID 格式', () => {
    expect(retryKeyFor('a')).toBe(retryKeyFor('a'));
    expect(retryKeyFor('a')).not.toBe(retryKeyFor('b'));
    expect(retryKeyFor('a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('綁定流程', () => {
  it('加好友 → 歡迎訊息;輸入綁定碼 → 綁定成功(姓名遮罩);之後可收訊息', async () => {
    const s = setup();
    const p = await s.svc.createPatient(patientInput);
    const { code } = s.store.createBindCode(p.id, 'family', s.clock());
    const hook = wh(s);
    expect((await hook([{ type: 'follow', replyToken: 'r0', source: { type: 'user', userId: 'U-fam' } }])).status).toBe(200);
    expect(s.api.replyText()).toContain('綁定碼');
    await hook([msgEvent('U-fam', `綁定 ${code}`)]);
    expect(s.api.replyText()).toContain('已完成綁定(王○○)');
    expect(s.api.replyText()).not.toContain('大明');
    expect(s.store.activeRecipients(p.id)).toEqual(['U-fam']);
    expect(s.store.listLinks(p.id)[0]).toMatchObject({ role: 'family', status: 'active' });
    expect(JSON.stringify(s.store.listLinks(p.id))).not.toContain('U-fam'); // 給 UI 的資料不含 LINE user id
  });

  it('全形數字、只輸入 6 碼也可綁定;綁定碼單次使用', async () => {
    const s = setup();
    const p = await s.svc.createPatient(patientInput);
    const { code } = s.store.createBindCode(p.id, 'family', s.clock());
    const hook = wh(s);
    await hook([msgEvent('U1', code.replace(/\d/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)))]);
    expect(s.store.activeRecipients(p.id)).toEqual(['U1']);
    await hook([msgEvent('U2', code)]);
    expect(s.api.replyText()).toContain('已使用過');
    expect(s.store.activeRecipients(p.id)).toEqual(['U1']);
  });

  it('綁定碼過期、錯誤;連續錯 5 次鎖定 1 小時,即使之後輸入正確碼也被擋', async () => {
    const s = setup();
    const p = await s.svc.createPatient(patientInput);
    const hook = wh(s);
    const { code } = s.store.createBindCode(p.id, 'family', s.clock());
    for (let i = 0; i < 5; i++) await hook([msgEvent('U-bad', '000000')]);
    expect(s.api.replyText(-1)).toContain('不正確');
    await hook([msgEvent('U-bad', code)]);
    expect(s.api.replyText()).toContain('錯誤次數過多');
    expect(s.store.activeRecipients(p.id)).toEqual([]);
    // 1 小時後解除;但碼已逾 48 小時則過期
    s.advance(3600_000 + 1);
    await hook([msgEvent('U-bad', code)]);
    expect(s.store.activeRecipients(p.id)).toEqual(['U-bad']);
    const old = s.store.createBindCode(p.id, 'family', s.clock());
    s.advance(49 * 3600_000);
    await hook([msgEvent('U-late', old.code)]);
    expect(s.api.replyText()).toContain('過期');
  });

  it('回覆「停止」或取消好友 → 解除該使用者所有綁定;其他訊息不自動回覆', async () => {
    const s = setup();
    const p = await s.svc.createPatient(patientInput);
    const p2 = await s.svc.createPatient({ ...patientInput, name: '李小華' });
    const hook = wh(s);
    await hook([msgEvent('U1', s.store.createBindCode(p.id, 'family', s.clock()).code)]);
    await hook([msgEvent('U1', s.store.createBindCode(p2.id, 'family', s.clock()).code)]);
    const before = s.api.replies.length;
    await hook([msgEvent('U1', '請問下次什麼時候來?')]);
    expect(s.api.replies.length).toBe(before);
    await hook([msgEvent('U1', '停止')]);
    expect(s.api.replyText()).toContain('已取消綁定');
    expect(s.store.activeRecipients(p.id)).toEqual([]);
    expect(s.store.activeRecipients(p2.id)).toEqual([]);
    await hook([msgEvent('U2', s.store.createBindCode(p.id, 'family', s.clock()).code)]);
    await hook([{ type: 'unfollow', source: { type: 'user', userId: 'U2' } }]);
    expect(s.store.activeRecipients(p.id)).toEqual([]);
  });

  it('簽章錯誤的請求 401,不處理任何事件', async () => {
    const s = setup();
    const p = await s.svc.createPatient(patientInput);
    const { code } = s.store.createBindCode(p.id, 'family', s.clock());
    const r = await wh(s)([msgEvent('U1', code)], 'AAAA');
    expect(r.status).toBe(401);
    expect(s.store.activeRecipients(p.id)).toEqual([]);
    expect(s.api.replies).toHaveLength(0);
  });

  it('治療師端可解除單一綁定', async () => {
    const s = setup();
    const p = await s.svc.createPatient(patientInput);
    await wh(s)([msgEvent('U1', s.store.createBindCode(p.id, 'family', s.clock()).code)]);
    const id = s.store.listLinks(p.id)[0]!.id;
    expect(s.store.revokeLink(id, s.clock())).toBe(true);
    expect(s.store.revokeLink(id, s.clock())).toBe(false);
    expect(s.store.activeRecipients(p.id)).toEqual([]);
  });
});

describe('外送佇列(4.3 / 4.5 的送出端)', () => {
  async function bound() {
    const s = setup();
    const p = await s.svc.createPatient(patientInput);
    await wh(s)([msgEvent('U1', s.store.createBindCode(p.id, 'family', s.clock()).code)]);
    return { s, p };
  }
  const drain = (s: ReturnType<typeof setup>) => drainOutbox({ repo: s.repo, store: s.store, api: s.api, now: s.clock });

  it('送出給所有綁定者並回寫 sent;重複執行不重送', async () => {
    const { s, p } = await bound();
    await wh(s)([msgEvent('U2', s.store.createBindCode(p.id, 'patient', s.clock()).code)]);
    await queue(s.repo, { id: 'm1', patient_id: p.id });
    expect(await drain(s)).toMatchObject({ sent: 1 });
    expect(s.api.pushes.map((x) => x.to).sort()).toEqual(['U1', 'U2']);
    const row = (await s.repo.get('line_messages', 'm1'))!;
    expect(row).toMatchObject({ status: 'sent', attempts: 1 });
    expect(row.sent_at).not.toBeNull();
    await drain(s);
    expect(s.api.pushes).toHaveLength(2);
  });

  it('沒有綁定者 → skipped 並說明原因', async () => {
    const s = setup();
    const p = await s.svc.createPatient(patientInput);
    await queue(s.repo, { id: 'm1', patient_id: p.id });
    expect(await drain(s)).toMatchObject({ skipped: 1 });
    expect((await s.repo.get('line_messages', 'm1'))?.status_detail).toContain('尚未綁定');
  });

  it('逾時的到達/完成通知不再送出', async () => {
    const { s, p } = await bound();
    await queue(s.repo, { id: 'm1', patient_id: p.id, expires_at: '2026-10-19T18:00:01.000+08:00' });
    expect(await drain(s)).toMatchObject({ skipped: 1, sent: 0 });
    expect(s.api.pushes).toHaveLength(0);
  });

  it('暫時性錯誤最多重試 3 次後標記失敗;429 等永久錯誤立即失敗並說明', async () => {
    const { s, p } = await bound();
    await queue(s.repo, { id: 'm1', patient_id: p.id });
    s.api.results = [{ ok: false, status: 503, retryable: true, detail: 'HTTP 503' }, { ok: false, status: 503, retryable: true, detail: 'HTTP 503' }, { ok: false, status: 503, retryable: true, detail: 'HTTP 503' }];
    expect(await drain(s)).toMatchObject({ retry: 1 });
    expect((await s.repo.get('line_messages', 'm1'))).toMatchObject({ status: 'queued', attempts: 1 });
    await drain(s);
    expect(await drain(s)).toMatchObject({ failed: 1 });
    expect((await s.repo.get('line_messages', 'm1'))).toMatchObject({ status: 'failed', attempts: 3 });

    await queue(s.repo, { id: 'm2', patient_id: p.id, created_at: '2026-10-19T18:01:00.000+08:00', updated_at: '2026-10-19T18:01:00.000+08:00' });
    s.api.results = [{ ok: false, status: 429, retryable: false, detail: 'HTTP 429:已達本月訊息上限或送出過於頻繁' }];
    expect(await drain(s)).toMatchObject({ failed: 1, retry: 0 });
    expect((await s.repo.get('line_messages', 'm2'))?.status_detail).toContain('本月訊息上限');
  });

  it('多位收件者部分失敗:重試時已送達者不重送,同一收件者 retry key 固定', async () => {
    const { s, p } = await bound();
    await wh(s)([msgEvent('U2', s.store.createBindCode(p.id, 'patient', s.clock()).code)]);
    await queue(s.repo, { id: 'm1', patient_id: p.id });
    s.api.byUser.set('U2', { ok: false, status: 503, retryable: true, detail: 'HTTP 503' });
    await drain(s);
    expect(s.api.pushes.map((x) => x.to)).toEqual(['U1', 'U2']);
    s.api.byUser.clear();
    await drain(s);
    expect(s.api.pushes.map((x) => x.to)).toEqual(['U1', 'U2', 'U2']); // U1 不重送
    expect(s.api.pushes[1]!.key).toBe(s.api.pushes[2]!.key);
    expect((await s.repo.get('line_messages', 'm1'))?.status).toBe('sent');
  });

  it('已送出的訊息不可被改回待送(防止重複發送);裝置端較舊的版本不會覆蓋 server 狀態', async () => {
    const { s, p } = await bound();
    const m = await queue(s.repo, { id: 'm1', patient_id: p.id });
    await drain(s);
    const stale = await acceptRow(s.repo, 'line_messages', m); // 裝置推來尚未更新的舊版
    expect(stale).toMatchObject({ applied: false, reject: 'stale' });
    const requeue = await acceptRow(s.repo, 'line_messages', { ...m, updated_at: '2099-01-01T00:00:00.000+08:00' });
    expect(requeue).toMatchObject({ applied: false, reject: 'locked' });
    expect((await s.repo.get('line_messages', 'm1'))?.status).toBe('sent');
  });

  it('裝置時鐘比 server 快時,回寫狀態仍成功', async () => {
    const { s, p } = await bound();
    await queue(s.repo, { id: 'm1', patient_id: p.id, created_at: '2099-01-01T00:00:00.000+08:00', updated_at: '2099-01-01T00:00:00.000+08:00' });
    await drain(s);
    expect((await s.repo.get('line_messages', 'm1'))?.status).toBe('sent');
  });

  it('資料驗證:訊息 1–5 則、個案與服務紀錄須存在且一致', async () => {
    const s = setup();
    const p = await s.svc.createPatient(patientInput);
    const p2 = await s.svc.createPatient({ ...patientInput, name: '乙' });
    const e = await s.svc.createEncounter({ patient_id: p2.id, track: 'self_pay', service_date: '2026-10-19', start_time: '09:00', end_time: '10:00' });
    const base = { id: 'x', patient_id: p.id, encounter_id: null, appointment_id: null, kind: 'hep' as const, payload: { items: [{ type: 'text', text: 'a' }] }, expires_at: null, status: 'queued' as const, status_detail: null, attempts: 0, sent_at: null, created_at: 't', updated_at: 't' };
    expect(await acceptRow(s.repo, 'line_messages', { ...base, payload: { items: [] } })).toMatchObject({ applied: false, reject: 'invalid' });
    expect(await acceptRow(s.repo, 'line_messages', { ...base, payload: { items: Array(6).fill({ type: 'text', text: 'a' }) } })).toMatchObject({ applied: false, reject: 'invalid' });
    expect(await acceptRow(s.repo, 'line_messages', { ...base, patient_id: 'nope' })).toMatchObject({ applied: false, reject: 'orphan' });
    expect(await acceptRow(s.repo, 'line_messages', { ...base, encounter_id: e.id })).toMatchObject({ applied: false, reject: 'conflict' });
  });
});

describe('4.2 預約提醒', () => {
  async function withAppt(now: string, date = '2026-10-20', time = '14:00') {
    const s = setup(now);
    const p = await s.svc.createPatient({ ...patientInput, address: '台北市大安區忠孝東路四段100號', precautions: '心律不整' });
    await wh(s)([msgEvent('U1', s.store.createBindCode(p.id, 'family', s.clock()).code)]);
    const a = await s.svc.createAppointment({ patient_id: p.id, track: 'self_pay', date, start: time, end: '15:00', note: '備註' });
    const run = () => enqueueReminders({ repo: s.repo, store: s.store, now: () => now, clinicName: '診所', contact: '0912-000-000', hour: 18 });
    return { s, p, a, run };
  }

  it('前一日 18:00 後排入一則;同一行程不重複', async () => {
    const { s, run } = await withAppt('2026-10-19T18:30:00+08:00');
    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
    const m = (await s.repo.list('line_messages'))[0]!;
    expect(m).toMatchObject({ kind: 'reminder', status: 'queued' });
    const t = m.payload.items[0]!.text as string;
    expect(t).toContain('明天(週二) 14:00');
    expect(t).toContain('0912-000-000');
    // 不含任何健康/地址/備註資訊
    for (const w of ['心律', '大安', '備註', '王大明', '忠孝']) expect(t).not.toContain(w);
  });

  it('18:00 之前不發;已取消、未綁定、一小時內就開始的不發', async () => {
    expect(await (await withAppt('2026-10-19T17:59:00+08:00')).run()).toBe(0);
    const c = await withAppt('2026-10-19T19:00:00+08:00');
    await c.s.svc.cancelAppointment(c.a.id);
    expect(await c.run()).toBe(0);
    const soon = await withAppt('2026-10-20T13:30:00+08:00');
    expect(await soon.run()).toBe(0);
    const s2 = setup('2026-10-19T19:00:00+08:00');
    const p = await s2.svc.createPatient(patientInput); // 未綁定
    await s2.svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '14:00', end: '15:00' });
    expect(await enqueueReminders({ repo: s2.repo, store: s2.store, now: () => '2026-10-19T19:00:00+08:00', clinicName: '診所', contact: null, hour: 18 })).toBe(0);
  });

  it('提醒時段之後才建立的隔日行程立即補發;改期後會再提醒一次', async () => {
    const { s, a, run } = await withAppt('2026-10-19T21:00:00+08:00', '2026-10-20', '09:00');
    expect(await run()).toBe(1); // 晚上 21:00 才建立明早 09:00 的行程
    await s.svc.updateAppointment(a.id, { start: '10:00', end: '11:00' });
    expect(await run()).toBe(1);
    expect((await s.repo.list('line_messages')).map((m) => m.payload.items[0]!.text as string).some((t) => t.includes('10:00'))).toBe(true);
  });

  it('提醒經外送佇列送出,內容正確', async () => {
    const { s, run } = await withAppt('2026-10-19T18:30:00+08:00');
    await run();
    await drainOutbox({ repo: s.repo, store: s.store, api: s.api, now: () => '2026-10-19T18:31:00+08:00' });
    expect(s.api.pushes).toHaveLength(1);
    expect(s.api.pushes[0]!.to).toBe('U1');
  });
});

let closers: (() => void)[] = [];
afterEach(() => {
  closers.forEach((c) => c());
  closers = [];
});

async function listen(server: ReturnType<typeof createApp>): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('HTTP:webhook 專用埠與管理端點', () => {
  function build() {
    const clock = fakeClock('2026-10-19T18:30:00+08:00');
    const repo = new SqliteRepo(':memory:');
    const api = new FakeLine();
    const line = new LineService(repo, api, SECRET, { clinicName: '診所', contact: null, reminderHour: 18 }, undefined, clock);
    const svc = new DataService({ repo, newId: seqIds(), now: clock, enforceContent: false });
    return { repo, api, line, svc };
  }

  it('webhook 埠:只接受 POST /line/webhook;簽章錯 401、正確 200;其他路徑 404(病歷 API 不在此埠)', async () => {
    const { line } = build();
    const base = await listen(createWebhookServer(line));
    const raw = eventBody([]);
    expect((await fetch(`${base}/line/webhook`, { method: 'POST', body: raw, headers: { 'x-line-signature': 'bad' } })).status).toBe(401);
    expect((await fetch(`${base}/line/webhook`, { method: 'POST', body: raw, headers: { 'x-line-signature': sign(raw) } })).status).toBe(200);
    expect((await fetch(`${base}/api/sync`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/api/line/status`)).status).toBe(404);
    expect((await fetch(`${base}/line/webhook`)).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
  });

  it('管理端點:產生綁定碼 → 家屬綁定 → 列出綁定(不含 LINE id)→ 解除', async () => {
    const { line, svc, repo } = build();
    const base = await listen(createApp(repo, '/nonexistent', { line }));
    const p = await svc.createPatient(patientInput);
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const { code } = (await (await post('/api/line/bindcode', { patient_id: p.id, role: 'family' })).json()) as { code: string };
    expect(code).toMatch(/^\d{6}$/);
    expect((await post('/api/line/bindcode', { patient_id: 'nope' })).status).toBe(404);
    const raw = eventBody([msgEvent('U-x', code)]);
    const whBase = await listen(createWebhookServer(line));
    expect((await fetch(`${whBase}/line/webhook`, { method: 'POST', body: raw, headers: { 'x-line-signature': sign(raw) } })).status).toBe(200);
    const links = ((await (await fetch(`${base}/api/line/links?patient_id=${p.id}`)).json()) as { links: { id: string; status: string }[] }).links;
    expect(links).toHaveLength(1);
    expect(JSON.stringify(links)).not.toContain('U-x');
    expect(await (await post('/api/line/unlink', { id: links[0]!.id })).json()).toEqual({ ok: true });
  });

  it('裝置經 /api/sync 送來 line_messages 後立即送出並回寫狀態', async () => {
    const { line, svc, repo, api } = build();
    const base = await listen(createApp(repo, '/nonexistent', { line }));
    const p = await svc.createPatient(patientInput);
    await wh({ repo, store: line.store, api, svc, clock: fakeClock('2026-10-19T18:00:00+08:00') } as never)([msgEvent('U1', line.store.createBindCode(p.id, 'family', '2026-10-19T18:00:00+08:00').code)]);
    const row: LineMessage = {
      id: 'dev-1', patient_id: p.id, encounter_id: null, appointment_id: null, kind: 'arrive', payload: { items: [{ type: 'text', text: '到了' }] }, expires_at: null,
      status: 'queued', status_detail: null, attempts: 0, sent_at: null, created_at: '2026-10-19T18:20:00.000+08:00', updated_at: '2026-10-19T18:20:00.000+08:00',
    };
    const res = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ since: 0, changes: [{ table: 'line_messages', row }] }) });
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(api.pushes).toHaveLength(1);
    expect((await repo.get('line_messages', 'dev-1'))?.status).toBe('sent');
  });

  it('綁定之後才同步到伺服器的行程,也會立即排入並送出提醒(不必等定時掃描)', async () => {
    const { line, svc, repo, api } = build();
    const base = await listen(createApp(repo, '/nonexistent', { line }));
    const p = await svc.createPatient(patientInput);
    await wh({ repo, store: line.store, api, svc, clock: fakeClock('2026-10-19T18:00:00+08:00') } as never)([msgEvent('U1', line.store.createBindCode(p.id, 'family', '2026-10-19T18:00:00+08:00').code)]);
    // 此時還沒有任何行程;之後裝置同步了「明天」的行程
    // 伺服器時鐘為 2026-10-19 18:30(fakeClock 起點 + 數秒),所以「明天」固定是 2026-10-20,不依賴執行當天的日期
    const a = await svc.createAppointment({ patient_id: p.id, track: 'self_pay', date: '2026-10-20', start: '23:00', end: '23:45' });
    const res = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ since: 0, changes: [{ table: 'appointments', row: a }] }) });
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(api.pushes.some((x) => String(x.messages[0]?.text).includes('23:00'))).toBe(true);
  });

  it('提醒時刻設定:0 是合法值(午夜);未設定/不合法用預設 18', () => {
    expect([parseHour('0'), parseHour('9'), parseHour('23'), parseHour(undefined), parseHour(''), parseHour('24'), parseHour('-1'), parseHour('abc'), parseHour('7.5')]).toEqual([0, 9, 23, 18, 18, 18, 18, 18, 18]);
    expect(createLineService(new SqliteRepo(':memory:'), { LINE_REMINDER_HOUR: '0' }).status().reminder_hour).toBe(0);
  });

  it('未設定時:狀態說明原因、不能產生綁定碼', async () => {
    const repo = new SqliteRepo(':memory:');
    const line = createLineService(repo, {});
    expect(line.status()).toMatchObject({ enabled: false });
    expect(line.status().reason).toContain('LINE_CHANNEL_ACCESS_TOKEN');
    const base = await listen(createApp(repo, '/nonexistent', { line }));
    expect((await fetch(`${base}/api/line/bindcode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"patient_id":"x"}' })).status).toBe(409);
    expect((await line.webhook(Buffer.from('{}'), 'x')).status).toBe(503);
  });
});
