// HTTP 服務:/api/sync 與靜態檔。不記錄任何請求內容(個案資料不得進 log)。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { applyChanges, type SyncRequest, type SyncResponse } from '../shared/sync';
import { isTableName } from '../shared/schema';
import type { SqliteRepo } from './db';

const MAX_BODY = 64 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('請求過大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function parseSyncRequest(raw: string): SyncRequest {
  const v: unknown = JSON.parse(raw);
  if (typeof v !== 'object' || v === null) throw new Error('格式錯誤');
  const o = v as { since?: unknown; changes?: unknown };
  if (typeof o.since !== 'number' || !Array.isArray(o.changes)) throw new Error('格式錯誤');
  const changes = o.changes.map((c: unknown) => {
    const x = c as { table?: unknown; row?: unknown };
    if (!isTableName(x.table)) throw new Error('格式錯誤');
    return { table: x.table, row: x.row };
  });
  return { since: o.since, changes };
}

export async function handleSync(repo: SqliteRepo, req: SyncRequest): Promise<SyncResponse> {
  const results = await repo.transaction(() => applyChanges(repo, req.changes));
  // 回傳 client 尚未取得的變更(包含剛接受的,client 以 id 去重)
  const pulled = repo.changesSince(req.since);
  return { results, changes: pulled.map(({ table, row }) => ({ table, row })), cursor: repo.currentSeq() };
}

function serveStatic(staticDir: string, urlPath: string, res: ServerResponse): void {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0] ?? '/')).replace(/^(\.\.[/\\])+/, '');
  let file = join(staticDir, clean);
  if (!file.startsWith(staticDir)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(staticDir, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('尚未建置前端,請先執行 npm run build');
    return;
  }
  const headers: Record<string, string> = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' };
  // Service Worker 與入口頁不可被快取,否則更新無法生效
  if (file.endsWith('sw.js') || file.endsWith('index.html')) headers['cache-control'] = 'no-cache';
  res.writeHead(200, headers).end(readFileSync(file));
}

export function createApp(repo: SqliteRepo, staticDir: string): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? '/';
        if (url === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true });
        if (url === '/api/sync' && req.method === 'POST') {
          const body = parseSyncRequest(await readBody(req));
          return sendJson(res, 200, await handleSync(repo, body));
        }
        if (url.startsWith('/api/')) return sendJson(res, 404, { error: '找不到' });
        if (req.method === 'GET') return serveStatic(staticDir, url, res);
        res.writeHead(405).end();
      } catch (e) {
        // 錯誤訊息可能夾帶資料內容,只回傳通用訊息,不記錄細節
        const known = e instanceof SyntaxError || (e instanceof Error && e.message === '格式錯誤');
        sendJson(res, known ? 400 : 500, { error: known ? '請求格式錯誤' : '伺服器錯誤' });
      }
    })();
  });
}
