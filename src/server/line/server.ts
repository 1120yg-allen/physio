// LINE webhook 專用伺服器:獨立埠、只接受 POST /line/webhook。
// 需要公網 HTTPS 時只對外開放此埠(例如 Tailscale Funnel),主系統與病歷 API 不對外。
import { createServer, type Server } from 'node:http';
import type { LineService } from './service';

const MAX_BODY = 1024 * 1024;

export function createWebhookServer(line: LineService): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/line/webhook') {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_BODY) {
            res.writeHead(413).end();
            req.destroy();
            return;
          }
          chunks.push(c as Buffer);
        }
        const sig = req.headers['x-line-signature'];
        const out = await line.webhook(Buffer.concat(chunks), Array.isArray(sig) ? sig[0] : sig);
        res.writeHead(out.status).end();
      } catch {
        res.writeHead(500).end(); // 不回傳任何細節
      }
    })();
  });
}
