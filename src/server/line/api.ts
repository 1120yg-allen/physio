// LINE Messaging API 抽象與實作。錯誤只帶 HTTP 狀態與通用說明,不帶回應本文(可能含個資)。
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type LineMessageObj = Record<string, unknown>;

export type PushResult = { ok: true } | { ok: false; status: number; retryable: boolean; detail: string };

export interface LineApi {
  /** 推送訊息;retryKey 為 UUID,LINE 於 24 小時內對相同 retryKey 不重複發送 */
  push(to: string, messages: LineMessageObj[], retryKey: string): Promise<PushResult>;
  reply(replyToken: string, messages: LineMessageObj[]): Promise<PushResult>;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** 由任意字串決定性地產生 UUID 格式的 retry key(同一訊息、同一收件者永遠得到同一個) */
export function retryKeyFor(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function describe(status: number): { retryable: boolean; detail: string } {
  if (status === 429) return { retryable: false, detail: 'HTTP 429:已達本月訊息上限或送出過於頻繁' };
  if (status === 400) return { retryable: false, detail: 'HTTP 400:訊息格式或收件者無效' };
  if (status === 401 || status === 403) return { retryable: false, detail: `HTTP ${status}:頻道權杖無效或權限不足,請檢查 LINE_CHANNEL_ACCESS_TOKEN` };
  if (status >= 500) return { retryable: true, detail: `HTTP ${status}:LINE 服務暫時異常,稍後重試` };
  return { retryable: false, detail: `HTTP ${status}` };
}

export class HttpLineApi implements LineApi {
  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: FetchFn = fetch,
    /** 預設為 LINE 正式 API;可改為本機模擬伺服器做測試 */
    private readonly baseUrl: string = 'https://api.line.me',
  ) {}

  private async post(path: string, body: unknown, extra: Record<string, string> = {}): Promise<PushResult> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/v2/bot/message/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': 'application/json', ...extra },
        body: JSON.stringify(body),
      });
      return res.ok ? { ok: true } : { ok: false, status: res.status, ...describe(res.status) };
    } catch {
      return { ok: false, status: 0, retryable: true, detail: '無法連線到 LINE(網路問題),稍後重試' };
    }
  }

  push(to: string, messages: LineMessageObj[], retryKey: string): Promise<PushResult> {
    return this.post('push', { to, messages }, { 'x-line-retry-key': retryKey });
  }

  reply(replyToken: string, messages: LineMessageObj[]): Promise<PushResult> {
    return this.post('reply', { replyToken, messages });
  }
}

/** 驗證 webhook 簽章:X-Line-Signature = base64(HMAC-SHA256(channelSecret, 原始請求本文)) */
export function verifySignature(rawBody: Buffer | string, channelSecret: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest();
  let got: Buffer;
  try {
    got = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return got.length === expected.length && timingSafeEqual(got, expected);
}
