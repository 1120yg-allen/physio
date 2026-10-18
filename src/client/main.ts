import './style.css';
import { DataService } from '../shared/service';
import type { CutoffData } from '../shared/norms';
import type { Encounter, EncounterTrack, Gender, Location, Patient, Track } from '../shared/schema';
import { goalProgressFor, testsUsedBy, trendFor } from '../shared/trend';
import { nowTaipei, todayTaipei, timeNowTaipei } from '../shared/time';
import { DomainError } from '../shared/validate';
import { h } from './dom';
import { trendChart } from './chart';
import { IdbRepo, openPhysioDb } from './idb';
import { soapForm, type FormMode } from './soapform';
import { soapReadonly } from './soapview';
import { scheduleViews, type ViewCtx } from './schedule';
import { encounterLineCard, patientLineCard, viewLibrary } from './linecard';
import { httpTransport, runSync, type SyncOutcome } from './sync';

const TRACK_LABEL: Record<Track, string> = { self_pay: '自費', ltc: '長照', both: '自費+長照' };
const ETRACK_LABEL: Record<EncounterTrack, string> = { self_pay: '自費', ltc: '長照' };
const STATUS_LABEL = { draft: '草稿', signed: '已簽章', submitted: '已送出申報' } as const;
const LOC_LABEL: Record<Location, string> = { home: '居家', facility: '機構', community: '社區' };

let repo: IdbRepo;
let svc: DataService;
let sched: ReturnType<typeof scheduleViews>;
let viewCtx: ViewCtx;
const app = document.getElementById('app') as HTMLElement;

// ───────────── 90 秒計時(TASKS 1.5):只存秒數與模式,不含任何個案資料 ─────────────

interface Timing { seconds: number; mode: FormMode; at: string }

function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 無痕模式等無法寫入時略過,不影響主功能 */
  }
}
const visitStartKey = 'physio.visitStart';
function markVisitStart(encounterId: string): void {
  lsSet(visitStartKey, { ...lsGet<Record<string, number>>(visitStartKey, {}), [encounterId]: Date.now() });
}
function recordTiming(encounterId: string, mode: FormMode): void {
  const starts = lsGet<Record<string, number>>(visitStartKey, {});
  const t0 = starts[encounterId];
  if (t0 === undefined) return;
  delete starts[encounterId];
  lsSet(visitStartKey, starts);
  const list = lsGet<Timing[]>('physio.timings', []);
  list.push({ seconds: Math.round((Date.now() - t0) / 1000), mode, at: nowTaipei() });
  lsSet('physio.timings', list.slice(-50));
}
function timingSummary(): string | null {
  const q = lsGet<Timing[]>('physio.timings', []).filter((t) => t.mode === 'quick').slice(-10);
  if (q.length === 0) return null;
  const avg = Math.round(q.reduce((a, t) => a + t.seconds, 0) / q.length);
  return `快速模式最近 ${q.length} 次簽章平均 ${avg} 秒(目標 ≤ 90 秒)`;
}

// ───────────── 同步狀態列 ─────────────

let lastSync: SyncOutcome | null = null;
let syncing = false;
const statusEl = h('span', { className: 'status' });

async function refreshStatus(): Promise<void> {
  const pending = (await repo.listOutbox()).filter((i) => !i.rejected).length;
  const attn = (await repo.listOutbox()).filter((i) => i.rejected).length;
  const offline = !navigator.onLine || (lastSync !== null && !lastSync.ok);
  statusEl.className = `status${attn ? ' attn' : offline ? ' offline' : ''}`;
  statusEl.textContent = attn
    ? `${attn} 筆衝突待處理`
    : syncing
      ? '同步中…'
      : offline
        ? `離線(${pending} 筆待同步)`
        : pending
          ? `${pending} 筆待同步`
          : '已同步';
}

async function doSync(): Promise<void> {
  if (syncing) return;
  syncing = true;
  await refreshStatus();
  try {
    lastSync = await runSync(repo, httpTransport);
  } finally {
    syncing = false;
    await refreshStatus();
  }
  // 編輯中的畫面(表單、草稿紀錄)不可被背景同步重繪,否則會清掉使用者正在輸入的內容
  if (lastSync?.ok && lastSync.pulled > 0 && !editingView) await render();
}

