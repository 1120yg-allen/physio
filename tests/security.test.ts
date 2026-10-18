import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { backupNow } from '../src/server/backup';
import { SqliteRepo } from '../src/server/db';
import { AccessLog, SessionAuth, hardenPermissions, hostAllowed, hostPolicy, hostnameOf } from '../src/server/security';

let closers: (() => void)[] = [];
let dirs: string[] = [];
afterEach(() => {
  closers.forEach((c) => c());
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  closers = [];
  dirs = [];
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'physio-sec-'));
  dirs.push(d);
  return d;
};

async function boot(opts: { password?: string; hostsEnv?: NodeJS.ProcessEnv; log?: boolean } = {}) {
  const dir = tmp();
  const repo = new SqliteRepo(':memory:');
  const logFile = join(dir, 'access.log');
  const auth = opts.password ? new SessionAuth(opts.password) : undefined;
  const server = createApp(repo, join(dir, 'nodist'), { hosts: hostPolicy(opts.hostsEnv ?? {}), ...(auth ? { auth } : {}), ...(opts.log ? { accessLog: new AccessLog(logFile) } : {}) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => server.close());
  const port = (server.address() as AddressInfo).port;
  return { port, base: `http://127.0.0.1:${port}`, logFile, dir };
}

/** 可自訂 Host/Origin 等標頭的請求(fetch 不允許改 Host) */
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let t = '';
      res.on('data', (c: Buffer) => (t += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: t }));
    });
    r.on('error', reject);
    r.end(body);
  });
}
const JSONH = { 'content-type': 'application/json' };

