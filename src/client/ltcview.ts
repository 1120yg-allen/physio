// 長照核銷畫面:月度核銷儀表板(提醒、預檢、額度餘額、死線倒數、QD110 草稿匯出)與設定頁。
// 畫面含個案姓名,不寫 log。
import { LTC_CODES, LTC_CODE_LIST, SUBMISSION_STATUS, blockedIds, deadlines, ltcReminders, monthOf, nextMonth, prevMonth, qd110DraftCsv, qd110Rows, quotaBalances, type LtcItem, type PrecheckIssue } from '../shared/ltc';
import type { LtcPlan, Patient } from '../shared/schema';
import { todayTaipei } from '../shared/time';
import { h } from './dom';
import { issueList } from './ltcform';
import type { ViewCtx } from './schedule';

const REMINDER_CLASS = { error: 'err', warn: 'precautions', notice: 'issue notice' } as const;

/** 清單頁/排程頁頂端的長照提醒(沒有提醒時回傳 null) */
export async function ltcBanner(ctx: ViewCtx): Promise<HTMLElement | null> {
  const items = await ctx.svc.ltcItems();
  const plans = await ctx.svc.listLtc('ltc_plans');
  if (items.length === 0 && plans.length === 0) return null;
  const rs = ltcReminders(todayTaipei(), items.filter((i) => i.encounter.status === 'signed'), plans);
  if (rs.length === 0) return null;
  return h('a', { href: '#/ltc', className: 'ltc-banner' }, ...rs.map((r) => h('div', { className: REMINDER_CLASS[r.severity] }, r.message)));
}

