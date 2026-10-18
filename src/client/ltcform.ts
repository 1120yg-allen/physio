// 長照申報紀錄:填寫表單(草稿)與簽章後的預檢、上傳、申報狀態追蹤。
// 畫面含個案姓名與服務內容,不寫 log。
import { LTC_CODES, LTC_CODE_LIST, SUBMISSION_STATUS, canCorrect, canTransition, deadlines, blockedIds, type PrecheckIssue, CHECK_NAMES } from '../shared/ltc';
import type { Encounter, Location, Patient } from '../shared/schema';
import { todayTaipei } from '../shared/time';
import { h } from './dom';
import type { ViewCtx } from './schedule';

const LOC: Record<Location, string> = { home: '居家', facility: '機構', community: '社區' };

export interface LtcDraftForm {
  el: HTMLElement;
  /** 儲存服務代碼/地點與長照申報欄位 */
  save(): Promise<void>;
}

const field = (label: string, el: Node): HTMLElement => h('div', null, h('label', { className: 'f' }, label), el);

export async function ltcDraftForm(ctx: ViewCtx, p: Patient, e: Encounter): Promise<LtcDraftForm> {
  const { svc } = ctx;
  const rec = await svc.getLtcRecord(e.id);
  const goals = await svc.listGoals(p.id);
  const staff = await svc.listLtc('ltc_staff');

  const code = h('select', null, h('option', { value: '' }, '選擇服務代碼…'), LTC_CODE_LIST.map((c) => h('option', { value: c }, `${c} ${LTC_CODES[c]!.name}`)));
  code.value = e.service_code ?? '';
  const loc = h('select', null, (['home', 'facility', 'community'] as Location[]).map((l) => h('option', { value: l }, LOC[l])));
  loc.value = e.location ?? 'home';
  const staffSel = h('select', null, h('option', { value: '' }, staff.length ? '選擇服務人員…' : '尚未建立人員資料'), staff.map((s) => h('option', { value: s.id }, `${s.name}(Level ${s.ltc_level})`)));
  staffSel.value = rec?.staff_id ?? (staff.length === 1 ? (staff[0]?.id ?? '') : '');
  const goal = h('select', null, h('option', { value: '' }, goals.length ? '選擇照顧目標…' : '此個案尚未設定目標'), goals.map((g) => h('option', { value: g.id }, g.description)));
  goal.value = rec?.care_goal_id ?? '';
  const content = h('textarea', { value: rec?.executed_content ?? '', placeholder: '本次目標執行內容', lang: 'zh-TW' });
  const completion = h('input', { value: rec?.completion ?? '', placeholder: '完成度,例:完成 80%', lang: 'zh-TW' });
  const feedback = h('input', { value: rec?.feedback ?? '', placeholder: '個案/家屬回饋(選填)', lang: 'zh-TW' });
  const quota = h('input', { type: 'month', value: rec?.quota_month ?? svc.defaultQuotaMonth(e.service_date) });

  const warnings: (HTMLElement | string)[] = [];
  if (staff.length === 0) warnings.push(h('p', { className: 'precautions' }, '尚未建立服務人員資料,預檢「人員資格」會無法通過。請到「長照核銷 → 設定」新增。'));
  if (goals.length === 0) warnings.push(h('p', { className: 'precautions' }, '此個案尚未設定治療目標,長照紀錄需要選擇照顧目標。請到個案頁「治療目標」新增。'));

  const el = h('div', { className: 'card' },
    h('h2', null, '長照申報紀錄'),
    ...warnings,
    h('div', { className: 'grid2' }, field('服務代碼 *', code), field('地點', loc)),
    h('div', { className: 'grid2' }, field('服務人員 *', staffSel), field('申報年月 *(須晚於服務年月)', quota)),
    field('照顧目標 *', goal),
    field('本次目標執行內容 *', content),
    h('div', { className: 'grid2' }, field('完成度 *', completion), field('回饋', feedback)),
  );

  return {
    el,
    save: async () => {
      await svc.updateEncounter(e.id, { service_code: code.value || null, location: (loc.value || null) as Location | null });
      await svc.saveLtcRecord(e.id, {
        care_goal_id: goal.value || null, staff_id: staffSel.value || null, executed_content: content.value.trim() || null,
        completion: completion.value.trim() || null, feedback: feedback.value.trim() || null, quota_month: quota.value || null,
      });
    },
  };
}

const SEV = { error: '✗', warn: '⚠', notice: 'ℹ' } as const;

