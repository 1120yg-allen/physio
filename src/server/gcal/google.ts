// Google Calendar REST 客戶端(僅用 fetch,無額外相依)。
// 錯誤訊息只含 HTTP 狀態碼,不帶回應本文,避免個資進入 log。
import { EventExistsError, SyncTokenGoneError, type CalendarApi, type CalendarEvent, type EventBody } from './types';

const BASE = 'https://www.googleapis.com/calendar/v3';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    what: string,
  ) {
    super(`Google 行事曆 ${what} 失敗(HTTP ${status})`);
  }
}

export class GoogleCalendarApi implements CalendarApi {
  constructor(
    private readonly calendarId: string,
    private readonly getAccessToken: () => Promise<string>,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private url(path = '', query?: Record<string, string>): string {
    const q = query ? `?${new URLSearchParams(query).toString()}` : '';
    return `${BASE}/calendars/${encodeURIComponent(this.calendarId)}/events${path}${q}`;
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken();
    return this.fetchFn(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  }

  async insert(id: string, body: EventBody): Promise<CalendarEvent> {
    const res = await this.call(this.url(), { method: 'POST', body: JSON.stringify({ id, ...body }) });
    if (res.status === 409) throw new EventExistsError();
    if (!res.ok) throw new GoogleApiError(res.status, '新增事件');
    return (await res.json()) as CalendarEvent;
  }

  async patch(id: string, body: EventBody): Promise<CalendarEvent> {
    const res = await this.call(this.url(`/${encodeURIComponent(id)}`), { method: 'PATCH', body: JSON.stringify(body) });
    if (!res.ok) throw new GoogleApiError(res.status, '更新事件');
    return (await res.json()) as CalendarEvent;
  }

  async remove(id: string): Promise<void> {
    const res = await this.call(this.url(`/${encodeURIComponent(id)}`), { method: 'DELETE' });
    if (res.ok || res.status === 404 || res.status === 410) return;
    throw new GoogleApiError(res.status, '刪除事件');
  }

  async list(syncToken: string | null): Promise<{ events: CalendarEvent[]; nextSyncToken: string }> {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    for (;;) {
      // showDeleted:才能收到被刪除的事件;singleEvents:重複事件展開為單次(syncToken 前後須一致)
      const query: Record<string, string> = { showDeleted: 'true', singleEvents: 'true', maxResults: '250' };
      if (syncToken) query.syncToken = syncToken;
      if (pageToken) query.pageToken = pageToken;
      const res = await this.call(this.url('', query));
      if (res.status === 410) throw new SyncTokenGoneError();
      if (!res.ok) throw new GoogleApiError(res.status, '讀取事件');
      const page = (await res.json()) as { items?: CalendarEvent[]; nextPageToken?: string; nextSyncToken?: string };
      events.push(...(page.items ?? []));
      if (page.nextPageToken) {
        pageToken = page.nextPageToken;
        continue;
      }
      if (!page.nextSyncToken) throw new GoogleApiError(500, '讀取事件(缺少 syncToken)');
      return { events, nextSyncToken: page.nextSyncToken };
    }
  }
}