function download(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  // 加上 BOM,Excel 才會正確辨識 UTF-8 中文
  const blob = new Blob(['﻿', text], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

export function ltcViews(ctx: ViewCtx): {
  viewLtc(month: string | null): Promise<void>;
  viewLtcSettings(patientId: string | null): Promise<void>;
} {
  const { svc } = ctx;

  async function viewLtc(monthArg: string | null): Promise<void> {
    const today = todayTaipei();
    const month = monthArg ?? monthOf(today);
    const items = await svc.ltcItems();
    const ctxData = await svc.ltcContext();
    const patients = new Map(ctxData.patients.map((p) => [p.id, p]));
    const pending = items.filter((i) => i.encounter.status === 'signed');
    const { issues } = await svc.runPrecheck({ today });
    const blocked = blockedIds(issues);
    const msg = h('div');
    const nm = (id: string): string => patients.get(id)?.name ?? '個案';

    const reminders = ltcReminders(today, pending, ctxData.plans);
    const remindersCard = h('div', { className: 'card' },
      h('h2', null, '提醒'),
      reminders.length === 0 ? h('p', { className: 'muted' }, '目前沒有需要處理的提醒。') : '',
      ...reminders.map((r) => h('div', { className: REMINDER_CLASS[r.severity] }, r.message)),
      h('p', { className: 'muted' }, `每月 1 日起可上傳上個月服務的紀錄(FA100)。FA100 後等 20–30 分鐘且狀態為傳輸完成才可 FA110;修正後須隔 1 小時才能重傳。`),
    );

    // 該申報年月待上傳
    const monthPending = pending.filter((i) => i.record?.quota_month === month);
    const checks = new Map<string, HTMLInputElement>();
    const pendingRows = monthPending.map((it) => {
      const e = it.encounter;
      const mine = issues.filter((i) => i.encounter_id === e.id);
      const cb = h('input', { type: 'checkbox', checked: !blocked.has(e.id), disabled: blocked.has(e.id) });
      checks.set(e.id, cb);
      const dl = deadlines([it], today)[0]!;
      return h('tr', null,
        h('td', null, cb),
        h('td', null, h('a', { href: `#/encounter/${e.id}` }, e.service_date), h('div', { className: 'muted' }, `${e.start_time}–${e.end_time}`)),
        h('td', null, nm(e.patient_id)),
        h('td', null, e.service_code ?? '—'),
        h('td', null, blocked.has(e.id) ? h('span', { className: 'badge' }, `✗ ${mine.filter((i) => i.severity === 'error').length} 項錯誤`) : mine.length ? h('span', { className: 'badge draft' }, `⚠ ${mine.length} 項提示`) : h('span', { className: 'badge signed' }, '✓ 通過')),
        h('td', { className: dl.days_left <= 30 ? 'warn-text' : '' }, `${dl.days_left} 天`),
      );
    });

    const submitSelected = (): void => {
      const ids = [...checks.entries()].filter(([, c]) => c.checked).map(([id]) => id);
      if (ids.length === 0) {
        msg.replaceChildren(ctx.errorBox('請先勾選要標記上傳的紀錄'));
        return;
      }
      if (!confirm(`確定將 ${ids.length} 筆標記為「已上傳 FA100」?\n請先確認已在照管系統完成上傳。`)) return;
      msg.replaceChildren();
      svc.markSubmitted(ids, today).then(() => { void ctx.doSync(); return ctx.render(); }).catch((e: unknown) => msg.replaceChildren(ctx.errorBox(ctx.describeError(e))));
    };

    const monthIssues: PrecheckIssue[] = issues.filter((i) => monthPending.some((m) => m.encounter.id === i.encounter_id) || i.encounter_id === null);

    const pendingCard = h('div', { className: 'card' },
      h('h2', null, `申報年月 ${month}:待上傳(${monthPending.length})`),
      monthPending.length === 0 ? h('p', { className: 'muted' }, '沒有待上傳的紀錄。') : h('table', { className: 'tbl' },
        h('thead', null, h('tr', null, h('th'), h('th', null, '服務日'), h('th', null, '個案'), h('th', null, '代碼'), h('th', null, '預檢'), h('th', null, '死線'))),
        h('tbody', null, ...pendingRows)),
      monthIssues.length ? h('details', { open: monthIssues.some((i) => i.severity === 'error') }, h('summary', null, `預檢明細(${monthIssues.length})`), issueList(monthIssues)) : '',
      monthPending.length ? h('div', { className: 'row' }, h('button', { className: 'primary', onclick: submitSelected }, '標記選取為已上傳(FA100)')) : '',
      h('p', { className: 'muted' }, '預檢有錯誤的紀錄無法勾選;請先修正(簽章後須建立新版本)。本系統不會自動上傳到照管系統。'),
    );

    // 已送出
    const submitted = items.filter((i) => i.encounter.status === 'submitted' && i.record?.quota_month === month);
    const submittedCard = h('div', { className: 'card' },
      h('h2', null, `申報年月 ${month}:已送出(${submitted.length})`),
      submitted.length === 0 ? h('p', { className: 'muted' }, '尚無已送出的紀錄。') : h('table', { className: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, '服務日'), h('th', null, '個案'), h('th', null, '代碼'), h('th', null, '申報狀態'))),
        h('tbody', null, ...submitted.map((it) => h('tr', null,
          h('td', null, h('a', { href: `#/encounter/${it.encounter.id}` }, it.encounter.service_date)),
          h('td', null, nm(it.encounter.patient_id)), h('td', null, it.encounter.service_code ?? '—'),
          h('td', null, `${it.record?.submission_status ?? 0}・${SUBMISSION_STATUS[it.record?.submission_status ?? 0]}`))))),
    );

    // 額度餘額
    const balances = quotaBalances(ctxData.quotas, items.filter((i) => i.encounter.signed_at !== null), month);
    const quotaCard = h('div', { className: 'card' },
      h('h2', null, `額度餘額(申報年月 ${month})`),
      balances.length === 0 ? h('p', { className: 'muted' }, '本月尚未設定任何額度。請到「設定」新增個案當月分配額度。') : h('table', { className: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, '個案'), h('th', null, '代碼'), h('th', null, '已用 / 額度'), h('th', null, ''))),
        h('tbody', null, ...balances.map((b) => h('tr', null,
          h('td', null, nm(b.patient_id)), h('td', null, b.service_code),
          h('td', null, `${b.used} / ${b.allowed}${b.remaining < 0 ? `(超過 ${-b.remaining})` : `(剩 ${b.remaining})`}`),
          h('td', null, h('div', { className: `bar-meter${b.ratio > 1 ? ' full' : b.ratio >= 0.8 ? ' hot' : ''}` }, h('span'))))))),
      balances.some((b) => b.ratio >= 0.8) ? h('p', { className: 'warn-text' }, '有額度已用到 80% 以上,請提前向照管專員確認下月額度。') : '',
    );
    // 長條寬度(style 無法經 h() 直接傳入)
    balances.forEach((b, i) => { const sp = quotaCard.querySelectorAll('.bar-meter > span')[i] as HTMLElement | undefined; if (sp) sp.style.width = `${Math.min(100, Math.round(b.ratio * 100))}%`; });

    // 死線
    const dl = deadlines(pending, today).filter((d) => d.days_left <= 60);
    const deadlineCard = h('div', { className: 'card' },
      h('h2', null, '6 個月死線倒數(待申報、60 天內)'),
      dl.length === 0 ? h('p', { className: 'muted' }, '沒有接近死線的紀錄。') : h('table', { className: 'tbl' },
        h('tbody', null, ...dl.map((d) => h('tr', null, h('td', null, h('a', { href: `#/encounter/${d.encounter_id}` }, d.service_date)), h('td', null, nm(d.patient_id)), h('td', { className: d.days_left < 0 ? 'warn-text' : '' }, d.days_left < 0 ? `已逾期 ${-d.days_left} 天` : `剩 ${d.days_left} 天(${d.deadline})`))))),
    );

    // QD110 草稿匯出
    const exportCard = h('div', { className: 'card' },
      h('h2', null, '匯出 QD110(草稿格式)'),
      h('p', { className: 'muted' }, '⚠ 照管平台的正式 QD110 欄位規範尚未取得,這裡匯出的是「草稿格式」,不能直接匯入。自費紀錄一律不會出現在匯出中。'),
      h('button', { onclick: () => {
        const rows = qd110Rows(items.filter((i) => i.record?.quota_month === month), ctxData.patients);
        if (rows.length === 0) { msg.replaceChildren(ctx.errorBox('這個申報年月沒有可匯出的長照紀錄')); return; }
        download(`qd110-draft-${month}.csv`, qd110DraftCsv(rows));
      } }, `匯出 ${month} 草稿`),
    );

    ctx.layout('長照核銷', [
      h('div', { className: 'card' },
        h('div', { className: 'row' },
          h('a', { className: 'btn', href: `#/ltc/${prevMonth(month)}` }, '‹'),
          h('a', { className: 'btn', href: `#/ltc/${monthOf(today)}` }, '本月'),
          h('a', { className: 'btn', href: `#/ltc/${nextMonth(month)}` }, '›'),
          h('strong', { className: 'grow sched-title' }, `申報年月 ${month}`),
          h('a', { className: 'btn', href: '#/ltc/settings' }, '設定'))),
      msg, remindersCard, pendingCard, submittedCard, quotaCard, deadlineCard, exportCard,
    ]);
    await ctx.refreshStatus();
  }

  // ───────────── 設定 ─────────────

  /** 以 prompt 逐欄修改(設定資料量小,避免為編輯另做一套表單) */
  async function promptEdit<T extends object>(fields: { key: keyof T & string; label: string; number?: boolean }[], row: T, save: (patch: Partial<T>) => Promise<unknown>): Promise<void> {
    const patch: Record<string, unknown> = {};
    for (const f of fields) {
      const cur = (row as Record<string, unknown>)[f.key];
      const v = window.prompt(f.label, cur === null || cur === undefined ? '' : String(cur));
      if (v === null) return;
      patch[f.key] = f.number ? Number(v) : v.trim() === '' ? null : v.trim();
    }
    try {
      await save(patch as Partial<T>);
      void ctx.doSync();
      await ctx.render();
    } catch (e) {
      alert(ctx.describeError(e));
    }
  }

  async function viewLtcSettings(patientId: string | null): Promise<void> {
    ctx.setEditing(true);
    const data = await ctx.svc.ltcContext();
    const ltcPatients = data.patients.filter((p) => p.track !== 'self_pay' && !p.archived_at);
    const pid = patientId ?? ltcPatients[0]?.id ?? null;
    const patient: Patient | undefined = data.patients.find((p) => p.id === pid);
    const msg = h('div');
    const guard = (fn: () => Promise<unknown>): void => {
      msg.replaceChildren();
      fn().then(() => { void ctx.doSync(); return ctx.render(); }).catch((e: unknown) => msg.replaceChildren(ctx.errorBox(ctx.describeError(e))));
    };
    const inp = (ph: string, type = 'text', value = ''): HTMLInputElement => h('input', { placeholder: ph, type, value, lang: 'zh-TW' });
    const f = (label: string, el: Node): HTMLElement => h('div', null, h('label', { className: 'f' }, label), el);

    // 特約
    const cName = inp('特約名稱/單位'), cStart = inp('', 'date'), cEnd = inp('', 'date');
    const contractCard = h('div', { className: 'card' },
      h('h2', null, '特約有效期間'),
      data.contracts.length === 0 ? h('p', { className: 'muted' }, '尚未設定。預檢 #2 需要。') : '',
      ...data.contracts.map((c) => h('div', { className: 'version row' }, h('span', { className: 'grow' }, `${c.name}:${c.start_date} ~ ${c.end_date}`),
        h('button', { className: 'chip', onclick: () => void promptEdit([{ key: 'name', label: '名稱' }, { key: 'start_date', label: '開始日(YYYY-MM-DD)' }, { key: 'end_date', label: '結束日(YYYY-MM-DD)' }], c, (pt) => ctx.svc.updateLtc('ltc_contracts', c.id, pt)) }, '修改'))),
      h('details', null, h('summary', null, '＋ 新增特約'), f('名稱', cName), h('div', { className: 'grid2' }, f('開始', cStart), f('結束', cEnd)),
        h('p', null, h('button', { onclick: () => guard(() => ctx.svc.createLtc('ltc_contracts', { name: cName.value.trim(), start_date: cStart.value, end_date: cEnd.value })) }, '儲存'))),
    );

    // 人員
    const sName = inp('姓名'), sProf = inp('職類', 'text', '物理治療師'), sFrom = inp('', 'date'), sTo = inp('', 'date');
    const sLevel = h('select', null, [1, 2, 3].map((n) => h('option', { value: String(n) }, `Level ${n}`)));
    const staffCard = h('div', { className: 'card' },
      h('h2', null, '服務人員資格'),
      data.staff.length === 0 ? h('p', { className: 'muted' }, '尚未設定。預檢 #3 需要。') : '',
      ...data.staff.map((s) => h('div', { className: 'version row' }, h('span', { className: 'grow' }, `${s.name}・${s.profession}・Level ${s.ltc_level}・${s.valid_from} ~ ${s.valid_to ?? '長期'}`),
        h('button', { className: 'chip', onclick: () => void promptEdit([{ key: 'name', label: '姓名' }, { key: 'ltc_level', label: 'Level(1–3)', number: true }, { key: 'valid_from', label: '資格開始日' }, { key: 'valid_to', label: '資格結束日(空白=長期)' }], s, (pt) => ctx.svc.updateLtc('ltc_staff', s.id, pt)) }, '修改'))),
      h('details', null, h('summary', null, '＋ 新增人員'), f('姓名', sName), f('職類', sProf), h('div', { className: 'grid3' }, f('長照 Level', sLevel), f('資格開始', sFrom), f('資格結束(選填)', sTo)),
        h('p', null, h('button', { onclick: () => guard(() => ctx.svc.createLtc('ltc_staff', { name: sName.value.trim(), profession: sProf.value.trim(), ltc_level: Number(sLevel.value), valid_from: sFrom.value, valid_to: sTo.value || null })) }, '儲存'))),
    );

    // 個案區
    const patientSel = h('select', null, ltcPatients.map((p) => h('option', { value: p.id }, p.name)));
    if (pid) patientSel.value = pid;
    patientSel.addEventListener('change', () => { location.hash = `#/ltc/settings/${patientSel.value}`; });
    let patientCards: HTMLElement[] = [];
    if (patient) {
      const plans = data.plans.filter((x) => x.patient_id === patient.id);
      const quotas = data.quotas.filter((x) => x.patient_id === patient.id).sort((a, b) => a.quota_month.localeCompare(b.quota_month));
      const susp = data.suspensions.filter((x) => x.patient_id === patient.id);
      const pStart = inp('', 'date'), pEnd = inp('', 'date');
      const qMonth = inp('', 'month', nextMonth(monthOf(todayTaipei()))), qCount = inp('次數', 'number', '3');
      const qCode = h('select', null, LTC_CODE_LIST.map((c) => h('option', { value: c }, c)));
      const xStart = inp('', 'date'), xEnd = inp('', 'date'), xReason = inp('原因(選填)');

      const planRow = (pl: LtcPlan): HTMLElement => h('div', { className: 'version' },
        h('div', { className: 'row' }, h('span', { className: 'grow' }, `${pl.start_date} ~ ${pl.end_date}・${pl.status === 'active' ? '進行中' : pl.status === 'moved' ? `已移居(${pl.closed_at})` : `中途結案(${pl.closed_at})`}`),
          h('button', { className: 'chip', onclick: () => void promptEdit([{ key: 'start_date', label: '開始日' }, { key: 'end_date', label: '結束日' }], pl, (pt) => ctx.svc.updateLtc('ltc_plans', pl.id, pt)) }, '修改日期')),
        pl.status === 'active'
          ? h('div', { className: 'row' },
              h('button', { onclick: () => { const d = prompt('中途結案日期(YYYY-MM-DD)', todayTaipei()); if (d) guard(() => ctx.svc.closePlan(pl.id, 'closed_early', d)); } }, '標記中途結案'),
              h('button', { onclick: () => { const d = prompt('移居日期(YYYY-MM-DD)', todayTaipei()); if (d) guard(() => ctx.svc.closePlan(pl.id, 'moved', d)); } }, '標記移居'))
          : pl.fa400_done_at
            ? h('div', { className: 'muted' }, `✓ 已於 ${pl.fa400_done_at} 完成 FA400 提前結案設定`)
            : h('div', null, h('div', { className: 'precautions' }, '⚠ 請先在照管系統完成 FA400「提前結案設定」,再處理後續申報。'),
                h('button', { className: 'primary', onclick: () => { if (confirm('確認已在照管系統完成 FA400?')) guard(() => ctx.svc.markFa400Done(pl.id, todayTaipei())); } }, '我已完成 FA400')));

      patientCards = [
        h('div', { className: 'card' }, h('h2', null, `${patient.name}:照顧計畫`),
          plans.length === 0 ? h('p', { className: 'muted' }, '尚未建立。預檢 #4 需要。') : '', ...plans.map(planRow),
          h('details', null, h('summary', null, '＋ 新增照顧計畫'), h('div', { className: 'grid2' }, f('開始', pStart), f('結束', pEnd)),
            h('p', null, h('button', { onclick: () => guard(() => ctx.svc.createLtc('ltc_plans', { patient_id: patient.id, start_date: pStart.value, end_date: pEnd.value, status: 'active', closed_at: null, fa400_done_at: null, note: null })) }, '儲存')))),
        h('div', { className: 'card' }, h('h2', null, `${patient.name}:分配額度`),
          quotas.length === 0 ? h('p', { className: 'muted' }, '尚未設定。預檢 #1 需要(依申報年月、服務代碼各設一筆)。') : '',
          ...quotas.map((q) => h('div', { className: 'version row' }, h('span', { className: 'grow' }, `${q.quota_month}・${q.service_code}・${q.allowed_count} 次`),
            h('button', { className: 'chip', onclick: () => void promptEdit([{ key: 'allowed_count', label: '額度次數', number: true }], q, (pt) => ctx.svc.updateLtc('ltc_quotas', q.id, pt)) }, '修改'))),
          h('details', null, h('summary', null, '＋ 新增額度'), h('div', { className: 'grid3' }, f('申報年月', qMonth), f('代碼', qCode), f('次數', qCount)),
            h('p', null, h('button', { onclick: () => guard(() => ctx.svc.createLtc('ltc_quotas', { patient_id: patient.id, quota_month: qMonth.value, service_code: qCode.value, allowed_count: Number(qCount.value) })) }, '儲存')))),
        h('div', { className: 'card' }, h('h2', null, `${patient.name}:暫停服務區間`),
          susp.length === 0 ? h('p', { className: 'muted' }, '沒有暫停區間。') : '',
          ...susp.map((x) => h('div', { className: 'version row' }, h('span', { className: 'grow' }, `${x.start_date} ~ ${x.end_date}${x.reason ? `(${x.reason})` : ''}`),
            h('button', { className: 'chip', onclick: () => void promptEdit([{ key: 'start_date', label: '開始日' }, { key: 'end_date', label: '結束日' }, { key: 'reason', label: '原因' }], x, (pt) => ctx.svc.updateLtc('ltc_suspensions', x.id, pt)) }, '修改'))),
          h('details', null, h('summary', null, '＋ 新增暫停區間'), h('div', { className: 'grid2' }, f('開始', xStart), f('結束', xEnd)), f('原因', xReason),
            h('p', null, h('button', { onclick: () => guard(() => ctx.svc.createLtc('ltc_suspensions', { patient_id: patient.id, start_date: xStart.value, end_date: xEnd.value, reason: xReason.value.trim() || null })) }, '儲存')))),
      ];
    }

    ctx.layout('長照設定', [
      h('p', { className: 'muted' }, '預檢引擎(上傳前攔錯)需要這些資料。服務代碼單價與所需 Level 為系統內建的假設值,請對照你的特約規定:' + LTC_CODE_LIST.map((c) => `${c} 每次 ${LTC_CODES[c]!.unit_amount} 元`).join('、')),
      msg, contractCard, staffCard,
      ltcPatients.length === 0 ? h('div', { className: 'card' }, h('p', { className: 'muted' }, '尚無長照個案。請先在「個案」新增軌別為長照或自費+長照的個案。')) : h('div', { className: 'card' }, h('h2', null, '選擇個案'), patientSel),
      ...patientCards,
    ], '#/ltc');
    await ctx.refreshStatus();
  }

  return { viewLtc, viewLtcSettings };
}