describe('Host 白名單(防 DNS 重綁定)', () => {
  it('hostname 解析與預設白名單', () => {
    expect(hostnameOf('127.0.0.1:8787')).toBe('127.0.0.1');
    expect(hostnameOf('LocalHost:3000')).toBe('localhost');
    expect(hostnameOf('[::1]:8787')).toBe('[::1]');
    const p = hostPolicy({});
    expect(hostAllowed(p, '127.0.0.1:8787')).toBe(true);
    expect(hostAllowed(p, 'localhost')).toBe(true);
    expect(hostAllowed(p, 'evil.example.com:8787')).toBe(false);
    expect(hostAllowed(p, undefined)).toBe(false);
    expect(hostAllowed(hostPolicy({ PHYSIO_ALLOWED_HOSTS: 'mac.tail1234.ts.net, other.local' }), 'mac.tail1234.ts.net')).toBe(true);
  });

  it('非白名單的 Host(例如重綁定到 127.0.0.1 的惡意網域)一律 421,連健康檢查也不回應', async () => {
    const { port } = await boot();
    expect((await raw(port, 'GET', '/api/health', { host: `evil.example.com:${port}` })).status).toBe(421);
    expect((await raw(port, 'POST', '/api/sync', { ...JSONH, host: 'attacker.test' }, '{"since":0,"changes":[]}')).status).toBe(421);
    expect((await raw(port, 'GET', '/api/health', { host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await raw(port, 'GET', '/api/health', { host: `localhost:${port}` })).status).toBe(200);
  });

  it('以 PHYSIO_ALLOWED_HOSTS 明列的網域可通過', async () => {
    const { port } = await boot({ hostsEnv: { PHYSIO_ALLOWED_HOSTS: 'mac.tail1234.ts.net' } });
    expect((await raw(port, 'GET', '/api/health', { host: 'mac.tail1234.ts.net' })).status).toBe(200);
  });
});

describe('跨站請求防護', () => {
  it('寫入請求必須是 JSON(跨站表單/text/plain 簡單請求無法寫入)', async () => {
    const { port } = await boot();
    const h = { host: `127.0.0.1:${port}` };
    expect((await raw(port, 'POST', '/api/sync', { ...h, 'content-type': 'text/plain' }, '{"since":0,"changes":[]}')).status).toBe(415);
    expect((await raw(port, 'POST', '/api/sync', { ...h, 'content-type': 'application/x-www-form-urlencoded' }, 'a=b')).status).toBe(415);
    expect((await raw(port, 'POST', '/api/sync', h, '{}')).status).toBe(415);
    expect((await raw(port, 'POST', '/api/sync', { ...h, ...JSONH }, '{"since":0,"changes":[]}')).status).toBe(200);
  });

  it('帶有跨來源 Origin 的寫入被拒;同源或無 Origin 通過;Origin: null 被拒', async () => {
    const { port } = await boot();
    const h = { host: `127.0.0.1:${port}`, ...JSONH };
    const body = '{"since":0,"changes":[]}';
    expect((await raw(port, 'POST', '/api/sync', { ...h, origin: 'https://evil.example.com' }, body)).status).toBe(403);
    expect((await raw(port, 'POST', '/api/sync', { ...h, origin: 'null' }, body)).status).toBe(403);
    expect((await raw(port, 'POST', '/api/sync', { ...h, origin: `http://127.0.0.1:${port}` }, body)).status).toBe(200);
  });
});

describe('安全標頭', () => {
  it('CSP、nosniff、禁止嵌入框架、不送 Referer;API 不快取', async () => {
    const { port } = await boot();
    const r = await raw(port, 'GET', '/api/health', { host: `127.0.0.1:${port}` });
    expect(String(r.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(String(r.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('密碼登入(選用)', () => {
  it('未登入:API 401、頁面為 401 登入頁(不被 Service Worker 當成可快取頁面);健康檢查與登入狀態不需登入', async () => {
    const { port } = await boot({ password: 'secret-pw' });
    const h = { host: `127.0.0.1:${port}` };
    expect((await raw(port, 'POST', '/api/sync', { ...h, ...JSONH }, '{"since":0,"changes":[]}')).status).toBe(401);
    expect((await raw(port, 'GET', '/api/line/status', h)).status).toBe(401);
    const page = await raw(port, 'GET', '/', h);
    expect(page.status).toBe(401);
    expect(page.text).toContain('請輸入密碼');
    expect((await raw(port, 'GET', '/api/health', h)).status).toBe(200);
    expect(JSON.parse((await raw(port, 'GET', '/api/auth/status', h)).text)).toEqual({ required: true, authenticated: false });
  });

  it('登入成功取得 HttpOnly + SameSite=Lax cookie,之後可存取;登出後失效', async () => {
    const { port } = await boot({ password: 'secret-pw' });
    const h = { host: `127.0.0.1:${port}`, ...JSONH };
    const login = await raw(port, 'POST', '/api/login', h, '{"password":"secret-pw"}');
    expect(login.status).toBe(200);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/physio_session=[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\//);
    expect(cookie).not.toContain('Secure'); // 本機 http
    const c = cookie.split(';')[0] as string;
    expect((await raw(port, 'POST', '/api/sync', { ...h, cookie: c }, '{"since":0,"changes":[]}')).status).toBe(200);
    expect(JSON.parse((await raw(port, 'GET', '/api/auth/status', { host: h.host, cookie: c })).text)).toEqual({ required: true, authenticated: true });
    expect((await raw(port, 'POST', '/api/logout', { ...h, cookie: c }, '{}')).status).toBe(200);
    expect((await raw(port, 'POST', '/api/sync', { ...h, cookie: c }, '{"since":0,"changes":[]}')).status).toBe(401);
  });

  it('經 HTTPS 代理(X-Forwarded-Proto)時 cookie 加 Secure', async () => {
    const { port } = await boot({ password: 'pw' });
    const r = await raw(port, 'POST', '/api/login', { host: `127.0.0.1:${port}`, ...JSONH, 'x-forwarded-proto': 'https' }, '{"password":"pw"}');
    expect(String(r.headers['set-cookie'])).toContain('Secure');
  });

  it('密碼錯誤 401;連續錯 5 次同一來源鎖定(429),鎖定期間即使密碼正確也不行', async () => {
    const { port } = await boot({ password: 'right' });
    const h = { host: `127.0.0.1:${port}`, ...JSONH };
    for (let i = 0; i < 4; i++) expect((await raw(port, 'POST', '/api/login', h, '{"password":"wrong"}')).status).toBe(401);
    expect((await raw(port, 'POST', '/api/login', h, '{"password":"wrong"}')).status).toBe(429);
    expect((await raw(port, 'POST', '/api/login', h, '{"password":"right"}')).status).toBe(429);
  }, 20_000);

  it('偽造或過期的 token 無效;session 逾時失效', () => {
    let now = 0;
    const a = new SessionAuth('pw', 1000, () => now);
    const ok = a.login('pw', '1.1.1.1');
    expect(ok.ok).toBe(true);
    const token = (ok as { token: string }).token;
    const req = (t: string) => ({ headers: { cookie: `physio_session=${t}` } }) as never;
    expect(a.isAuthenticated(req(token))).toBe(true);
    expect(a.isAuthenticated(req('0'.repeat(64)))).toBe(false);
    expect(a.isAuthenticated(req('abc'))).toBe(false);
    now = 1001;
    expect(a.isAuthenticated(req(token))).toBe(false);
  });

  it('密碼不會出現在任何回應或存取紀錄', async () => {
    const { port, logFile } = await boot({ password: 'TOP-SECRET-PW', log: true });
    const h = { host: `127.0.0.1:${port}`, ...JSONH };
    const r = await raw(port, 'POST', '/api/login', h, '{"password":"TOP-SECRET-PW"}');
    await new Promise((res) => setTimeout(res, 100));
    expect(r.text).not.toContain('TOP-SECRET-PW');
    expect(readFileSync(logFile, 'utf8')).not.toContain('TOP-SECRET-PW');
  });
});

describe('存取紀錄(SPEC §8):不含個案資料', () => {
  it('只有時間、IP、方法、路徑、狀態碼;查詢字串(含個案 id、授權碼)與內容、Cookie 都不記', async () => {
    const { port, logFile } = await boot({ log: true });
    const h = { host: `127.0.0.1:${port}` };
    await raw(port, 'GET', '/api/line/links?patient_id=PATIENT-SECRET-ID-123', h);
    await raw(port, 'GET', '/api/gcal/callback?code=OAUTH-SECRET-CODE&state=STATE-SECRET', h);
    await raw(port, 'POST', '/api/sync', { ...h, ...JSONH, cookie: 'physio_session=COOKIE-SECRET' }, JSON.stringify({ since: 0, changes: [{ table: 'patients', row: { name: '王大明-BODY-SECRET' } }] }));
    await new Promise((r) => setTimeout(r, 150));
    const log = readFileSync(logFile, 'utf8');
    for (const secret of ['PATIENT-SECRET-ID', 'OAUTH-SECRET-CODE', 'STATE-SECRET', 'COOKIE-SECRET', 'BODY-SECRET', '王大明']) expect(log, secret).not.toContain(secret);
    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\t[^\t]+\t(GET|POST)\t\/api\/[a-z/]+\t\d{3}$/);
    expect(statSync(logFile).mode & 0o077).toBe(0);
  });
});

describe('檔案權限', () => {
  it('資料目錄 700、資料庫與備份檔 600', () => {
    const dir = tmp();
    const dataDir = join(dir, 'data');
    const dbPath = join(dataDir, 'physio.sqlite');
    const backupDir = join(dataDir, 'backups');
    // 先以寬鬆權限建立,再套用加固
    mkdirSync(dataDir, { recursive: true, mode: 0o755 });
    const repo = new SqliteRepo(dbPath);
    const b = backupNow(repo, backupDir);
    writeFileSync(join(backupDir, 'physio-2020-01-01.sqlite'), 'x', { mode: 0o644 });
    hardenPermissions(dataDir, dbPath, backupDir);
    repo.close();
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(backupDir).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(b).mode & 0o777).toBe(0o600);
    expect(statSync(join(backupDir, 'physio-2020-01-01.sqlite')).mode & 0o777).toBe(0o600);
  });
});

describe('啟動防呆:對網路開放必須設密碼', () => {
  function start(env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const dir = tmp();
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/server/index.ts'], { env: { ...process.env, PORT: '0', PHYSIO_DATA_DIR: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c: Buffer) => { out += c.toString(); if (out.includes('密碼登入')) { child.kill(); } });
      child.stderr.on('data', (c: Buffer) => (out += c.toString()));
      child.on('exit', (code) => resolve({ code, out }));
      setTimeout(() => child.kill(), 15_000);
    });
  }
  it('HOST=0.0.0.0 且無密碼 → 拒絕啟動(exit 1);有密碼或本機則可啟動', async () => {
    const bad = await start({ HOST: '0.0.0.0' });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('拒絕啟動');
    const good = await start({ HOST: '0.0.0.0', PHYSIO_PASSWORD: 'x' });
    expect(good.out).toContain('密碼登入:已啟用');
    const local = await start({});
    expect(local.out).toContain('密碼登入:未啟用');
  }, 60_000);
});

describe('程式碼稽核:個案資料不得進入 log', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((f) => f.isFile() && f.name.endsWith('.ts')).map((f) => join(f.parentPath, f.name));
  const read = (f: string) => readFileSync(f, 'utf8');

  it('伺服器端:只有啟動/備份指令檔可使用 console,且不輸出個案欄位', () => {
    const allowed = new Set(['index.ts', 'cli.ts']);
    for (const f of files('src/server')) {
      const base = f.split('/').pop() as string;
      const uses = read(f).split('\n').filter((l) => /console\.(log|error|warn|info|debug|trace)\(/.test(l));
      if (!allowed.has(base)) expect(uses, `${f} 不應使用 console`).toEqual([]);
      for (const l of uses) expect(l, `${f}: ${l}`).not.toMatch(/\b(p|patient|row|rows|v|input|record)\.(name|phone|address|precautions|birth_date|history_note|executed_content|chief_complaint)\b|\$\{(p|patient|row|rows|body|req|record)\b/);
    }
  });

  it('前端與共用程式碼完全不使用 console(含 debugger)', () => {
    for (const f of [...files('src/client'), ...files('src/shared')]) {
      expect(read(f), f).not.toMatch(/console\.(log|error|warn|info|debug|trace)\(/);
      expect(read(f), f).not.toMatch(/\bdebugger\b/);
    }
  });

  it('不輸出堆疊或完整錯誤物件;沒有第三方分析/錯誤回報套件', () => {
    for (const f of files('src')) expect(read(f), f).not.toMatch(/\.stack\b|JSON\.stringify\((e|err|error)\)/);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const bad of ['sentry', 'bugsnag', 'rollbar', 'datadog', 'newrelic', 'mixpanel', 'amplitude', 'segment', 'posthog', 'google-analytics', 'logrocket']) expect(all.some((d) => d.includes(bad)), bad).toBe(false);
  });

  it('前端不載入任何外部網址的資源(CDN、字型、追蹤碼)', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html).not.toMatch(/(?:src|href)="https?:\/\//);
    for (const f of files('src/client')) expect(read(f), f).not.toMatch(/<script[^>]+src=|<link[^>]+href="https?:|@import url\(["']?https?:/);
  });
});