// ───────────── 路由 ─────────────

function layout(title: string, body: (Node | null)[], back?: string): void {
  const inSchedule = location.hash.startsWith('#/schedule');
  const inLibrary = location.hash.startsWith('#/library');
  const nodes: (Node | null)[] = [
    h('header', { className: 'bar' },
      back ? h('a', { className: 'home btn', href: back }, '‹') : null,
      h('h1', null, title),
      statusEl,
      h('button', { onclick: () => void doSync() }, '同步'),
    ),
    back ? null : h('nav', { className: 'tabs' }, h('a', { href: '#/', className: inSchedule || inLibrary ? '' : 'on' }, '個案'), h('a', { href: '#/schedule', className: inSchedule ? 'on' : '' }, '排程'), h('a', { href: '#/library', className: inLibrary ? 'on' : '' }, '動作庫')),
    ...body,
  ];
  app.replaceChildren(...nodes.filter((n): n is Node => n !== null));
}

function errorBox(msg: string): HTMLElement {
  return h('div', { className: 'err', role: 'alert' }, msg);
}

function describeError(e: unknown): string {
  return e instanceof DomainError ? e.message : '發生未預期的錯誤,資料未儲存';
}

/** 目前畫面是否為編輯中(背景同步不得重繪) */
let editingView = false;

async function render(): Promise<void> {
  editingView = false;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    if (parts[0] === 'library') return await viewLibrary(viewCtx);
    if (parts[0] === 'schedule') {
      if (parts[1] === 'new') return await sched.viewAppointmentForm(null, parts[2] ?? todayTaipei());
      if (parts[1] === 'edit' && parts[2]) return await sched.viewAppointmentForm(parts[2], todayTaipei());
      return await sched.viewSchedule(parts[1] === 'week' ? 'week' : 'day', parts[2] ?? todayTaipei());
    }
    if (parts[0] === 'patient' && parts[1] === 'new') return await viewPatientForm(null);
    if (parts[0] === 'patient' && parts[1] && parts[2] === 'edit') return await viewPatientForm(parts[1]);
    if (parts[0] === 'patient' && parts[1]) return await viewPatient(parts[1]);
    if (parts[0] === 'encounter' && parts[1]) return await viewEncounter(parts[1]);
    return await viewPatientList();
  } catch (e) {
    layout('錯誤', [errorBox(describeError(e)), h('a', { className: 'btn', href: '#/' }, '回個案列表')]);
  }
  await refreshStatus();
}

// ───────────── 個案列表 ─────────────

async function viewPatientList(query = '', includeArchived = false): Promise<void> {
  const list = await svc.searchPatients(query, includeArchived);
  const search = h('input', { type: 'search', placeholder: '搜尋姓名或電話', value: query, autocomplete: 'off' });
  const archived = h('input', { type: 'checkbox', checked: includeArchived });
  const rerender = (): void => void viewPatientList(search.value, archived.checked);
  search.addEventListener('change', rerender);
  archived.addEventListener('change', rerender);

  layout('個案', [
    h('div', { className: 'row' }, h('div', { className: 'grow' }, search), h('a', { className: 'btn primary', href: '#/patient/new' }, '＋ 新增個案')),
    h('label', { className: 'muted' }, archived, ' 顯示已結案'),
    timingSummary() ? h('p', { className: 'muted' }, timingSummary() as string) : null,
    h('div', { className: 'card list' },
      list.length === 0 ? h('p', { className: 'muted' }, '尚無個案。按「新增個案」開始。') : null,
      list.map((p) =>
        h('a', { className: 'item', href: `#/patient/${p.id}` },
          h('span', { className: 'name' }, p.name),
          h('span', { className: 'badge' }, TRACK_LABEL[p.track]),
          p.archived_at ? h('span', { className: 'badge' }, '已結案') : null,
          p.precautions ? h('span', { className: 'badge draft' }, '有注意事項') : null,
          h('div', { className: 'muted' }, [p.birth_date, p.phone].filter(Boolean).join(' · ')),
        ),
      ),
    ),
  ]);
  await refreshStatus();
}

