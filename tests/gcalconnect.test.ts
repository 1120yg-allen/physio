import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { SqliteRepo } from '../src/server/db';
import { gcalFiles } from '../src/server/gcal/auth';
import type { FetchFn } from '../src/server/gcal/google';
import { createGcalService } from '../src/server/gcal/service';

const CLIENT_ID = '1234-abc.apps.googleusercontent.com';
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let dirs: string[] = [];
let closers: (() => void)[] = [];
afterEach(() => {
  closers.forEach((c) => c());
  closers = [];
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  dirs = [];
});

function mockGoogle() {
  const calls: { url: string; body: string }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, body });
    if (url === 'https://oauth2.googleapis.com/token') {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        return p.get('code') === 'GOOD' ? json(200, { refresh_token: 'REFRESH', access_token: 'A', expires_in: 3600 }) : json(400, { error: 'invalid_grant 王大明' });
      }
      return json(200, { access_token: 'A', expires_in: 3600 });
    }
    if (url === 'https://www.googleapis.com/calendar/v3/calendars') return json(200, { id: 'cal-123@group.calendar.google.com' });
    if (url.includes('/events')) return json(200, { items: [], nextSyncToken: 'S1' });
    return json(404, {});
  };
  return { fetchFn, calls };
}

function setup(env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'physio-gc-'));
  dirs.push(dir);
  const repo = new SqliteRepo(':memory:');
  const g = mockGoogle();
  const svc = createGcalService(repo, dir, env, g.fetchFn);
  return { dir, repo, svc, files: gcalFiles(dir), ...g };
}

const stateOf = (url: string): string => new URL(url).searchParams.get('state') as string;

describe('在畫面上設定 Google 用戶端', () => {
  it('初始為未啟用、可設定;儲存後狀態更新,檔案權限 600', () => {
    const { svc, files } = setup();
    expect(svc.status()).toMatchObject({ enabled: false, setup_available: true, client_configured: false, authorized: false });
    svc.saveClient(`  ${CLIENT_ID} `, ' secret-xyz ');
    expect(svc.status()).toMatchObject({ client_configured: true, authorized: false, enabled: false });
    expect(svc.status().reason).toContain('尚未連結 Google 帳號');
    expect(statSync(files.clientFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(files.clientFile, 'utf8'))).toEqual({ client_id: CLIENT_ID, client_secret: 'secret-xyz' });
  });

  it('輸入驗證:空白、含空白、格式不對都被拒絕', () => {
    const { svc } = setup();
    expect(() => svc.saveClient('', 'x')).toThrow('請填寫');
    expect(() => svc.saveClient(CLIENT_ID, 'a b')).toThrow('含有空白');
    expect(() => svc.saveClient('not-a-client-id', 'x')).toThrow('格式不對');
  });

  it('環境變數優先於畫面儲存的設定', () => {
    const { svc } = setup({ GCAL_CLIENT_ID: CLIENT_ID, GCAL_CLIENT_SECRET: 's' });
    expect(svc.status().client_configured).toBe(true);
    const url = svc.connectStart('127.0.0.1:8787');
    expect(new URL(url).searchParams.get('client_id')).toBe(CLIENT_ID);
  });
});

