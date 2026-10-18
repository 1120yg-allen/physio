import './style.css';
import { DataService } from '../shared/service';
import type { Encounter, EncounterTrack, Gender, Location, Patient, Track } from '../shared/schema';
import { todayTaipei, timeNowTaipei } from '../shared/time';
import { DomainError } from '../shared/validate';
import { h } from './dom';
import { IdbRepo, openPhysioDb } from './idb';
import { httpTransport, runSync, type SyncOutcome } from './sync';

const TRACK_LABEL: Record<Track, string> = { self_pay: '自費', ltc: '長照', both: '自費+長照' };
const ETRACK_LABEL: Record<EncounterTrack, string> = { self_pay: '自費', ltc: '長照' };
const STATUS_LABEL = { draft: '草稿', signed: '已簽章', submitted: '已送出申報' } as const;
const LOC_LABEL: Record<Location, string> = { home: '居家', facility: '機構', community: '社區' };

let repo: IdbRepo;
let svc: DataService;
const app = document.getElementById('app') as HTMLElement;

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
  if (lastSync?.ok && lastSync.pulled > 0) await render();
}

// ───────────── 路由 ─────────────

function layout(title: string, body: (Node | null)[], back?: string): void {
  app.replaceChildren(
    h('header', { className: 'bar' },
      back ? h('a', { className: 'home btn', href: back }, '‹') : null,
      h('h1', null, title),
      statusEl,
      h('button', { onclick: () => void doSync() }, '同步'),
    ),
    ...body.filter((n): n is Node => n !== null),
  );
}

function errorBox(msg: string): HTMLElement {
  return h('div', { className: 'err', role: 'alert' }, msg);
}

function describeError(e: unknown): string {
  return e instanceof DomainError ? e.message : '發生未預期的錯誤,資料未儲存';
}

async function render(): Promise<void> {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
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

function precautionsBox(p: Patient): HTMLElement | null {
  return p.precautions ? h('div', { className: 'precautions', role: 'alert' }, h('b', null, '⚠ 禁忌症與注意事項'), p.precautions) : null;
}

async function viewPatient(id: string): Promise<void> {
  const p = await svc.getPatient(id);
  if (!p) throw new DomainError('not_found', '找不到個案');
  const encs = await svc.listEncounters(id);
  const superseded = new Set(encs.map((e) => e.supersedes_id).filter(Boolean));
  const msg = h('div');

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
    p.archived_at ? null : h('div', { className: 'card' },
      h('h2', null, '新增空白服務紀錄'),
      h('div', { className: 'grid2' }, h('div', null, h('label', { className: 'f' }, '日期'), date), h('div', null, h('label', { className: 'f' }, '軌別'), trackSel)),
      h('div', { className: 'grid2' }, h('div', null, h('label', { className: 'f' }, '開始'), start), h('div', null, h('label', { className: 'f' }, '結束'), end)),
      msg,
      h('p', null, h('button', { className: 'primary', onclick: () => void create() }, '建立')),
    ),
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

  layout(`${p.name} ${e.service_date}`, [
    precautionsBox(p),
    h('div', { className: 'card' },
      h('div', { className: 'row' },
        h('span', { className: `badge ${e.status}` }, STATUS_LABEL[e.status]), h('span', { className: 'badge' }, ETRACK_LABEL[e.track]), h('span', { className: 'badge' }, `版本 v${e.version}`),
        e.id !== latest.id ? h('a', { className: 'btn', href: `#/encounter/${latest.id}` }, '前往最新版本') : null),
      locked ? h('p', { className: 'muted' }, `已於 ${e.signed_at} 簽章鎖定,不可直接修改。如需更正請建立新版本,原版本會完整保留。`) : null,
      h('div', { className: 'grid2' }, h('div', null, h('label', { className: 'f' }, '日期'), date), h('div', null, h('label', { className: 'f' }, '地點'), loc)),
      h('div', { className: 'grid2' }, h('div', null, h('label', { className: 'f' }, '開始'), start), h('div', null, h('label', { className: 'f' }, '結束'), end)),
      h('label', { className: 'f' }, '服務代碼'), code,
      msg,
      h('div', { className: 'row' },
        locked
          ? (e.id === latest.id && e.status === 'signed'
              ? h('button', { className: 'primary', onclick: () => void run(async () => { const n = await svc.reviseEncounter(e.id); location.hash = `#/encounter/${n.id}`; }) }, '建立新版本以修改')
              : null)
          : [
              h('button', { onclick: () => void run(async () => { await saveMeta(); await render(); }) }, '儲存草稿'),
              h('button', { className: 'primary', onclick: () => void run(async () => { await saveMeta(); await svc.signEncounter(e.id); await render(); }) }, '簽章鎖定'),
            ],
      ),
    ),
    h('div', { className: 'card' },
      h('h2', null, '版本軌跡'),
      chain.slice().reverse().map((v) =>
        h('div', { className: `version${v.id === e.id ? ' cur' : ''}` },
          h('a', { href: `#/encounter/${v.id}` }, `v${v.version}`), ` · ${STATUS_LABEL[v.status]}`,
          h('div', { className: 'muted' }, `建立 ${v.created_at}${v.signed_at ? `\n簽章 ${v.signed_at}` : ''}`),
        ),
      ),
    ),
    h('p', { className: 'muted' }, 'SOAP / 長照申報欄位將於後續階段(P1 / P3)加入。'),
  ], `#/patient/${p.id}`);
  await refreshStatus();
}

// ───────────── 啟動 ─────────────

async function main(): Promise<void> {
  const db = await openPhysioDb();
  repo = new IdbRepo(db);
  svc = new DataService({ repo });

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