// ───────────── 個案表單 ─────────────

async function viewPatientForm(id: string | null): Promise<void> {
  editingView = true;
  const cur = id ? await svc.getPatient(id) : null;
  if (id && !cur) throw new DomainError('not_found', '找不到個案');

  const name = h('input', { value: cur?.name ?? '', required: true });
  const birth = h('input', { type: 'date', value: cur?.birth_date ?? '', required: true });
  const gender = h('select', null,
    h('option', { value: '' }, '未填'),
    h('option', { value: 'male' }, '男'), h('option', { value: 'female' }, '女'), h('option', { value: 'other' }, '其他'));
  gender.value = cur?.gender ?? '';
  const phone = h('input', { type: 'tel', value: cur?.phone ?? '' });
  const address = h('input', { value: cur?.address ?? '', placeholder: '到宅地址' });
  const ecName = h('input', { value: cur?.emergency_contact?.name ?? '', placeholder: '姓名' });
  const ecRel = h('input', { value: cur?.emergency_contact?.relation ?? '', placeholder: '關係' });
  const ecPhone = h('input', { type: 'tel', value: cur?.emergency_contact?.phone ?? '', placeholder: '電話' });
  const track = h('select', null,
    h('option', { value: 'self_pay' }, '自費'), h('option', { value: 'ltc' }, '長照'), h('option', { value: 'both' }, '自費+長照'));
  track.value = cur?.track ?? 'self_pay';
  const level = h('input', { type: 'number', min: '1', max: '8', value: cur?.ltc_level?.toString() ?? '' });
  const refReq = h('input', { type: 'checkbox', checked: cur?.referral_required ?? true });
  const refInst = h('input', { value: cur?.referral_doc?.institution ?? '', placeholder: '院所' });
  const refDoc = h('input', { value: cur?.referral_doc?.physician ?? '', placeholder: '醫師' });
  const refIssued = h('input', { type: 'date', value: cur?.referral_doc?.issued_on ?? '' });
  const refValid = h('input', { type: 'date', value: cur?.referral_doc?.valid_until ?? '' });
  const precautions = h('textarea', { value: cur?.precautions ?? '', placeholder: '禁忌症與注意事項(每次開啟紀錄都會顯示在最上方)' });
  const msg = h('div');

  const field = (label: string, el: Node): HTMLElement => h('div', null, h('label', { className: 'f' }, label), el);

  const save = async (ev: Event): Promise<void> => {
    ev.preventDefault();
    msg.replaceChildren();
    const ec = ecName.value || ecRel.value || ecPhone.value ? { name: ecName.value, relation: ecRel.value, phone: ecPhone.value } : null;
    const rd = refInst.value || refDoc.value || refIssued.value || refValid.value
      ? { institution: refInst.value, physician: refDoc.value, issued_on: refIssued.value, valid_until: refValid.value }
      : null;
    const data = {
      name: name.value.trim(),
      birth_date: birth.value,
      gender: (gender.value || null) as Gender | null,
      phone: phone.value.trim() || null,
      address: address.value.trim() || null,
      emergency_contact: ec,
      track: track.value as Track,
      ltc_level: level.value ? Number(level.value) : null,
      referral_doc: rd,
      referral_required: refReq.checked,
      precautions: precautions.value.trim() || null,
    };
    try {
      const p = cur ? await svc.updatePatient(cur.id, data) : await svc.createPatient(data);
      void doSync();
      location.hash = `#/patient/${p.id}`;
    } catch (e) {
      msg.replaceChildren(errorBox(describeError(e)));
    }
  };

  layout(cur ? '編輯個案' : '新增個案', [
    h('form', { className: 'card', onsubmit: (e: Event) => void save(e) },
      field('姓名 *', name), field('出生日期 *', birth),
      h('div', { className: 'grid2' }, field('性別', gender), field('電話', phone)),
      field('地址', address),
      h('label', { className: 'f' }, '緊急聯絡人'),
      h('div', { className: 'grid3' }, ecName, ecRel, ecPhone),
      h('div', { className: 'grid2' }, field('軌別 *', track), field('長照需要等級(長照個案必填)', level)),
      h('label', { className: 'f' }, refReq, ' 治療目的(須診斷證明/照會單;健康促進免醫囑請取消勾選)'),
      h('label', { className: 'f' }, '診斷證明/照會單'),
      h('div', { className: 'grid2' }, refInst, refDoc),
      h('div', { className: 'grid2' }, field('開立日', refIssued), field('有效期限', refValid)),
      field('禁忌症與注意事項', precautions),
      msg,
      h('div', { className: 'row' }, h('button', { className: 'primary grow', type: 'submit' }, '儲存'),
        h('a', { className: 'btn', href: cur ? `#/patient/${cur.id}` : '#/' }, '取消')),
    ),
  ], cur ? `#/patient/${cur.id}` : '#/');
  await refreshStatus();
}

