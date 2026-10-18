import { EventExistsError, SyncTokenGoneError, type CalendarApi, type CalendarEvent, type EventBody } from '../src/server/gcal/types';

/** 記憶體版 Google 行事曆:模擬 etag、updated、已刪除事件仍會出現在 list(status=cancelled)、syncToken */
export class FakeCalendar implements CalendarApi {
  events = new Map<string, CalendarEvent>();
  private version = 0;
  private changedAt = new Map<string, number>();
  calls = { insert: 0, patch: 0, remove: 0, list: 0 };
  invalidateToken = false;

  constructor(private readonly now: () => string) {}

  private touch(ev: CalendarEvent): CalendarEvent {
    this.version++;
    ev.etag = `etag-${this.version}`;
    ev.updated = this.now();
    this.changedAt.set(ev.id, this.version);
    this.events.set(ev.id, ev);
    return structuredClone(ev);
  }

  private apply(ev: CalendarEvent, b: EventBody): void {
    if (b.summary !== undefined) ev.summary = b.summary;
    if (b.location !== undefined) ev.location = b.location;
    if (b.description !== undefined) ev.description = b.description;
    if (b.start) ev.start = { dateTime: b.start.dateTime };
    if (b.end) ev.end = { dateTime: b.end.dateTime };
    if (b.status) ev.status = b.status;
    if (b.extendedProperties) ev.extendedProperties = structuredClone(b.extendedProperties);
  }

  async insert(id: string, body: EventBody): Promise<CalendarEvent> {
    this.calls.insert++;
    if (this.events.has(id)) throw new EventExistsError(); // Google 即使是已刪除的 id 也會 409
    const ev: CalendarEvent = { id, etag: '', status: 'confirmed' };
    this.apply(ev, body);
    return this.touch(ev);
  }

  async patch(id: string, body: EventBody): Promise<CalendarEvent> {
    this.calls.patch++;
    const ev = this.events.get(id);
    if (!ev) throw new Error('404');
    this.apply(ev, body);
    return this.touch(ev);
  }

  async remove(id: string): Promise<void> {
    this.calls.remove++;
    const ev = this.events.get(id);
    if (ev && ev.status !== 'cancelled') {
      ev.status = 'cancelled';
      this.touch(ev);
    }
  }

  async list(syncToken: string | null): Promise<{ events: CalendarEvent[]; nextSyncToken: string }> {
    this.calls.list++;
    if (syncToken && this.invalidateToken) {
      this.invalidateToken = false;
      throw new SyncTokenGoneError();
    }
    const since = syncToken ? Number(syncToken.replace('tok-', '')) : 0;
    const events = [...this.events.values()].filter((e) => (this.changedAt.get(e.id) ?? 0) > since && (syncToken || e.status !== 'cancelled')).map((e) => structuredClone(e));
    return { events, nextSyncToken: `tok-${this.version}` };
  }

  // ── 模擬使用者在 Google 行事曆上的操作 ──
  userCreate(id: string, summary: string, startIso: string, endIso: string, location?: string): void {
    const ev: CalendarEvent = { id, etag: '', status: 'confirmed', summary, start: { dateTime: startIso }, end: { dateTime: endIso } };
    if (location) ev.location = location;
    this.touch(ev);
  }
  userMove(id: string, startIso: string, endIso: string): void {
    const ev = this.events.get(id) as CalendarEvent;
    ev.start = { dateTime: startIso };
    ev.end = { dateTime: endIso };
    this.touch(ev);
  }
  userDelete(id: string): void {
    const ev = this.events.get(id) as CalendarEvent;
    ev.status = 'cancelled';
    this.touch(ev);
  }
  liveEvents(): CalendarEvent[] {
    return [...this.events.values()].filter((e) => e.status !== 'cancelled');
  }
}
