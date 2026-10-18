// HTTP 服務:/api/sync 與靜態檔。不記錄任何請求內容(個案資料不得進 log)。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { applyChanges, type SyncRequest, type SyncResponse } from '../shared/sync';
import { isTableName } from '../shared/schema';
import type { SqliteRepo } from './db';
import type { GcalService } from './gcal/service';
import type { LineService } from './line/service';
import { DomainError } from '../shared/validate';

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
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' }).end(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>尚未建置</title>' +
        '<body style="font:18px/1.6 -apple-system,sans-serif;max-width:32em;margin:3em auto;padding:0 1em">' +
        '<h1>系統已啟動,但還沒有網頁畫面</h1><p>請在專案資料夾執行:</p><pre style="background:#eee;padding:.8em;border-radius:8px">npm run build</pre>' +
        '<p>完成後重新整理此頁。(之後用 <code>npm start</code> 會自動處理。)</p></body>',
    );
    return;
  }
  const headers: Record<string, string> = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' };
  // Service Worker 與入口頁不可被快取,否則更新無法生效
  if (file.endsWith('sw.js') || file.endsWith('index.html')) headers['cache-control'] = 'no-cache';
  res.writeHead(200, headers).end(readFileSync(file));
}

export interface Services {
  gcal?: GcalService;
  line?: LineService;
}

export function createApp(repo: SqliteRepo, staticDir: string, services: Services = {}): Server {
  const { gcal, line } = services;
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? '/';
        if (url === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true });
        if (url === '/api/sync' && req.method === 'POST') {
          const body = parseSyncRequest(await readBody(req));
          const out = await handleSync(repo, body);
          sendJson(res, 200, out);
          // 行程有變動時,回應之後在背景推送到 Google(不阻塞裝置同步;執行中會自動略過)
          if (body.changes.some((c) => c.table === 'appointments')) void gcal?.run();
          // 裝置排入的 LINE 訊息(到達/完成/摘要/HEP):同步抵達後立即送出
          if (body.changes.some((c) => c.table === 'line_messages')) void line?.drain();
          return;
        }
        if (url === '/api/gcal/status' && req.method === 'GET') {
          return sendJson(res, 200, gcal ? gcal.status() : { enabled: false, reason: '未啟用', privacy: 'minimal', running: false, last_run_at: null, last_ok: null, last_error: null, last_result: null });
        }
        if (url === '/api/gcal/sync' && req.method === 'POST') {
          return sendJson(res, 200, gcal ? await gcal.run() : { enabled: false });
        }
        if (url === '/api/gcal/client' && req.method === 'POST') {
          const b = JSON.parse(await readBody(req)) as { client_id?: unknown; client_secret?: unknown };
          if (typeof b.client_id !== 'string' || typeof b.client_secret !== 'string') throw new SyntaxError('格式錯誤');
          if (!gcal) throw new DomainError('bad_request', '未啟用');
          gcal.saveClient(b.client_id, b.client_secret);
          return sendJson(res, 200, gcal.status());
        }
        if (url === '/api/gcal/connect' && req.method === 'POST') {
          if (!gcal) throw new DomainError('bad_request', '未啟用');
          return sendJson(res, 200, { url: gcal.connectStart(req.headers.host) });
        }
        if (url.startsWith('/api/gcal/callback') && req.method === 'GET') {
          const q = new URL(url, 'http://x').searchParams;
          const page = (title: string, body: string): void => {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(
              `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="3;url=/#/schedule"><title>${title}</title>` +
                `<body style="font:18px/1.6 -apple-system,sans-serif;max-width:32em;margin:3em auto;padding:0 1em"><h1>${title}</h1><p>${body}</p><p><a href="/#/schedule">回到排程</a>(3 秒後自動返回)</p></body>`,
            );
          };
          try {
            if (q.get('error')) throw new DomainError('bad_request', '你取消了 Google 授權,未完成連結。');
            const code = q.get('code');
            const state = q.get('state');
            if (!code || !state || !gcal) throw new DomainError('bad_request', '授權資料不完整,請重新連結。');
            await gcal.connectFinish(code, state);
            return page('已連結 Google 行事曆', '專用行事曆「居家物治排程」已建立,正在開始同步。');
          } catch (e) {
            // 只顯示我們自己撰寫的說明,不回傳 Google 的回應內容
            return page('連結未完成', e instanceof DomainError || (e instanceof Error && e.message.startsWith('Google')) ? (e as Error).message : '發生錯誤,請重新連結。');
          }
        }
        if (url === '/api/gcal/disconnect' && req.method === 'POST') {
          if (!gcal) throw new DomainError('bad_request', '未啟用');
          gcal.disconnect();
          return sendJson(res, 200, gcal.status());
        }
        if (url === '/api/line/status' && req.method === 'GET') {
          return sendJson(res, 200, line ? line.status() : { enabled: false, reason: '未啟用', clinic_name: '', reminder_hour: 18, running: false, last_drain: null, last_error: null });
        }
        if (url === '/api/line/bindcode' && req.method === 'POST') {
          if (!line?.enabled) return sendJson(res, 409, { error: 'LINE 尚未設定' });
          const b = JSON.parse(await readBody(req)) as { patient_id?: unknown; role?: unknown };
          if (typeof b.patient_id !== 'string') throw new SyntaxError('格式錯誤');
          return sendJson(res, 200, await line.createBindCode(b.patient_id, b.role === 'patient' ? 'patient' : 'family'));
        }
        if (url.startsWith('/api/line/links') && req.method === 'GET') {
          const pid = new URL(url, 'http://x').searchParams.get('patient_id');
          return sendJson(res, 200, { links: line && pid ? line.links(pid) : [] });
        }
        if (url === '/api/line/unlink' && req.method === 'POST') {
          const b = JSON.parse(await readBody(req)) as { id?: unknown };
          if (typeof b.id !== 'string') throw new SyntaxError('格式錯誤');
          return sendJson(res, 200, { ok: line?.unlink(b.id) ?? false });
        }
        if (url === '/api/line/retry' && req.method === 'POST') {
          return sendJson(res, 200, line ? await line.drain() : { enabled: false });
        }
        if (url.startsWith('/api/')) return sendJson(res, 404, { error: '找不到' });
        if (req.method === 'GET') return serveStatic(staticDir, url, res);
        res.writeHead(405).end();
      } catch (e) {
        // 錯誤訊息可能夾帶資料內容,只回傳通用訊息,不記錄細節
        if (e instanceof DomainError) return sendJson(res, e.code === 'not_found' ? 404 : 400, { error: e.message });
        const known = e instanceof SyntaxError || (e instanceof Error && e.message === '格式錯誤');
        sendJson(res, known ? 400 : 500, { error: known ? '請求格式錯誤' : '伺服器錯誤' });
      }
    })();
  });
}