export function issueList(issues: PrecheckIssue[]): HTMLElement {
  if (issues.length === 0) return h('p', { className: 'ok' }, '✓ 預檢全部通過');
  return h('div', null, ...issues.map((i) => h('div', { className: `issue ${i.severity}` }, h('strong', null, `${SEV[i.severity]} #${i.check} ${CHECK_NAMES[i.check] ?? ''}`), h('div', null, i.message))));
}

/** 簽章後:紀錄內容、預檢、上傳(標記 FA100)與申報狀態追蹤 */
export async function ltcLockedCard(ctx: ViewCtx, p: Patient, e: Encounter, isLatest: boolean): Promise<HTMLElement> {
  const { svc } = ctx;
  const rec = await svc.getLtcRecord(e.id);
  const goal = rec?.care_goal_id ? (await svc.listGoals(p.id)).find((g) => g.id === rec.care_goal_id) : undefined;
  const staff = rec?.staff_id ? (await svc.listLtc('ltc_staff')).find((s) => s.id === rec.staff_id) : undefined;
  const msg = h('div');
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    msg.replaceChildren();
    try {
      await fn();
      void ctx.doSync();
      await ctx.render();
    } catch (err) {
      msg.replaceChildren(ctx.errorBox(ctx.describeError(err)));
    }
  };

  const card = h('div', { className: 'card' }, h('h2', null, '長照申報紀錄'));
  const row = (k: string, v: string | null | undefined): HTMLElement | '' => (v ? h('div', null, h('span', { className: 'muted' }, `${k}:`), v) : '');
  card.append(
    row('服務代碼', e.service_code ? `${e.service_code} ${LTC_CODES[e.service_code]?.name ?? ''}` : null),
    row('服務人員', staff ? `${staff.name}(Level ${staff.ltc_level})` : null),
    row('照顧目標', goal?.description),
    row('執行內容', rec?.executed_content), row('完成度', rec?.completion), row('回饋', rec?.feedback), row('申報年月', rec?.quota_month),
  );

  if (!isLatest) {
    card.append(h('p', { className: 'muted' }, '這是已被取代的舊版本,僅供查閱。'));
    return card;
  }

  if (e.status === 'signed') {
    const { issues } = await svc.runPrecheck({ encounterIds: [e.id] });
    const blocked = blockedIds(issues).size > 0;
    const dl = deadlines([{ encounter: e, record: rec }], todayTaipei())[0];
    card.append(
      h('h2', null, '上傳前預檢'),
      issueList(issues),
      dl ? h('p', { className: 'muted' }, `6 個月死線:${dl.deadline}(剩 ${dl.days_left} 天)`) : '',
      h('div', { className: 'row' },
        h('button', { className: 'primary', disabled: blocked, onclick: () => { if (confirm('確定標記為「已上傳 FA100」?\n標記後內容不可直接修改。')) void run(() => svc.markSubmitted([e.id])); } }, blocked ? '預檢未通過,無法標記上傳' : '標記為已上傳(FA100)')),
      h('p', { className: 'muted' }, '本系統不會自動上傳到照管系統;請先在照管系統完成上傳,再回來標記。'),
    );
  } else if (e.status === 'submitted' && rec) {
    const s = rec.submission_status;
    const next = SUBMISSION_STATUS[s + 1];
    card.append(
      h('h2', null, '申報狀態'),
      h('p', null, h('span', { className: 'badge submitted' }, `${s}・${SUBMISSION_STATUS[s]}`), canCorrect(s) ? h('span', { className: 'muted' }, ' 目前可修正') : h('span', { className: 'muted' }, s === 6 ? ' 已結案' : ' 狀態 2 之後須洽縣市承辦退件才能修正')),
      h('ol', { className: 'steps' }, SUBMISSION_STATUS.map((n, i) => h('li', { className: i < s ? 'done' : i === s ? 'cur' : '' }, `${i} ${n}`))),
      h('div', { className: 'row' },
        next && canTransition(s, s + 1) ? h('button', { className: 'primary', onclick: () => void run(() => ctx.svc.advanceSubmission(e.id, s + 1)) }, `照管系統已進到「${next}」`) : '',
        canTransition(s, 1) ? h('button', { className: 'danger', onclick: () => { if (confirm('縣市承辦已退件?狀態將回到 1(待通知收件),之後可建立新版本修正。')) void run(() => ctx.svc.advanceSubmission(e.id, 1)); } }, '縣市承辦已退件') : ''),
    );
  }
  card.append(msg);
  return card;
}

