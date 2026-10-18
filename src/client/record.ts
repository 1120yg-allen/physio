// 個案服務歷程總覽(6.1)與完整病歷列印/PDF(6.2)。
// 內容為個案全部病歷(特種個資):只在畫面顯示或由使用者自行列印,不寫 log、不上傳。
import type { CutoffData } from '../shared/norms';
import { LTC_CODES, SUBMISSION_STATUS } from '../shared/ltc';
import type { Encounter, Exercise, LtcRecord, Patient, TestDef } from '../shared/schema';
import { goalProgressFor, testsUsedBy, trendFor } from '../shared/trend';
import { DomainError } from '../shared/validate';
import { regionLabel } from './bodymap';
import { trendChart } from './chart';
import { h } from './dom';
import type { ViewCtx } from './schedule';
import { soapReadonly } from './soapview';

const STATUS = { draft: '草稿', signed: '已簽章', submitted: '已送出申報' } as const;
const TRACK = { self_pay: '自費', ltc: '長照' } as const;
const LOC = { home: '居家', facility: '機構', community: '社區' } as const;
const TRACK_P = { self_pay: '自費', ltc: '長照', both: '自費+長照' } as const;

const kv = (k: string, v: string | null | undefined): HTMLElement | '' => (v ? h('div', null, h('span', { className: 'muted' }, `${k}:`), v) : '');

function ltcSummary(e: Encounter, r: LtcRecord | null, goalText: (id: string | null) => string): HTMLElement {
  if (!r) return h('p', { className: 'muted' }, '尚無長照申報紀錄');
  return h('div', { className: 'card ro' },
    kv('服務代碼', e.service_code ? `${e.service_code} ${LTC_CODES[e.service_code]?.name ?? ''}` : null),
    kv('地點', e.location ? LOC[e.location] : null),
    kv('照顧目標', goalText(r.care_goal_id)), kv('執行內容', r.executed_content), kv('完成度', r.completion), kv('回饋', r.feedback),
    kv('申報年月', r.quota_month), e.status === 'submitted' ? kv('申報狀態', `${r.submission_status}・${SUBMISSION_STATUS[r.submission_status]}`) : '');
}

export interface RecordOptions {
  /** 完整模式:所有版本、全部內容展開(列印用);否則為可收合的歷程總覽 */
  full: boolean;
}

