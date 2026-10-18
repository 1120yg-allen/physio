import { describe, expect, it } from 'vitest';
import { accessTokenProvider } from '../src/server/gcal/auth';
import { GoogleApiError, GoogleCalendarApi, type FetchFn } from '../src/server/gcal/google';
import { GcalService } from '../src/server/gcal/service';
import { EventExistsError, SyncTokenGoneError } from '../src/server/gcal/types';
import { SqliteRepo } from '../src/server/db';
import { FakeCalendar } from './fakeCalendar';

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: FetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

describe('GoogleCalendarApi 請求格式', () => {
  it('insert:POST、帶 id 與授權標頭;409 → EventExistsError', async () => {
    const m = mockFetch(() => json(200, { id: 'pabc', etag: 'e1', status: 'confirmed' }));
    const api = new GoogleCalendarApi('cal@group.calendar.google.com', async () => 'tok', m.fn);
    await api.insert('pabc', { summary: 'x' });
    expect(m.calls[0]!.url).toBe('https://www.googleapis.com/calendar/v3/calendars/cal%40group.calendar.google.com/events');
    expect(m.calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(m.calls[0]!.init.body as string)).toEqual({ id: 'pabc', summary: 'x' });
    expect((m.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const dup = new GoogleCalendarApi('c', async () => 't', mockFetch(() => json(409, {})).fn);
    await expect(dup.insert('a', {})).rejects.toBeInstanceOf(EventExistsError);
  });

  it('patch / remove;remove 對 404、410 視為成功,其他錯誤丟出且不含回應本文', async () => {
    const m = mockFetch((_u, i) => (i.method === 'DELETE' ? new Response(null, { status: 410 }) : json(200, { id: 'p', etag: 'e2', status: 'confirmed' })));
    const api = new GoogleCalendarApi('c', async () => 't', m.fn);
    await api.patch('p1', { summary: 'y' });
    expect(m.calls[0]!.init.method).toBe('PATCH');
    expect(m.calls[0]!.url).toMatch(/\/events\/p1$/);
    await expect(api.remove('p1')).resolves.toBeUndefined();
    const bad = new GoogleCalendarApi('c', async () => 't', mockFetch(() => json(500, { error: '王大明的資料' })).fn);
    const err = await bad.remove('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect((err as Error).message).toBe('Google 行事曆 刪除事件 失敗(HTTP 500)');
    expect((err as Error).message).not.toContain('王大明');
  });

  it('list:分頁合併、帶 showDeleted 與 syncToken;410 → SyncTokenGoneError', async () => {
    let n = 0;
    const m = mockFetch(() => {
      n++;
      return n === 1 ? json(200, { items: [{ id: 'a' }], nextPageToken: 'pg2' }) : json(200, { items: [{ id: 'b' }], nextSyncToken: 'SYNC2' });
    });
    const api = new GoogleCalendarApi('c', async () => 't', m.fn);
    const r = await api.list('OLD');
    expect(r.events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(r.nextSyncToken).toBe('SYNC2');
    const u1 = new URL(m.calls[0]!.url);
    expect(u1.searchParams.get('syncToken')).toBe('OLD');
    expect(u1.searchParams.get('showDeleted')).toBe('true');
    expect(new URL(m.calls[1]!.url).searchParams.get('pageToken')).toBe('pg2');
    const gone = new GoogleCalendarApi('c', async () => 't', mockFetch(() => json(410, {})).fn);
    await expect(gone.list('X')).rejects.toBeInstanceOf(SyncTokenGoneError);
  });
});

describe('access token 管理', () => {
  it('到期前重用,到期後重新換取;失敗訊息不含回應內容', async () => {
    let now = 0;
    const m = mockFetch(() => json(200, { access_token: `T${m.calls.length}`, expires_in: 3600 }));
    const get = accessTokenProvider({ clientId: 'id', clientSecret: 'sec' }, 'refresh', m.fn, () => now);
    expect(await get()).toBe('T1');
    now = 1_000_000;
    expect(await get()).toBe('T1');
    now = 3_600_000;
    expect(await get()).toBe('T2');
    expect(m.calls).toHaveLength(2);
    const body = new URLSearchParams(m.calls[0]!.init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh');
    const bad = accessTokenProvider({ clientId: 'i', clientSecret: 's' }, 'r', mockFetch(() => json(400, { error: 'invalid_grant' })).fn);
    await expect(bad()).rejects.toThrow('重新執行 npm run gcal:auth');
  });
});

describe('GcalService', () => {
  it('未設定時停用並說明原因;不會執行', async () => {
    const svc = new GcalService(new SqliteRepo(':memory:'), null, 'minimal', '尚未授權');
    expect(svc.status()).toMatchObject({ enabled: false, reason: '尚未授權' });
    expect((await svc.run()).last_run_at).toBeNull();
  });

  it('同步失敗只記錄通用錯誤並可再次執行;不會同時重疊執行', async () => {
    const cal = new FakeCalendar(() => '2026-10-18T09:00:00.000+08:00');
    let fail = true;
    let concurrent = 0;
    let maxConcurrent = 0;
    const api = {
      ...cal,
      insert: cal.insert.bind(cal), patch: cal.patch.bind(cal), remove: cal.remove.bind(cal),
      list: async (t: string | null) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        if (fail) throw new GoogleApiError(503, '讀取事件');
        return cal.list(t);
      },
    };
    const svc = new GcalService(new SqliteRepo(':memory:'), api, 'minimal');
    await Promise.all([svc.run(), svc.run(), svc.run()]);
    expect(maxConcurrent).toBe(1);
    expect(svc.status()).toMatchObject({ last_ok: false, last_error: 'Google 行事曆 讀取事件 失敗(HTTP 503)' });
    fail = false;
    expect((await svc.run()).last_ok).toBe(true);
  });
});