describe('連結流程', () => {
  it('授權網址:含 client_id、本機回呼、PKCE、最小權限範圍、離線存取', () => {
    const { svc } = setup();
    svc.saveClient(CLIENT_ID, 's');
    const u = new URL(svc.connectStart('127.0.0.1:8787'));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8787/api/gcal/callback');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.app.created');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('access_type')).toBe('offline');
  });

  it('未設定用戶端、或不是從本機開啟時拒絕', () => {
    const { svc } = setup();
    expect(() => svc.connectStart('127.0.0.1:8787')).toThrow('請先儲存');
    svc.saveClient(CLIENT_ID, 's');
    expect(() => svc.connectStart('192.168.1.5:8787')).toThrow('那台電腦');
    expect(() => svc.connectStart('evil.com')).toThrow('那台電腦');
    expect(() => svc.connectStart(undefined)).toThrow('那台電腦');
    expect(() => svc.connectStart('localhost:8787')).not.toThrow();
  });

  it('完成連結:儲存授權、建立專用行事曆、狀態變為已啟用;state 只能使用一次', async () => {
    const { svc, files, calls } = setup();
    svc.saveClient(CLIENT_ID, 'sec');
    const url = svc.connectStart('127.0.0.1:8787');
    await svc.connectFinish('GOOD', stateOf(url));
    expect(svc.status()).toMatchObject({ enabled: true, authorized: true, client_configured: true });
    expect(JSON.parse(readFileSync(files.tokenFile, 'utf8'))).toEqual({ refresh_token: 'REFRESH' });
    expect(JSON.parse(readFileSync(files.configFile, 'utf8'))).toEqual({ calendar_id: 'cal-123@group.calendar.google.com' });
    expect(statSync(files.tokenFile).mode & 0o777).toBe(0o600);
    // 換碼請求帶 PKCE verifier 與正確的回呼網址
    const ex = new URLSearchParams(calls.find((c) => c.body.includes('authorization_code'))!.body);
    expect(ex.get('redirect_uri')).toBe('http://127.0.0.1:8787/api/gcal/callback');
    expect(ex.get('code_verifier')).toBeTruthy();
    await expect(svc.connectFinish('GOOD', stateOf(url))).rejects.toThrow('逾時或不正確');
  });

  it('state 不符(可能是偽造的回呼)或授權碼無效 → 失敗,不儲存任何授權', async () => {
    const { svc, files } = setup();
    svc.saveClient(CLIENT_ID, 'sec');
    const url = svc.connectStart('127.0.0.1:8787');
    await expect(svc.connectFinish('GOOD', 'forged-state')).rejects.toThrow('逾時或不正確');
    const err = (await svc.connectFinish('BAD', stateOf(url)).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('Google 授權失敗(HTTP 400)');
    expect(err.message).not.toContain('王大明');
    expect(existsSync(files.tokenFile)).toBe(false);
    expect(svc.status().enabled).toBe(false);
  });

  it('中斷連結:刪除授權與行事曆設定,保留用戶端設定;可重新連結', async () => {
    const { svc, files } = setup();
    svc.saveClient(CLIENT_ID, 'sec');
    await svc.connectFinish('GOOD', stateOf(svc.connectStart('127.0.0.1:8787')));
    svc.disconnect();
    expect(svc.status()).toMatchObject({ enabled: false, authorized: false, client_configured: true });
    expect(existsSync(files.tokenFile)).toBe(false);
    expect(existsSync(files.configFile)).toBe(false);
    expect(existsSync(files.clientFile)).toBe(true);
    await svc.connectFinish('GOOD', stateOf(svc.connectStart('127.0.0.1:8787')));
    expect(svc.status().enabled).toBe(true);
  });

  it('重新啟動後(重新載入設定檔)仍為已連結', async () => {
    const a = setup();
    a.svc.saveClient(CLIENT_ID, 'sec');
    await a.svc.connectFinish('GOOD', stateOf(a.svc.connectStart('127.0.0.1:8787')));
    const again = createGcalService(a.repo, a.dir, {}, a.fetchFn);
    expect(again.status()).toMatchObject({ enabled: true, authorized: true });
  });
});

describe('HTTP 端點', () => {
  async function boot() {
    const s = setup();
    const server = createApp(s.repo, '/nonexistent', { gcal: s.svc });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    return { ...s, base: `http://127.0.0.1:${port}`, port };
  }
  const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('完整流程:狀態 → 儲存用戶端 → 取得授權網址 → Google 導回 → 已連結 → 中斷', async () => {
    const { base, port, svc } = await boot();
    expect(await (await fetch(`${base}/api/gcal/status`)).json()).toMatchObject({ enabled: false, setup_available: true, client_configured: false });
    expect((await post(base, '/api/gcal/connect', {})).status).toBe(400); // 尚未儲存用戶端

    expect((await post(base, '/api/gcal/client', { client_id: 'bad', client_secret: 'x' })).status).toBe(400);
    const saved = await post(base, '/api/gcal/client', { client_id: CLIENT_ID, client_secret: 'sec' });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ client_configured: true });

    const { url } = (await (await post(base, '/api/gcal/connect', {})).json()) as { url: string };
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/api/gcal/callback`);

    const cb = await fetch(`${base}/api/gcal/callback?code=GOOD&state=${stateOf(url)}`);
    const html = await cb.text();
    expect(cb.status).toBe(200);
    expect(html).toContain('已連結 Google 行事曆');
    expect(svc.status().enabled).toBe(true);

    expect(await (await post(base, '/api/gcal/disconnect', {})).json()).toMatchObject({ enabled: false, authorized: false });
  });

  it('回呼:偽造 state、使用者取消、缺參數 → 顯示說明頁,不連結', async () => {
    const { base, svc } = await boot();
    svc.saveClient(CLIENT_ID, 'sec');
    expect(await (await fetch(`${base}/api/gcal/callback?code=GOOD&state=forged`)).text()).toContain('連結未完成');
    expect(await (await fetch(`${base}/api/gcal/callback?error=access_denied`)).text()).toContain('你取消了 Google 授權');
    expect(await (await fetch(`${base}/api/gcal/callback`)).text()).toContain('授權資料不完整');
    expect(svc.status().enabled).toBe(false);
  });

  it('非本機的 Host(例如經區網/網域存取)不能發起連結', async () => {
    const { base, svc } = await boot();
    svc.saveClient(CLIENT_ID, 'sec');
    // fetch 不允許改 Host,改用 node:http 直接送
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const u = new URL(`${base}/api/gcal/connect`);
      const r = request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { host: 'physio.example.ts.net', 'content-type': 'application/json' } }, (res) => resolve(res.statusCode ?? 0));
      r.end('{}');
    });
    expect(status).toBe(400);
  });
});