// ───────────── 個案詳情 ─────────────

function precautionsBox(p: Patient, sticky = false): HTMLElement | null {
  return p.precautions ? h('div', { className: `precautions${sticky ? ' sticky-warn' : ''}`, role: 'alert' }, h('b', null, '⚠ 禁忌症與注意事項'), p.precautions) : null;
}

async function viewPatient(id: string): Promise<void> {
  const p = await svc.getPatient(id);
  if (!p) throw new DomainError('not_found', '找不到個案');
  const encs = await svc.listEncounters(id);
  const superseded = new Set(encs.map((e) => e.supersedes_id).filter(Boolean));
  const tests = await svc.listTests();
  const goals = await svc.listGoals(id);
  const msg = h('div');
  const canSelfPay = p.track !== 'ltc';

  const date = h('input', { type: 'date', value: todayTaipei() });
  const start = h('input', { type: 'time', value: timeNowTaipei() });
  const end = h('input', { type: 'time', value: timeNowTaipei() });
  const trackSel = h('select');
  const tracks: EncounterTrack[] = p.track === 'both' ? ['self_pay', 'ltc'] : [p.track];
  for (const t of tracks) trackSel.append(h('option', { value: t }, ETRACK_LABEL[t]));

  const create = async (): Promise<void> => {
    msg.replaceChildren();
    try {
      const e = await svc.createEncounter({
        patient_id: p.id, track: trackSel.value as EncounterTrack,
        service_date: date.value, start_time: start.value, end_time: end.value,
      });
      void doSync();
      location.hash = `#/encounter/${e.id}`;
    } catch (err) {
      msg.replaceChildren(errorBox(describeError(err)));
    }
  };

  /** 開始自費回診:建立草稿並帶入上次治療,計時開始 */
  const startVisit = async (): Promise<void> => {
    msg.replaceChildren();
    try {
      const { encounter, prefilled } = await svc.startVisit({ patient_id: p.id, service_date: todayTaipei(), start_time: timeNowTaipei(), end_time: timeNowTaipei() });
      markVisitStart(encounter.id);
      lsSet(`physio.mode.${encounter.id}`, prefilled ? 'quick' : 'full');
      void doSync();
      location.hash = `#/encounter/${encounter.id}`;
    } catch (err) {
      msg.replaceChildren(errorBox(describeError(err)));
    }
  };

  // 目標
  const goalLines: HTMLElement[] = [];
  for (const g of goals) {
    const { current, pct } = await goalProgressFor(repo, g);
    const t = tests.find((x) => x.id === g.test_id);
    goalLines.push(h('div', { className: 'version' },
      h('strong', null, g.description),
      h('div', { className: 'muted' }, `${t ? t.name : '未關聯測驗'}:基準 ${g.baseline_value ?? '–'} → 目前 ${current ?? '–'} → 目標 ${g.target_value ?? '–'}${pct === null ? '' : `(達成 ${pct}%)`}${g.deadline ? `;期限 ${g.deadline}` : ''}`)));
  }
  const gDesc = h('input', { placeholder: '例:TUG 降到 10 秒以內', lang: 'zh-TW' });
  const gTest = h('select', null, h('option', { value: '' }, '關聯測驗(選填)'), tests.map((t) => h('option', { value: t.id }, t.name)));
  const gBase = h('input', { type: 'text', inputMode: 'decimal', placeholder: '基準值' });
  const gTarget = h('input', { type: 'text', inputMode: 'decimal', placeholder: '目標值' });
  const gDate = h('input', { type: 'date' });
  const addGoal = async (): Promise<void> => {
    msg.replaceChildren();
    try {
      const num = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
      await svc.createGoal({ patient_id: p.id, description: gDesc.value.trim(), baseline_value: num(gBase.value), target_value: num(gTarget.value), deadline: gDate.value || null, test_id: gTest.value || null });
      void doSync();
      await render();
    } catch (err) {
      msg.replaceChildren(errorBox(describeError(err)));
    }
  };

  // 趨勢圖(同一測驗跨次數)
  const charts: HTMLElement[] = [];
  for (const tid of await testsUsedBy(repo, id)) {
    const t = tests.find((x) => x.id === tid);
    if (!t) continue;
    const pts = await trendFor(repo, id, tid);
    if (pts.length === 0) continue;
    const cut = t.cutoffs as unknown as CutoffData | null;
    charts.push(trendChart(t, pts, cut ? { value: cut.value, label: '切點' } : undefined));
  }

  layout(p.name, [
    precautionsBox(p),
    h('div', { className: 'card' },
      h('div', { className: 'row' }, h('span', { className: 'badge' }, TRACK_LABEL[p.track]), p.archived_at ? h('span', { className: 'badge' }, '已結案') : null,
        h('span', { className: 'grow' }),
        h('a', { className: 'btn', href: `#/patient/${p.id}/edit` }, '編輯')),
      h('p', { className: 'muted' }, [`生日 ${p.birth_date}`, p.phone, p.address].filter(Boolean).join(' · ')),
      p.emergency_contact ? h('p', { className: 'muted' }, `緊急聯絡人:${p.emergency_contact.name}(${p.emergency_contact.relation}) ${p.emergency_contact.phone}`) : null,
      h('div', { className: 'row' },
        p.archived_at
          ? h('button', { onclick: () => void svc.reopenPatient(p.id).then(() => { void doSync(); return render(); }) }, '重新開案')
          : h('button', { className: 'danger', onclick: () => { if (confirm('確定結案?資料會保留,不會刪除。')) void svc.archivePatient(p.id).then(() => { void doSync(); return render(); }); } }, '結案'),
      ),
    ),
    p.archived_at || !canSelfPay ? null : h('div', { className: 'card' },
      h('button', { className: 'primary', onclick: () => void startVisit() }, '▶ 開始自費回診(快速模式)'),
      h('p', { className: 'muted' }, '會自動帶入上次治療的介入與居家運動處方,只需校對差異點。'),
      msg,
    ),
    p.archived_at ? null : h('details', { className: 'card' },
      h('summary', null, '新增空白服務紀錄(補登/長照)'),
      h('div', { className: 'grid2' }, h('div', null, h('label', { className: 'f' }, '日期'), date), h('div', null, h('label', { className: 'f' }, '軌別'), trackSel)),
      h('div', { className: 'grid2' }, h('div', null, h('label', { className: 'f' }, '開始'), start), h('div', null, h('label', { className: 'f' }, '結束'), end)),
      canSelfPay ? null : msg,
      h('p', null, h('button', { className: 'primary', onclick: () => void create() }, '建立')),
    ),
    await patientLineCard(viewCtx, p),
    h('div', { className: 'card' },
      h('h2', null, '治療目標'),
      goalLines.length === 0 ? h('p', { className: 'muted' }, '尚未設定目標。') : null,
      ...goalLines,
      h('details', null,
        h('summary', null, '＋ 新增目標'),
        field2('目標描述', gDesc),
        field2('關聯測驗', gTest),
        h('div', { className: 'grid3' }, field2('基準值', gBase), field2('目標值', gTarget), field2('期限', gDate)),
        h('p', null, h('button', { onclick: () => void addGoal() }, '儲存目標')),
      ),
    ),
    charts.length ? h('div', { className: 'card' }, h('h2', null, '測驗趨勢'), ...charts) : null,
    h('div', { className: 'card list' },
      h('h2', null, `服務紀錄(${encs.length})`),
      encs.length === 0 ? h('p', { className: 'muted' }, '尚無紀錄') : null,
      encs.map((e) =>
        h('a', { className: 'item', href: `#/encounter/${e.id}` },
          h('span', { className: 'name' }, `${e.service_date} ${e.start_time}–${e.end_time}`),
          h('span', { className: `badge ${e.status}` }, STATUS_LABEL[e.status]),
          h('span', { className: 'badge' }, ETRACK_LABEL[e.track]),
          e.version > 1 ? h('span', { className: 'badge' }, `v${e.version}`) : null,
          superseded.has(e.id) ? h('span', { className: 'badge' }, '已被新版取代') : null,
        ),
      ),
    ),
  ], '#/');
  await refreshStatus();
}

