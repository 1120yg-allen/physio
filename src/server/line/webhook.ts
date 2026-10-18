// LINE webhook:驗證簽章、處理加好友/綁定碼/停止。
// 此處理器只由「獨立的 webhook 埠」呼叫,主系統(病歷 API)不對公網開放。
import { text, type LineMessageObj } from '../../shared/linemsg';
import type { SqliteRepo } from '../db';
import { verifySignature, type LineApi } from './api';
import type { LineStore } from './store';

export interface WebhookDeps {
  repo: SqliteRepo;
  store: LineStore;
  api: LineApi;
  channelSecret: string;
  clinicName: string;
  now: () => string;
  /** 綁定成功後通知(例如立刻處理佇列) */
  onBound?: () => void;
}

interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: { type?: string; text?: string };
}

const toHalfWidth = (s: string): string => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

const WELCOME = (clinic: string): string =>
  `歡迎使用【${clinic}】官方帳號。\n請輸入治療師提供的 6 位數綁定碼(例如:綁定 123456),完成後即可收到服務提醒與居家運動資訊。\n之後想取消,隨時回覆「停止」。`;

/** 姓名遮罩,綁定成功的回覆不顯示完整姓名(防止猜碼者得知個案身分) */
function mask(name: string): string {
  const c = [...name];
  return c.length <= 1 ? '○' : `${c[0]}${'○'.repeat(c.length - 1)}`;
}

export async function handleWebhook(d: WebhookDeps, rawBody: Buffer, signature: string | undefined): Promise<{ status: number }> {
  if (!verifySignature(rawBody, d.channelSecret, signature)) return { status: 401 };
  let body: { events?: LineEvent[] };
  try {
    body = JSON.parse(rawBody.toString('utf8')) as { events?: LineEvent[] };
  } catch {
    return { status: 400 };
  }
  for (const ev of body.events ?? []) {
    const userId = ev.source?.type === 'user' ? ev.source.userId : undefined;
    if (!userId) continue;
    const reply = async (msgs: LineMessageObj[]): Promise<void> => {
      if (ev.replyToken) await d.api.reply(ev.replyToken, msgs);
    };

    if (ev.type === 'follow') {
      await reply([text(WELCOME(d.clinicName))]);
    } else if (ev.type === 'unfollow') {
      d.store.revokeUser(userId, d.now());
    } else if (ev.type === 'message' && ev.message?.type === 'text') {
      const t = toHalfWidth((ev.message.text ?? '').trim());
      if (/^(停止|取消綁定|stop)$/i.test(t)) {
        const n = d.store.revokeUser(userId, d.now());
        await reply([text(n > 0 ? '已取消綁定,之後不會再收到通知。需要時可請治療師重新提供綁定碼。' : '目前沒有綁定中的個案。')]);
        continue;
      }
      const m = /^(?:綁定\s*)?(\d{6})$/.exec(t);
      if (!m) continue; // 其他訊息不自動回覆(由治療師在官方帳號後台人工處理)
      const r = d.store.consumeCode(m[1] as string, userId, d.now());
      if (r.ok) {
        const p = await d.repo.get('patients', r.patientId);
        await reply([text(`已完成綁定(${p ? mask(p.name) : '個案'})。之後會傳送服務前提醒與居家運動資訊。\n想取消時回覆「停止」即可。`)]);
        d.onBound?.();
      } else if (r.reason === 'locked') {
        await reply([text('輸入錯誤次數過多,請 1 小時後再試,或洽治療師重新取得綁定碼。')]);
      } else {
        await reply([text(r.reason === 'expired' ? '這組綁定碼已過期,請洽治療師重新取得。' : r.reason === 'used' ? '這組綁定碼已使用過,請洽治療師重新取得。' : '綁定碼不正確,請再確認一次。')]);
      }
    }
  }
  return { status: 200 };
}
