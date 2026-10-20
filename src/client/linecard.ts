// LINE 相關畫面:綁定管理(個案頁)、通知與摘要傳送(服務紀錄頁)、動作庫影片網址維護。
// 畫面含個案姓名與健康資料,不寫 log。
import { buildFamilySummary, jargonLeft, summaryToText } from '../shared/family';
import { arriveMessages, chartFlex, departMessages, hepMessages, text } from '../shared/linemsg';
import type { Encounter, Exercise, LineMessage, LineMessageKind, Patient } from '../shared/schema';
import { DEFAULT_RESOURCES, parseResources, resourcesToText, type Resource } from '../shared/resources';
import { h } from './dom';
import { STATIC_MODE } from './env';
import type { ViewCtx } from './schedule';

interface LineStatus {
  enabled: boolean;
  reason?: string;
  clinic_name: string;
}

interface LinkInfo {
  id: string;
  role: 'family' | 'patient';
  status: 'active' | 'revoked';
  bound_at: string;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  if (STATIC_MODE) return null;
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null; // 離線或服務未啟動:LINE 管理不可用,但不影響其他功能
  }
}

const RES_KEY = 'physio.resources';
const RES_ON_KEY = 'physio.resources.on';

/** 運動資源網站清單(存在這台裝置的瀏覽器;未自訂則用預設) */
export function getResources(): Resource[] {
  try {
    const raw = localStorage.getItem(RES_KEY);
    if (raw) return parseResources(raw).resources;
  } catch {
    /* 無法讀取時用預設 */
  }
  return [...DEFAULT_RESOURCES];
}

export function setResources(text: string | null): void {
  try {
    if (text === null) localStorage.removeItem(RES_KEY);
    else localStorage.setItem(RES_KEY, text);
  } catch {
    /* 略過 */
  }
}

const resourcesOn = (): boolean => {
  try {
    return localStorage.getItem(RES_ON_KEY) !== '0';
  } catch {
    return true;
  }
};

const KIND_LABEL: Record<LineMessageKind, string> = { arrive: '到達通知', depart: '完成通知', summary: '治療摘要', hep: '居家運動', reminder: '預約提醒' };
const STATUS_LABEL = { queued: '待送出', sent: '已送出', skipped: '已略過', failed: '失敗' } as const;
const ROLE_LABEL = { family: '家屬', patient: '本人' } as const;

const CONSENT = '綁定即表示對方同意透過 LINE 接收服務通知與健康相關資訊。LINE 為第三方服務,訊息會經過 LINE 的伺服器。';

// ───────────── 個案頁:綁定管理 ─────────────

export async function patientLineCard(ctx: ViewCtx, p: Patient): Promise<HTMLElement> {
  const status = await getJson<LineStatus>('/api/line/status');
  const card = h('div', { className: 'card' }, h('h2', null, 'LINE 通知'));
  if (!status) {
    card.append(h('p', { className: 'muted' }, STATIC_MODE ? '純本機版無法使用 LINE;請在自己的電腦執行 npm start。' : '無法連線到伺服器,暫時無法管理 LINE 綁定。'));
    return card;
  }
  if (!status.enabled) {
    card.append(h('p', { className: 'muted' }, `LINE 未啟用${status.reason ? `:${status.reason}` : ''}`));
    return card;
  }
  const links = (await getJson<{ links: LinkInfo[] }>(`/api/line/links?patient_id=${encodeURIComponent(p.id)}`))?.links ?? [];
  const active = links.filter((l) => l.status === 'active');
  const msg = h('div');
  const codeBox = h('div');

  const gen = async (role: 'family' | 'patient'): Promise<void> => {
    msg.replaceChildren();
    const r = await getJson<{ code: string; expires_at: string }>('/api/line/bindcode', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patient_id: p.id, role }),
    });
    if (!r) {
      msg.replaceChildren(ctx.errorBox('無法產生綁定碼,請確認已連線到伺服器'));
      return;
    }
    codeBox.replaceChildren(
      h('div', { className: 'bindcode' }, r.code),
      h('p', { className: 'muted' }, `請${ROLE_LABEL[role]}加入「${status.clinic_name}」LINE 官方帳號為好友,然後傳送:綁定 ${r.code}`),
      h('p', { className: 'muted' }, `48 小時內有效、只能使用一次。${CONSENT}`),
    );
  };

  card.append(
    active.length === 0 ? h('p', { className: 'muted' }, '尚未綁定。') : '',
    ...active.map((l) =>
      h('div', { className: 'version row' },
        h('span', { className: 'grow' }, `${ROLE_LABEL[l.role]}(${l.bound_at.slice(0, 10)} 綁定)`),
        h('button', { className: 'danger', onclick: () => { if (confirm('確定解除此 LINE 綁定?')) void getJson('/api/line/unlink', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: l.id }) }).then(() => ctx.render()); } }, '解除')),
    ),
    h('div', { className: 'row' },
      h('button', { onclick: () => void gen('family') }, '產生家屬綁定碼'),
      h('button', { onclick: () => void gen('patient') }, '產生本人綁定碼')),
    msg, codeBox,
  );
  return card;
}