function minutesBetween(a: string, b: string): number | null {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  if (ah === undefined || am === undefined || bh === undefined || bm === undefined) return null;
  const d = bh * 60 + bm - (ah * 60 + am);
  return d > 0 ? d : null;
}

/**
 * 一鍵設定療程時長:結束 = 現在,開始 = 現在 − N 分。由治療師明確點選,系統不會自行猜測時間。
 * (到宅療程通常在個案還在現場時就寫紀錄,「開始」多半早於按下開始回診的時刻)
 */
function durationChips(start: HTMLInputElement, end: HTMLInputElement, prevMinutes: number | null): HTMLElement {
  const apply = (min: number): void => {
    const now = timeNowTaipei();
    const [hh, mm] = now.split(':').map(Number) as [number, number];
    const total = Math.max(0, hh * 60 + mm - min);
    start.value = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    end.value = now;
  };
  const opts = [...new Set([30, 45, 60, ...(prevMinutes ? [prevMinutes] : [])])].sort((x, y) => x - y);
  return h('div', null,
    h('label', { className: 'f' }, '一鍵設定療程時長(結束 = 現在)'),
    h('div', { className: 'chips' }, opts.map((m) => h('button', { type: 'button', className: 'chip', onclick: () => apply(m) }, m === prevMinutes ? `${m} 分鐘(同上次)` : `${m} 分鐘`))),
  );
}

