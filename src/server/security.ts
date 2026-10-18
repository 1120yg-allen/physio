// 資安防線:Host 白名單(防 DNS 重綁定)、跨站請求檢查、選用的密碼登入、存取紀錄、安全標頭、檔案權限。
// 存取紀錄只記錄時間、來源 IP、方法、路徑(不含查詢字串與內容)、狀態碼——絕不記錄個案資料。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

// ───────────── Host 白名單 ─────────────

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];

/** 去掉埠號、轉小寫 */
export function hostnameOf(hostHeader: string | undefined): string {
  return (hostHeader ?? '').toLowerCase().replace(/^(\[[^\]]+\]|[^:]+)(?::\d+)?$/, '$1');
}

export interface HostPolicy {
  allowed: Set<string>;
}

/** 預設只允許本機名稱;經 Tailscale 等網域存取時,以 PHYSIO_ALLOWED_HOSTS 明列(逗號分隔) */
export function hostPolicy(env: NodeJS.ProcessEnv = process.env): HostPolicy {
  const extra = (env.PHYSIO_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { allowed: new Set([...LOOPBACK, ...extra]) };
}

export const hostAllowed = (policy: HostPolicy, hostHeader: string | undefined): boolean => policy.allowed.has(hostnameOf(hostHeader));

/**
 * 跨站檢查:會改變資料的請求必須是 application/json,且若帶有 Origin 必須與 Host 同源。
 * (瀏覽器裡任何網頁都可能對 127.0.0.1 發出簡單的跨站 POST;此檢查讓它們無法寫入。)
 */
export function crossSiteBlocked(req: IncomingMessage): string | null {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return null;
  const ct = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!ct.startsWith('application/json') && !(req.url ?? '').startsWith('/line/')) return '只接受 application/json';
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      if (new URL(origin).host.toLowerCase() !== String(req.headers.host ?? '').toLowerCase()) return '跨來源請求被拒絕';
    } catch {
      return '來源格式錯誤';
    }
  } else if (origin === 'null') return '跨來源請求被拒絕';
  return null;
}

// ───────────── 安全標頭 ─────────────

export function securityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
}

// ───────────── 密碼登入(選用) ─────────────

const COOKIE = 'physio_session';
const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

export class SessionAuth {
  private sessions = new Map<string, number>();
  private fails = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly password: string,
    private readonly ttlMs = 12 * 3600_000,
    private readonly nowMs: () => number = Date.now,
  ) {}

  /** 密碼比對(固定時間);連續錯 5 次同一來源鎖定 5 分鐘 */
  login(password: string, ip: string): { ok: true; token: string } | { ok: false; locked: boolean } {
    const f = this.fails.get(ip);
    if (f && f.until > this.nowMs()) return { ok: false, locked: true };
    if (timingSafeEqual(sha(password), sha(this.password))) {
      this.fails.delete(ip);
      const token = randomBytes(32).toString('hex');
      this.sessions.set(token, this.nowMs() + this.ttlMs);
      return { ok: true, token };
    }
    const count = (f && f.until <= this.nowMs() && f.until !== 0 ? 0 : (f?.count ?? 0)) + 1;
    this.fails.set(ip, { count, until: count >= 5 ? this.nowMs() + 5 * 60_000 : 0 });
    return { ok: false, locked: count >= 5 };
  }

  tokenFrom(req: IncomingMessage): string | null {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`).exec(String(req.headers.cookie ?? ''));
    return m ? (m[1] as string) : null;
  }

  isAuthenticated(req: IncomingMessage): boolean {
    const t = this.tokenFrom(req);
    if (!t) return false;
    const exp = this.sessions.get(t);
    if (exp === undefined) return false;
    if (exp < this.nowMs()) {
      this.sessions.delete(t);
      return false;
    }
    return true;
  }

  logout(req: IncomingMessage): void {
    const t = this.tokenFrom(req);
    if (t) this.sessions.delete(t);
  }

  cookie(token: string, secure: boolean): string {
    // SameSite=Lax:Google 授權完成導回本機時(頂層跨站導覽)仍會帶上 cookie;寫入類請求另有 JSON/Origin 檢查
    return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(this.ttlMs / 1000)}${secure ? '; Secure' : ''}`;
  }

  clearCookie(): string {
    return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }
}

/** 登入頁:以 401 回應(讓 Service Worker 不會把它當成正常頁面快取) */
export const LOGIN_PAGE = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登入</title>
<body style="font:18px/1.6 -apple-system,'PingFang TC',sans-serif;max-width:22em;margin:4em auto;padding:0 1em">
<h1>居家物理治療管理系統</h1><p>請輸入密碼。</p>
<form id="f"><input id="p" type="password" autocomplete="current-password" autofocus style="width:100%;font:inherit;padding:.6em;box-sizing:border-box">
<p><button style="font:inherit;padding:.6em 1.4em">登入</button></p><p id="m" style="color:#b42318"></p></form>
<script src="/_login.js"></script></body></html>`;

export const LOGIN_JS = `document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('p').value }) });
  if (r.ok) { location.reload(); return; }
  document.getElementById('m').textContent = r.status === 429 ? '錯誤次數過多,請 5 分鐘後再試' : '密碼不正確';
});`;

// ───────────── 存取紀錄 ─────────────

export class AccessLog {
  constructor(private readonly file: string) {}

  /** 一行一筆:時間、來源 IP、方法、路徑(不含查詢字串)、狀態碼。不記錄 Cookie、標頭、內容。 */
  record(ip: string, method: string, url: string, status: number): void {
    const path = url.split('?')[0]?.slice(0, 200) ?? '';
    appendFile(this.file, `${new Date().toISOString()}\t${ip}\t${method}\t${path}\t${status}\n`, { mode: 0o600 }, () => undefined);
  }
}

// ───────────── 檔案權限 ─────────────

/** 資料目錄 700、資料庫與備份檔 600(僅限本機使用者讀寫)。非 POSIX 系統忽略錯誤。 */
export function hardenPermissions(dataDir: string, dbPath: string, backupDir: string): void {
  const tryChmod = (p: string, mode: number): void => {
    try {
      if (existsSync(p)) chmodSync(p, mode);
    } catch {
      /* Windows 等不支援時略過 */
    }
  };
  for (const d of [dataDir, backupDir]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    tryChmod(d, 0o700);
  }
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) tryChmod(f, 0o600);
  for (const f of existsSync(backupDir) ? readdirSync(backupDir) : []) {
    const full = join(backupDir, f);
    if (statSync(full).isFile()) tryChmod(full, 0o600);
  }
}
