// Google OAuth(桌面應用程式 + 本機 loopback + PKCE)與設定檔。
// refresh token 只存在使用者自己的電腦(資料目錄內,權限 600),不經任何第三方。
// 權限範圍 calendar.app.created:只能建立並管理「本應用程式建立的行事曆」,讀不到使用者的其他行事曆。
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import type { FetchFn } from './google';

export const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface ClientCreds {
  clientId: string;
  clientSecret: string;
}

export interface GcalFiles {
  tokenFile: string;
  configFile: string;
  /** 在畫面上貼入的 OAuth 用戶端 ID/密鑰(環境變數優先) */
  clientFile: string;
}

export function gcalFiles(dataDir: string): GcalFiles {
  return { tokenFile: join(dataDir, 'gcal-token.json'), configFile: join(dataDir, 'gcal-config.json'), clientFile: join(dataDir, 'gcal-client.json') };
}

export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): ClientCreds | null {
  const clientId = env.GCAL_CLIENT_ID;
  const clientSecret = env.GCAL_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function readClientFile(files: GcalFiles): ClientCreds | null {
  if (!existsSync(files.clientFile)) return null;
  const j = JSON.parse(readFileSync(files.clientFile, 'utf8')) as { client_id?: string; client_secret?: string };
  return j.client_id && j.client_secret ? { clientId: j.client_id, clientSecret: j.client_secret } : null;
}

export function saveClientFile(files: GcalFiles, creds: ClientCreds): void {
  writeSecret(files.clientFile, { client_id: creds.clientId, client_secret: creds.clientSecret });
}

/** 用戶端憑證:環境變數優先,其次是畫面上儲存的檔案 */
export function resolveClient(files: GcalFiles, env: NodeJS.ProcessEnv = process.env): ClientCreds | null {
  return clientFromEnv(env) ?? readClientFile(files);
}

export function saveRefreshToken(files: GcalFiles, refreshToken: string): void {
  writeSecret(files.tokenFile, { refresh_token: refreshToken });
}

/** 中斷連結:刪除授權與行事曆設定(用戶端憑證保留,方便重新連結) */
export function clearAuthorization(files: GcalFiles): void {
  for (const f of [files.tokenFile, files.configFile]) rmSync(f, { force: true });
}

function writeSecret(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export interface GcalConfig {
  calendar_id: string;
}

export function readConfig(files: GcalFiles): GcalConfig | null {
  return existsSync(files.configFile) ? (JSON.parse(readFileSync(files.configFile, 'utf8')) as GcalConfig) : null;
}

export function saveConfig(files: GcalFiles, cfg: GcalConfig): void {
  writeSecret(files.configFile, cfg);
}

export function readRefreshToken(files: GcalFiles): string | null {
  return existsSync(files.tokenFile) ? ((JSON.parse(readFileSync(files.tokenFile, 'utf8')) as { refresh_token?: string }).refresh_token ?? null) : null;
}

/** 以 refresh token 換取 access token,並在到期前重用 */
export function accessTokenProvider(creds: ClientCreds, refreshToken: string, fetchFn: FetchFn = fetch, nowMs: () => number = Date.now): () => Promise<string> {
  let cached: { token: string; exp: number } | null = null;
  return async () => {
    if (cached && cached.exp - 60_000 > nowMs()) return cached.token;
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
    });
    if (!res.ok) throw new Error(`Google 授權更新失敗(HTTP ${res.status}),請重新執行 npm run gcal:auth`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: j.access_token, exp: nowMs() + j.expires_in * 1000 };
    return cached.token;
  };
}

const b64url = (b: Buffer): string => b.toString('base64url');

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

export function newPkce(): Pkce {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()), state: b64url(randomBytes(16)) };
}

export function buildAuthUrl(creds: ClientCreds, redirect: string, pkce: Pkce): string {
  const q = new URLSearchParams({
    client_id: creds.clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', code_challenge: pkce.challenge, code_challenge_method: 'S256', state: pkce.state,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

/** 以授權碼換取 refresh token(不儲存) */
export async function exchangeCode(creds: ClientCreds, code: string, verifier: string, redirect: string, fetchFn: FetchFn = fetch): Promise<string> {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId, client_secret: creds.clientSecret, code, code_verifier: verifier,
      grant_type: 'authorization_code', redirect_uri: redirect,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Google 授權失敗(HTTP ${res.status})`);
  const j = (await res.json()) as { refresh_token?: string };
  if (!j.refresh_token) throw new Error('Google 未回傳 refresh token,請到 Google 帳戶移除本應用程式的授權後重試');
  return j.refresh_token;
}

/** 終端機互動式授權(npm run gcal:auth):印出網址,等待瀏覽器導回本機 */
export async function runAuthFlow(creds: ClientCreds, files: GcalFiles, print: (s: string) => void, fetchFn: FetchFn = fetch): Promise<string> {
  const pkce = newPkce();
  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      const got = u.searchParams.get('code');
      if (u.searchParams.get('state') !== pkce.state || !got) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('授權失敗,請回到終端機重試。');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('授權完成,可以關閉這個分頁,回到終端機。');
      const port = (server.address() as { port: number }).port;
      server.close();
      resolve({ code: got, redirect: `http://127.0.0.1:${port}` });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      print(`請用瀏覽器開啟以下網址並同意授權:\n\n${buildAuthUrl(creds, `http://127.0.0.1:${port}`, pkce)}\n`);
    });
  });
  const refresh = await exchangeCode(creds, code.code, pkce.verifier, code.redirect, fetchFn);
  saveRefreshToken(files, refresh);
  return refresh;
}

/** 建立專用行事曆(只同步這一個,不碰使用者其他行事曆),回傳其 id */
export async function createDedicatedCalendar(getAccessToken: () => Promise<string>, name: string, fetchFn: FetchFn = fetch): Promise<string> {
  const res = await fetchFn('https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST',
    headers: { authorization: `Bearer ${await getAccessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ summary: name, timeZone: 'Asia/Taipei' }),
  });
  if (!res.ok) throw new Error(`建立行事曆失敗(HTTP ${res.status})`);
  return ((await res.json()) as { id: string }).id;
}