function field2(label: string, el: Node): HTMLElement {
  return h('div', null, h('label', { className: 'f' }, label), el);
}

// ───────────── 服務紀錄 ─────────────

async function viewEncounter(id: string): Promise<void> {
  const e = await svc.getEncounter(id);
  if (!e) throw new DomainError('not_found', '找不到服務紀錄');
  const p = await svc.getPatient(e.patient_id);
  if (!p) throw new DomainError('not_found', '找不到個案');
  const chain = await svc.versionChain(id);
  const latest = chain[chain.length - 1] as Encounter;
  const locked = e.signed_at !== null;
  const msg = h('div');
  const tests = await svc.listTests();
  const exercises = await svc.listExercises();
  const prevEnc = e.track === 'self_pay' ? await svc.previousSoapContent(p.id, e.id) : null;
  const prevDurationMinutes = prevEnc ? minutesBetween(prevEnc.encounter.start_time, prevEnc.encounter.end_time) : null;

  const date = h('input', { type: 'date', value: e.service_date, disabled: locked });
  const start = h('input', { type: 'time', value: e.start_time, disabled: locked });
  const end = h('input', { type: 'time', value: e.end_time, disabled: locked });
  const loc = h('select', { disabled: locked },
    h('option', { value: '' }, '未填'), ...(['home', 'facility', 'community'] as Location[]).map((l) => h('option', { value: l }, LOC_LABEL[l])));
  loc.value = e.location ?? '';
  const code = h('input', { value: e.service_code ?? '', disabled: locked, placeholder: e.track === 'ltc' ? '例:CA07 / CC01' : '自費無需填寫' });

  const run = async (fn: () => Promise<void>): Promise<void> => {
    msg.replaceChildren();
    try {
      await fn();
      void doSync();
    } catch (err) {
      msg.replaceChildren(errorBox(describeError(err)));
    }
  };
  const saveMeta = (): Promise<Encounter> =>
    svc.updateEncounter(e.id, { service_date: date.value, start_time: start.value, end_time: end.value, location: (loc.value || null) as Location | null, service_code: code.value.trim() || null });

  const metaCard = h('details', { className: 'card', open: e.track === 'ltc' || locked || e.end_time <= e.start_time },
    h('summary', null, `服務時間與地點:${e.service_date} ${e.start_time}–${e.end_time}`),
    h('div', { className: 'grid2' }, h('div', null, h('label', { className: 'f' }, '日期'), date), h('div', null, h('label', { className: 'f' }, '地點'), loc)),
    h('div', { className: 'grid2' }, h('div', null, h('label', { className: 'f' }, '開始'), start), h('div', null, h('label', { className: 'f' }, '結束'), end)),
    h('label', { className: 'f' }, '服務代碼'), code,
    locked || e.track !== 'self_pay' ? null : durationChips(start, end, prevDurationMinutes),
  );

  const statusRow = h('div', { className: 'row' },
    h('span', { className: `badge ${e.status}` }, STATUS_LABEL[e.status]), h('span', { className: 'badge' }, ETRACK_LABEL[e.track]), h('span', { className: 'badge' }, `版本 v${e.version}`),
    e.id !== latest.id ? h('a', { className: 'btn', href: `#/encounter/${latest.id}` }, '前往最新版本') : null);

  const versionCard = h('div', { className: 'card' },
    h('h2', null, '版本軌跡'),
    chain.slice().reverse().map((v) =>
      h('div', { className: `version${v.id === e.id ? ' cur' : ''}` },
        h('a', { href: `#/encounter/${v.id}` }, `v${v.version}`), ` · ${STATUS_LABEL[v.status]}`,
        h('div', { className: 'muted' }, `建立 ${v.created_at}${v.signed_at ? `\n簽章 ${v.signed_at}` : ''}`),
      ),
    ),
  );

  const reviseBtn = locked && e.id === latest.id && e.status === 'signed'
    ? h('button', { className: 'primary', onclick: () => void run(async () => { const n = await svc.reviseEncounter(e.id); location.hash = `#/encounter/${n.id}`; }) }, '建立新版本以修改')
    : null;

  // ── 已簽章:唯讀 ──
  if (locked) {
    const body: (Node | null)[] = [
      precautionsBox(p, true),
      h('div', { className: 'card' }, statusRow, h('p', { className: 'muted' }, `已於 ${e.signed_at} 簽章鎖定,不可直接修改。如需更正請建立新版本,原版本會完整保留。`), msg, reviseBtn),
      metaCard,
      e.track === 'self_pay' ? soapReadonly(await svc.getSoapContent(e.id), tests, exercises) : null,
      await encounterLineCard(viewCtx, p, e),
      versionCard,
    ];
    layout(`${p.name} ${e.service_date}`, body, `#/patient/${p.id}`);
    await refreshStatus();
    return;
  }

  // ── 長照草稿(P3 前僅有時間欄位) ──
  if (e.track !== 'self_pay') {
    editingView = true;
    layout(`${p.name} ${e.service_date}`, [
      precautionsBox(p, true),
      h('div', { className: 'card' }, statusRow, msg,
        h('div', { className: 'row' },
          h('button', { onclick: () => void run(async () => { await saveMeta(); await render(); }) }, '儲存草稿'),
          h('button', { className: 'primary', onclick: () => void run(async () => { await saveMeta(); await svc.signEncounter(e.id); await render(); }) }, '簽章鎖定'))),
      metaCard,
      h('p', { className: 'muted' }, '長照申報欄位將於 P3 加入。'),
      await encounterLineCard(viewCtx, p, e),
      versionCard,
    ], `#/patient/${p.id}`);
    await refreshStatus();
    return;
  }

  // ── 自費草稿:SOAP 表單 ──
  editingView = true;
  const mode: FormMode = lsGet<FormMode>(`physio.mode.${e.id}`, e.version > 1 ? 'quick' : 'full');
  const prev = prevEnc;
  const goals = await svc.listGoals(p.id);
  const goalLatest = new Map<string, number | null>();
  for (const g of goals) {
    if (!g.test_id) continue;
    const pts = (await trendFor(repo, p.id, g.test_id)).filter((x) => x.encounter_id !== e.id);
    goalLatest.set(g.id, pts.length ? (pts[pts.length - 1] as { value: number }).value : null);
  }
  const saveState = h('span', { className: 'saved' }, '');
  const form = soapForm({
    svc, patient: p, encounter: e, mode,
    initial: await svc.getSoapContent(e.id), prev: prev?.content ?? null,
    tests, exercises, goals, goalLatest,
    favTests: (await svc.listFavorites('test')).map((f) => f.ref_id),
    favExercises: (await svc.listFavorites('exercise')).map((f) => f.ref_id),
    onSaveState: (st, m) => {
      saveState.textContent = st === 'saving' ? '儲存中…' : st === 'saved' ? '已自動儲存(本機)' : `儲存失敗:${m ?? ''}`;
      saveState.style.color = st === 'error' ? 'var(--danger)' : '';
    },
  });

  const started = lsGet<Record<string, number>>(visitStartKey, {})[e.id];
  const timerEl = h('span', { className: 'badge timer' }, '');
  if (started !== undefined) {
    const tick = (): void => {
      if (!timerEl.isConnected) return;
      const sec = Math.round((Date.now() - started) / 1000);
      timerEl.textContent = `已用 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      setTimeout(tick, 1000);
    };
    tick();
  }

  const setMode = async (m: FormMode): Promise<void> => {
    await form.flush();
    lsSet(`physio.mode.${e.id}`, m);
    await render();
  };

  const sign = (): Promise<void> =>
    run(async () => {
      await form.flush();
      await saveMeta(); // 使用者在「時間與地點」改的時間一併儲存
      const cur = await svc.getEncounter(e.id);
      if (cur && cur.end_time <= cur.start_time && timeNowTaipei() > cur.start_time) await svc.updateEncounter(e.id, { end_time: timeNowTaipei() });
      try {
        await svc.signEncounter(e.id);
      } catch (err) {
        if (err instanceof DomainError && err.message.includes('結束時間')) {
          metaCard.open = true; // 引導使用者到該改的欄位
          metaCard.scrollIntoView({ block: 'center' });
        }
        throw err;
      }
      recordTiming(e.id, mode);
      await render();
    });

  layout(`${p.name} ${e.service_date}`, [
    precautionsBox(p, true),
    h('div', { className: 'card' },
      statusRow,
      h('div', { className: 'row' },
        h('div', { className: 'seg grow' },
          h('button', { className: mode === 'quick' ? 'on' : '', onclick: () => void setMode('quick') }, '快速模式'),
          h('button', { className: mode === 'full' ? 'on' : '', onclick: () => void setMode('full') }, '完整模式')),
        timerEl, saveState),
      e.version > 1 ? h('p', { className: 'muted' }, `這是 v${e.version}(更正版),已帶入前一版內容。簽章後原版本仍完整保留。`) : null,
      prev ? h('p', { className: 'muted' }, `已帶入 ${prev.encounter.service_date} 的介入與居家運動處方;請校對差異點。`) : null,
    ),
    metaCard,
    form.el,
    await encounterLineCard(viewCtx, p, e),
    msg,
    h('div', { className: 'sign-bar' },
      h('button', { onclick: () => void run(async () => { await form.flush(); await saveMeta(); await render(); }) }, '儲存'),
      h('button', { className: 'primary', onclick: () => void sign() }, '簽章鎖定')),
    versionCard,
  ], `#/patient/${p.id}`);
  await refreshStatus();
}

// ───────────── 啟動 ─────────────

async function main(): Promise<void> {
  const db = await openPhysioDb();
  repo = new IdbRepo(db);
  svc = new DataService({ repo });
  await svc.seedDictionaries();
  viewCtx = {
    svc, layout, render, doSync, describeError, errorBox,
    setEditing: (v) => { editingView = v; },
    onVisitStarted: (encounterId, prefilled) => {
      markVisitStart(encounterId);
      lsSet(`physio.mode.${encounterId}`, prefilled ? 'quick' : 'full');
    },
    refreshStatus,
  };
  sched = scheduleViews(viewCtx);

  window.addEventListener('hashchange', () => void render());
  window.addEventListener('online', () => void doSync());
  window.addEventListener('offline', () => void refreshStatus());
  setInterval(() => void doSync(), 60_000);

  await render();
  void doSync();

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }
}

void main();