// ───────────── 服務紀錄頁:通知、摘要、HEP ─────────────

export async function encounterLineCard(ctx: ViewCtx, p: Patient, e: Encounter): Promise<HTMLElement> {
  const { svc } = ctx;
  const status = await getJson<LineStatus>('/api/line/status');
  const clinic = status?.clinic_name ?? '居家物理治療';
  const linkCount = status?.enabled ? ((await getJson<{ links: LinkInfo[] }>(`/api/line/links?patient_id=${encodeURIComponent(p.id)}`))?.links ?? []).filter((l) => l.status === 'active').length : null;
  const history = await svc.listLineMessages(e.id);
  const msg = h('div');
  const appt = await svc.appointmentForEncounter(e.id);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    msg.replaceChildren();
    try {
      await fn();
      void ctx.doSync();
      // server 送出並回寫狀態後,再同步一次以更新畫面上的狀態
      setTimeout(() => void ctx.doSync().then(() => ctx.render()), 3000);
      await ctx.render();
    } catch (err) {
      msg.replaceChildren(ctx.errorBox(ctx.describeError(err)));
    }
  };
  const queue = (kind: LineMessageKind, items: Record<string, unknown>[], expiresInMin?: number): Promise<LineMessage> =>
    svc.queueLine({ patient_id: p.id, encounter_id: e.id, appointment_id: appt?.id ?? null, kind, items, expiresInMin });

  const has = (k: LineMessageKind): boolean => history.some((m) => m.kind === k && (m.status === 'queued' || m.status === 'sent'));
  const card = h('div', { className: 'card' }, h('h2', null, 'LINE 通知'));

  if (status && !status.enabled) card.append(h('p', { className: 'muted' }, 'LINE 未啟用,訊息仍會先排入佇列,啟用並綁定後才會送出。'));
  else if (linkCount === 0) card.append(h('p', { className: 'precautions' }, '此個案尚未綁定 LINE。請到個案頁產生綁定碼,請家屬加入官方帳號並輸入。'));
  else if (linkCount !== null) card.append(h('p', { className: 'muted' }, `已綁定 ${linkCount} 位收件者。`));

  // 到達 / 完成(簽到、簽退各一則;逾 30 分鐘未送達即不再送出)
  card.append(
    h('div', { className: 'row' },
      h('button', { disabled: has('arrive'), onclick: () => void run(() => queue('arrive', arriveMessages(clinic), 30)) }, has('arrive') ? '✓ 已通知:到達' : '🚪 通知家屬:我到了'),
      h('button', { disabled: has('depart'), onclick: () => void run(() => queue('depart', departMessages(clinic), 30)) }, has('depart') ? '✓ 已通知:完成' : '✅ 通知家屬:服務完成')),
  );

  // 摘要與 HEP(自費、已簽章)
  if (e.track === 'self_pay' && e.signed_at !== null) {
    const input = await svc.familySummaryInput(e.id);
    const rs = getResources();
    let useRes = resourcesOn() && rs.length > 0;
    const make = (): ReturnType<typeof buildFamilySummary> => buildFamilySummary({ ...input, resources: useRes ? rs : [] });
    let summary = make();
    let generated = summaryToText(summary, clinic);
    const area = h('textarea', { value: generated, lang: 'zh-TW', rows: 14 });
    const resCb = h('input', { type: 'checkbox', checked: useRes, disabled: rs.length === 0 });
    resCb.addEventListener('change', () => {
      if (area.value !== generated && !confirm('重新產生摘要會覆蓋你剛才的修改,確定嗎?')) {
        resCb.checked = useRes;
        return;
      }
      useRes = resCb.checked;
      try {
        localStorage.setItem(RES_ON_KEY, useRes ? '1' : '0');
      } catch {
        /* 略過 */
      }
      summary = make();
      generated = summaryToText(summary, clinic);
      area.value = generated;
      paintWarn();
    });
    const warn = h('div', { className: 'muted' });
    const paintWarn = (): void => {
      const left = jargonLeft(area.value);
      warn.textContent = left.length ? `⚠ 仍有疑似專業縮寫:${left.join('、')},請確認家屬看得懂再傳送。` : '';
    };
    area.addEventListener('input', paintWarn);
    paintWarn();

    card.append(
      h('h2', null, '家屬版摘要'),
      h('p', { className: 'muted' }, '由系統以規則轉成白話(未使用 AI)。傳送前請檢查並可直接修改文字;不含臨床推理、風險標記與生命徵象。'),
      area, warn,
      h('label', { className: 'muted' }, resCb, ` 附上運動資源網站(${rs.length} 個,有居家運動處方時才附;可在「動作庫」編輯)`),
      summary.chart ? h('p', { className: 'muted' }, `將另附一張「${summary.chart.title}」數值長條圖。`) : '',
      h('div', { className: 'row' },
        h('button', { className: 'primary', onclick: () => {
          if (!confirm(`確定將摘要傳送給家屬?${linkCount === null ? '' : `(${linkCount} 位收件者)`}\n內容會經過 LINE 伺服器。`)) return;
          void run(() => queue('summary', [text(area.value), ...(summary.chart ? [chartFlex(summary.chart)] : [])]));
        } }, '傳送摘要給家屬'),
        e.signed_at && input.content.plan.hep.length > 0
          ? h('button', { onclick: () => void run(() => queue('hep', hepMessages(clinic, input.content.plan.hep, input.exercises, useRes ? rs : []))) }, '推送居家運動(含示範影片)')
          : ''),
    );
    if (input.content.plan.hep.length > 0) {
      const noVideo = input.content.plan.hep.filter((x) => !(x.video_ref ?? input.exercises.find((ex) => ex.id === x.item_id)?.video_ref));
      if (noVideo.length) card.append(h('p', { className: 'muted' }, `有 ${noVideo.length} 項運動尚未設定示範影片網址,可到「動作庫」補上。`));
    }
  }

  card.append(msg);
  if (history.length) {
    card.append(
      h('h2', null, '傳送紀錄'),
      ...history.map((m) =>
        h('div', { className: 'version' },
          h('span', { className: `badge ${m.status === 'sent' ? 'signed' : m.status === 'queued' ? 'draft' : ''}` }, STATUS_LABEL[m.status]),
          ` ${KIND_LABEL[m.kind]}・${m.created_at.slice(11, 16)}`,
          m.status_detail ? h('div', { className: 'muted' }, m.status_detail) : '',
          m.status === 'failed' || m.status === 'skipped'
            ? h('button', { className: 'chip', onclick: () => void run(() => svc.requeueLine(m.id)) }, '重新傳送')
            : ''),
      ),
    );
  }
  return card;
}

