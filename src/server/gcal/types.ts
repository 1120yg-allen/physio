// Google Calendar 抽象介面:同步引擎只依賴此介面,測試用記憶體實作,正式用 REST 實作。

export interface CalendarEvent {
  id: string;
  etag: string;
  status: 'confirmed' | 'cancelled' | 'tentative';
  summary?: string;
  location?: string;
  description?: string;
  /** 全天事件只有 date,不處理 */
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  /** RFC3339 最後更新時間 */
  updated?: string;
  extendedProperties?: { private?: Record<string, string> };
}

/** 寫入用事件內容(PATCH/insert) */
export interface EventBody {
  summary?: string;
  location?: string;
  description?: string;
  start?: { dateTime: string; timeZone: string };
  end?: { dateTime: string; timeZone: string };
  status?: 'confirmed' | 'cancelled';
  extendedProperties?: { private: Record<string, string> };
}

/** 事件 id 已存在(重複建立) */
export class EventExistsError extends Error {}
/** syncToken 失效,須全量重抓 */
export class SyncTokenGoneError extends Error {}

export interface CalendarApi {
  /** 以指定 id 建立事件;已存在丟 EventExistsError */
  insert(id: string, body: EventBody): Promise<CalendarEvent>;
  patch(id: string, body: EventBody): Promise<CalendarEvent>;
  /** 刪除;不存在或已刪除視為成功 */
  remove(id: string): Promise<void>;
  /** 列出變更(含已刪除)。無 syncToken 時全量;token 失效丟 SyncTokenGoneError */
  list(syncToken: string | null): Promise<{ events: CalendarEvent[]; nextSyncToken: string }>;
}