/** 組出個案的完整紀錄畫面 */
export async function buildPatientRecord(ctx: ViewCtx, patientId: string, opts: RecordOptions): Promise<{ el: HTMLElement; patient: Patient }> {
  const { svc } = ctx;
  const p = await svc.getPatient(patientId);
  if (!p) throw new DomainError('not_found', '找不到個案');
  const tests: TestDef[] = await svc.listTests();
  const exercises: Exercise[] = await svc.listExercises();
  const goals = await svc.listGoals(patientId);
  const all = await svc.listEncounters(patientId);
  const roots = all.filter((e) => e.supersedes_id === null).sort((a, b) => a.service_date.localeCompare(b.service_date) || a.start_time.localeCompare(b.start_time) || a.created_at.localeCompare(b.created_at));
  const goalText = (id: string | null): string => (id ? (goals.find((g) => g.id === id)?.description ?? '') : '');

  const root = h('div', { className: 'record' });

  // ── 基本資料 ──
  root.append(h('div', { className: 'card' },
    h('h2', null, p.name),
    h('div', { className: 'muted' }, [`生日 ${p.birth_date}`, p.gender === 'male' ? '男' : p.gender === 'female' ? '女' : null, TRACK_P[p.track], p.ltc_level ? `長照等級 ${p.ltc_level}` : null, p.archived_at ? `已結案 ${p.archived_at.slice(0, 10)}` : null].filter(Boolean).join(' · ')),
    kv('電話', p.phone), kv('地址', p.address),
    p.emergency_contact ? kv('緊急聯絡人', `${p.emergency_contact.name}(${p.emergency_contact.relation}) ${p.emergency_contact.phone}`) : '',
    p.referral_doc ? kv('診斷證明/照會單', `${p.referral_doc.institution} ${p.referral_doc.physician}(開立 ${p.referral_doc.issued_on},有效至 ${p.referral_doc.valid_until})`) : kv('治療目的', p.referral_required ? '需診斷證明/照會單(尚未登錄)' : '非治療目的(免醫囑)'),
    p.precautions ? h('div', { className: 'precautions' }, h('b', null, '⚠ 禁忌症與注意事項'), p.precautions) : '',
    p.history_note ? h('details', { open: opts.full }, h('summary', null, '歷史備註(匯入的原文)'), h('pre', { className: 'histnote' }, p.history_note)) : ''));

  // ── 目標進度 ──
  const repo = (svc as unknown as { repo: Parameters<typeof trendFor>[0] }).repo;
  if (goals.length) {
    const rows: HTMLElement[] = [];
    for (const g of goals) {
      const { current, pct } = await goalProgressFor(repo, g);
      const t = tests.find((x) => x.id === g.test_id);
      rows.push(h('div', { className: 'version' }, h('strong', null, g.description),
        h('div', { className: 'muted' }, `${t ? `${t.name}:` : ''}基準 ${g.baseline_value ?? '–'} → 目前 ${current ?? '–'} → 目標 ${g.target_value ?? '–'}${pct === null ? '' : `(達成 ${pct}%)`}${g.deadline ? `;期限 ${g.deadline}` : ''}`)));
    }
    root.append(h('div', { className: 'card' }, h('h2', null, '治療目標'), ...rows));
  }

  // ── 測驗趨勢 ──
  const charts: HTMLElement[] = [];
  for (const tid of await testsUsedBy(repo, patientId)) {
    const t = tests.find((x) => x.id === tid);
    const pts = await trendFor(repo, patientId, tid);
    if (!t || pts.length === 0) continue;
    const cut = t.cutoffs as unknown as CutoffData | null;
    charts.push(trendChart(t, pts, cut ? { value: cut.value, label: '切點' } : undefined));
  }
  if (charts.length) root.append(h('div', { className: 'card' }, h('h2', null, '測驗趨勢'), ...charts));

  // ── 歷程 ──
  const timeline = h('div', { className: 'card' }, h('h2', null, `服務歷程(${roots.length} 次)`));
  if (roots.length === 0) timeline.append(h('p', { className: 'muted' }, '尚無服務紀錄'));
  for (const rt of roots) {
    const chain = await svc.versionChain(rt.id);
    const latest = chain[chain.length - 1] as Encounter;
    const versions = opts.full ? chain : [latest];
    const block = h('div', { className: 'enc' });
    for (const e of versions) {
      const content = e.track === 'self_pay' ? await svc.getSoapContent(e.id) : null;
      const rec = e.track === 'ltc' ? await svc.getLtcRecord(e.id) : null;
      const head = h('div', { className: 'enc-head' },
        h('strong', null, `${e.service_date} ${e.start_time}–${e.end_time}`),
        h('span', { className: 'badge' }, TRACK[e.track]),
        h('span', { className: `badge ${e.status}` }, STATUS[e.status]),
        chain.length > 1 ? h('span', { className: 'badge' }, `v${e.version}${e.id === latest.id ? '(最新)' : '(已被取代)'}`) : '');
      const meta = h('div', { className: 'muted' }, `建立 ${e.created_at}${e.signed_at ? `;簽章 ${e.signed_at}` : ''}`);
      const one = content
        ? `${content.subjective.chief_complaint || '(未填主訴)'}${content.subjective.nprs.score !== null ? `・疼痛 ${content.subjective.nprs.score}/10` : ''}${content.objective.measures.length ? `・${content.objective.measures.map((m) => `${tests.find((t) => t.id === m.test_id)?.code ?? ''} ${m.value}${m.unit}`).join('、')}` : ''}`
        : rec ? `${e.service_code ?? ''} ${rec.completion ?? ''}・${rec.executed_content ?? ''}` : '';
      const detail = content ? soapReadonly(content, tests, exercises) : ltcSummary(e, rec, goalText);
      const actions = h('div', { className: 'no-print' }, h('a', { href: `#/encounter/${e.id}` }, '開啟這筆紀錄'));
      if (opts.full) block.append(h('div', { className: 'enc-ver' }, head, meta, detail));
      else block.append(h('details', null, h('summary', null, head, h('div', { className: 'muted' }, one)), meta, detail, actions));
    }
    timeline.append(block);
  }
  root.append(timeline);
  return { el: root, patient: p };
}

export async function viewOverview(ctx: ViewCtx, patientId: string): Promise<void> {
  const { el, patient } = await buildPatientRecord(ctx, patientId, { full: false });
  ctx.layout(`${patient.name} 歷程總覽`, [
    h('div', { className: 'row' },
      h('a', { className: 'btn', href: `#/patient/${patientId}` }, '個案頁'),
      h('a', { className: 'btn primary', href: `#/patient/${patientId}/print` }, '匯出完整病歷(列印/PDF)')),
    el,
  ], `#/patient/${patientId}`);
  await ctx.refreshStatus();
}

export async function viewPrint(ctx: ViewCtx, patientId: string): Promise<void> {
  const { el, patient } = await buildPatientRecord(ctx, patientId, { full: true });
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const title = `${patient.name}-病歷-${today}`;
  document.title = title; // 瀏覽器「另存為 PDF」的預設檔名
  ctx.layout(`${patient.name} 完整病歷`, [
    h('div', { className: 'card no-print' },
      h('p', null, '點下方按鈕後,在列印視窗的「目的地」選擇「另存為 PDF」即可產生 PDF 檔。內容包含所有服務紀錄與歷史版本(含簽章時間)。'),
      h('p', { className: 'precautions' }, '此檔案含個案全部病歷資料,請妥善保管;轉診或交付他人時,請確認對方有權取得。'),
      h('div', { className: 'row' }, h('button', { className: 'primary', onclick: () => window.print() }, '🖨 列印 / 另存為 PDF'), h('a', { className: 'btn', href: `#/patient/${patientId}/overview` }, '返回'))),
    h('div', { className: 'print-title' }, h('h1', null, `${patient.name} 完整病歷`), h('div', { className: 'muted' }, `匯出日期 ${today}`)),
    el,
  ], `#/patient/${patientId}`);
  await ctx.refreshStatus();
}