// ───────────── 動作庫:示範影片網址 ─────────────

const CAT = { manual: '徒手', exercise: '運動', functional: '功能性', education: '衛教' } as const;

export async function viewLibrary(ctx: ViewCtx): Promise<void> {
  const list = await ctx.svc.listExercises();
  const msg = h('div');
  const row = (ex: Exercise): HTMLElement => {
    const input = h('input', { type: 'url', value: ex.video_ref ?? '', placeholder: '示範影片網址(https://…)', inputMode: 'url', autocomplete: 'off' });
    input.addEventListener('change', () => {
      msg.replaceChildren();
      const v = input.value.trim();
      if (v !== '' && !/^https?:\/\/\S+$/i.test(v)) {
        msg.replaceChildren(ctx.errorBox('影片網址需以 http:// 或 https:// 開頭'));
        return;
      }
      void ctx.svc.updateExercise(ex.id, { video_ref: v || null }).then(() => ctx.doSync()).catch((e: unknown) => msg.replaceChildren(ctx.errorBox(ctx.describeError(e))));
    });
    return h('div', { className: 'irow' }, h('div', { className: 'top' }, h('span', { className: 'badge' }, CAT[ex.category]), h('span', { className: 'nm' }, ex.name)), input);
  };
  const resArea = h('textarea', { value: resourcesToText(getResources()), rows: 6, placeholder: '每行一個:名稱 | 網址', lang: 'zh-TW' });
  const resMsg = h('div');
  const resCard = h('div', { className: 'card' },
    h('h2', null, '運動資源網站'),
    h('p', { className: 'muted' }, '傳送居家運動與治療摘要時,會在最後附上這些網站,讓病人自行搜尋動作示範。訊息會註明「請以治療師示範與指示的動作和次數為準」。每行一個,格式:名稱 | 網址。此清單存在這台裝置的瀏覽器。'),
    resArea, resMsg,
    h('div', { className: 'row' },
      h('button', { className: 'primary', onclick: () => {
        const { resources, invalid } = parseResources(resArea.value);
        if (invalid.length) { resMsg.replaceChildren(ctx.errorBox(`以下行的網址不是 http(s):// 開頭,未儲存:${invalid.join(';')}`)); return; }
        setResources(resourcesToText(resources));
        resMsg.replaceChildren(h('div', { className: 'ok' }, `已儲存 ${resources.length} 個網站`));
      } }, '儲存'),
      h('button', { onclick: () => { setResources(null); resArea.value = resourcesToText(DEFAULT_RESOURCES); resMsg.replaceChildren(h('div', { className: 'ok' }, '已還原預設清單')); } }, '還原預設')),
  );
  ctx.layout('動作庫', [
    resCard,
    h('p', { className: 'muted' }, '在此為動作貼上示範影片網址(例如 YouTube 不公開連結)。推送居家運動時會一併附上。'),
    msg,
    h('div', { className: 'card' }, ...list.map(row)),
  ]);
  await ctx.refreshStatus();
}
