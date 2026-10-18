// 排程畫面:日/週檢視、新增/編輯行程、從行程一鍵開啟服務紀錄、同日地址排序提示。
// 畫面含個案姓名與地址(個資),不寫 log。
import type { Appointment, Encounter, EncounterTrack, Patient } from '../shared/schema';
import { addDays, addressOrder, appointmentsOn, dateOf, orderDiffersFromTime, overlappingIds, timeOf, weekDates, weekdayLabel } from '../shared/schedule';
import type { DataService } from '../shared/service';
import { todayTaipei } from '../shared/time';
import { DomainError } from '../shared/validate';
import { h } from './dom';
import { STATIC_MODE } from './env';

export interface ViewCtx {
  svc: DataService;
  layout(title: string, body: (Node | null)[], back?: string): void;
  render(): Promise<void>;
  doSync(): Promise<void>;
  describeError(e: unknown): string;
  errorBox(msg: string): HTMLElement;
  setEditing(v: boolean): void;
  /** 從行程開啟服務紀錄後的處理(記錄計時起點、預設模式) */
  onVisitStarted(encounterId: string, prefilled: boolean): void;
  refreshStatus(): Promise<void>;
}

const TRACK: Record<EncounterTrack, string> = { self_pay: '自費', ltc: '長照' };
const ENC_STATUS = { draft: '草稿', signed: '已簽章', submitted: '已送出申報' } as const;

interface GcalStatus {
  enabled: boolean;
  reason?: string;
  privacy: string;
  running: boolean;
  last_run_at: string | null;
  last_ok: boolean | null;
  last_error: string | null;
}

async function fetchGcalStatus(): Promise<GcalStatus | null> {
  if (STATIC_MODE) return null;
  try {
    const res = await fetch('/api/gcal/status', { signal: AbortSignal.timeout(3000) });
    return res.ok ? ((await res.json()) as GcalStatus) : null;
  } catch {
    return null; // 離線或服務未回應:排程仍可正常使用
  }
}

export function scheduleViews(ctx: ViewCtx): {
  viewSchedule(mode: 'day' | 'week', date: string): Promise<void>;
  viewAppointmentForm(id: string | null, date: string): Promise<void>;
} {
  const { svc } = ctx;

  async function patientMap(): Promise<Map<string, Patient>> {
    return new Map((await svc.searchPatients('', true)).map((p) => [p.id, p]));
  }

  async function encounterMap(list: Appointment[]): Promise<Map<string, Encounter>> {
    const m = new Map<string, Encounter>();
    for (const a of list) {
      if (!a.encounter_id) continue;
      const e = await svc.getEncounter(a.encounter_id);
      if (e) m.set(a.id, e);
    }
    return m;
  }

  function card(a: Appointment, patients: Map<string, Patient>, encs: Map<string, Encounter>, overlaps: Set<string>, msg: HTMLElement): HTMLElement {
    const p = a.patient_id ? patients.get(a.patient_id) : undefined;
    const enc = encs.get(a.id);
    const cancelled = a.status === 'cancelled';
    const act = async (fn: () => Promise<void>): Promise<void> => {
      msg.replaceChildren();
      try {
        await fn();
        void ctx.doSync();
      } catch (e) {
        msg.replaceChildren(ctx.errorBox(ctx.describeError(e)));
      }
    };
    const start = (): Promise<void> =>
      act(async () => {
        const r = await svc.startFromAppointment(a.id);
        if (r.created) ctx.onVisitStarted(r.encounter.id, r.prefilled);
        location.hash = `#/encounter/${r.encounter.id}`;
      });

    return h('div', { className: `appt${cancelled ? ' cancelled' : ''}` },
      h('div', { className: 'appt-time' }, `${timeOf(a.start_at)}`, h('span', { className: 'muted' }, `–${timeOf(a.end_at)}`)),
      h('div', { className: 'appt-main' },
        h('div', null,
          h('strong', null, p ? p.name : (a.title ?? '未指定個案')),
          h('span', { className: 'badge' }, TRACK[a.track]),
          !p ? h('span', { className: 'badge draft' }, '未指定個案') : null,
          cancelled ? h('span', { className: 'badge' }, '已取消') : null,
          enc ? h('span', { className: `badge ${enc.status}` }, `紀錄${ENC_STATUS[enc.status]}`) : null,
          overlaps.has(a.id) ? h('span', { className: 'badge draft' }, '⚠ 時間重疊') : null,
        ),
        a.location_text ? h('div', { className: 'muted' }, a.location_text) : null,
        a.note ? h('div', { className: 'muted' }, a.note) : null,
        p?.precautions ? h('div', { className: 'muted warn-text' }, '⚠ 有禁忌症/注意事項') : null,
        h('div', { className: 'row appt-actions' },
          cancelled
            ? h('button', { onclick: () => void act(async () => { await svc.restoreAppointment(a.id); await ctx.render(); }) }, '恢復行程')
            : [
                enc
                  ? h('a', { className: 'btn primary', href: `#/encounter/${enc.id}` }, '開啟紀錄')
                  : h('button', { className: 'primary', onclick: () => void start() }, p ? '▶ 開始服務' : '指定個案後開始'),
                h('a', { className: 'btn', href: `#/schedule/edit/${a.id}` }, '編輯'),
                enc ? null : h('button', { className: 'danger', onclick: () => { if (confirm('確定取消此行程?')) void act(async () => { await svc.cancelAppointment(a.id); await ctx.render(); }); } }, '取消'),
              ],
        ),
      ),
    );
  }

  /** 同日地址排序提示:只提示相近地點的先後,不是路線規劃 */
  function routeHint(day: Appointment[], patients: Map<string, Patient>): HTMLElement | null {
    const withAddr = day.filter((a) => a.status !== 'cancelled');
    if (withAddr.length < 2) return null;
    const ordered = addressOrder(withAddr);
    const differs = orderDiffersFromTime(withAddr);
    return h('div', { className: 'card' },
      h('h2', null, '同日地址排序提示'),
      h('p', { className: 'muted' }, differs ? '依地址把相近的地點排在一起(縣市 → 區 → 路 → 門牌)。僅供參考,不是路線規劃,請自行考量時間與交通。' : '目前的時間順序與地址分區順序一致。'),
      h('ol', null, ordered.map((a) => h('li', null, `${timeOf(a.start_at)} ${a.patient_id ? (patients.get(a.patient_id)?.name ?? '') : (a.title ?? '未指定個案')}｜${a.location_text ?? '(無地址)'}`))),
    );
  }

  async function viewSchedule(mode: 'day' | 'week', date: string): Promise<void> {
    const dates = mode === 'day' ? [date] : weekDates(date);
    const all = await svc.listAppointments(dates[0] as string, dates[dates.length - 1] as string);
    const patients = await patientMap();
    const encs = await encounterMap(all);
    const overlaps = overlappingIds(all);
    const msg = h('div');
    const step = mode === 'day' ? 1 : 7;
    const nav = (d: string, label: string): HTMLElement => h('a', { className: 'btn', href: `#/schedule/${mode}/${d}` }, label);

    const title = mode === 'day' ? `${date}(${weekdayLabel(date)})` : `${dates[0]} – ${dates[6]}`;
    const gcal = await fetchGcalStatus();
    const gcalLine = h('div', { className: 'muted gcal-line' });
    const paintGcal = (g: GcalStatus | null): void => {
      gcalLine.replaceChildren(
        g === null
          ? (STATIC_MODE ? 'Google 行事曆同步:純本機版無法使用,請在自己的電腦執行 npm start' : 'Google 行事曆:無法取得狀態(離線或服務未啟動)')
          : !g.enabled
            ? `Google 行事曆同步:未啟用${g.reason ? `(${g.reason})` : ''}`
            : `Google 行事曆同步:已啟用(隱私等級 ${g.privacy === 'full' ? '完整' : '最小'})${g.last_run_at ? `;上次 ${g.last_run_at.slice(0, 16).replace('T', ' ')} ${g.last_ok ? '成功' : `失敗:${g.last_error ?? ''}`}` : ''}`,
        g?.enabled ? h('button', { className: 'chip', onclick: () => void syncGcal() }, '立即同步 Google') : '',
      );
    };
    const syncGcal = async (): Promise<void> => {
      try {
        await fetch('/api/gcal/sync', { method: 'POST', signal: AbortSignal.timeout(60_000) });
        await ctx.doSync();
        await ctx.render();
      } catch {
        msg.replaceChildren(ctx.errorBox('無法連線到伺服器,Google 行事曆同步未執行'));
      }
    };
    paintGcal(gcal);

    const sections = dates.map((d) => {
      const day = appointmentsOn(all, d, true);
      const isToday = d === todayTaipei();
      return h('div', { className: 'card' },
        mode === 'week'
          ? h('div', { className: 'row' },
              h('h2', { className: 'grow' }, `${d.slice(5)}(${weekdayLabel(d)})${isToday ? ' · 今天' : ''}`),
              h('span', { className: 'muted' }, `${day.filter((a) => a.status !== 'cancelled').length} 個行程`),
              h('a', { className: 'btn', href: `#/schedule/day/${d}` }, '當日'),
              h('a', { className: 'btn', href: `#/schedule/new/${d}` }, '＋'))
          : null,
        day.length === 0 && mode === 'day' ? h('p', { className: 'muted' }, '沒有行程') : null,
        ...day.map((a) => card(a, patients, encs, overlaps, msg)),
      );
    });

    ctx.layout('排程', [
      h('div', { className: 'card' },
        h('div', { className: 'row' },
          nav(addDays(date, -step), '‹'), nav(todayTaipei(), '今天'), nav(addDays(date, step), '›'),
          h('strong', { className: 'grow sched-title' }, title),
          h('div', { className: 'seg' },
            h('a', { className: `btn${mode === 'day' ? ' on' : ''}`, href: `#/schedule/day/${date}` }, '日'),
            h('a', { className: `btn${mode === 'week' ? ' on' : ''}`, href: `#/schedule/week/${date}` }, '週')),
          h('a', { className: 'btn primary', href: `#/schedule/new/${mode === 'day' ? date : todayTaipei()}` }, '＋ 新增行程')),
        gcalLine),
      msg,
      ...sections,
      mode === 'day' ? routeHint(appointmentsOn(all, date), patients) : null,
    ]);
    await ctx.refreshStatus();
  }

  async function viewAppointmentForm(id: string | null, date: string): Promise<void> {
    ctx.setEditing(true);
    const cur = id ? await svc.getAppointment(id) : null;
    if (id && !cur) throw new DomainError('not_found', '找不到行程');
    const patients = (await svc.searchPatients()).filter((p) => !p.archived_at || p.id === cur?.patient_id);
    const msg = h('div');
    const locked = cur?.encounter_id != null;

    const patientSel = h('select', { disabled: locked }, h('option', { value: '' }, cur && !cur.patient_id ? '(未指定個案)' : '選擇個案…'), patients.map((p) => h('option', { value: p.id }, `${p.name}(${p.track === 'both' ? '自費+長照' : TRACK[p.track]})`)));
    patientSel.value = cur?.patient_id ?? '';
    const dateIn = h('input', { type: 'date', value: cur ? dateOf(cur.start_at) : date });
    const startIn = h('input', { type: 'time', value: cur ? timeOf(cur.start_at) : '14:00' });
    const endIn = h('input', { type: 'time', value: cur ? timeOf(cur.end_at) : '15:00' });
    const trackSel = h('select', { disabled: locked }, h('option', { value: 'self_pay' }, '自費'), h('option', { value: 'ltc' }, '長照'));
    trackSel.value = cur?.track ?? 'self_pay';
    const loc = h('input', { value: cur?.location_text ?? '', placeholder: '到宅地址(預設帶入個案地址)', lang: 'zh-TW' });
    const note = h('input', { value: cur?.note ?? '', placeholder: '備註(選填)', lang: 'zh-TW' });
    let locTouched = cur !== null;

    loc.addEventListener('input', () => (locTouched = true));
    patientSel.addEventListener('change', () => {
      const p = patients.find((x) => x.id === patientSel.value);
      if (!p) return;
      if (!locTouched) loc.value = p.address ?? '';
      if (p.track !== 'both') trackSel.value = p.track;
    });

    const save = async (): Promise<void> => {
      msg.replaceChildren();
      try {
        const base = { date: dateIn.value, start: startIn.value, end: endIn.value, track: trackSel.value as EncounterTrack, location_text: loc.value.trim() || null, note: note.value.trim() || null };
        if (cur) {
          await svc.updateAppointment(cur.id, { ...base, ...(locked ? {} : { patient_id: patientSel.value || null }) });
        } else {
          if (!patientSel.value) throw new DomainError('required', '請選擇個案');
          await svc.createAppointment({ ...base, patient_id: patientSel.value });
        }
        void ctx.doSync();
        location.hash = `#/schedule/day/${dateIn.value}`;
      } catch (e) {
        msg.replaceChildren(ctx.errorBox(ctx.describeError(e)));
      }
    };
    const f = (label: string, el: Node): HTMLElement => h('div', null, h('label', { className: 'f' }, label), el);

    ctx.layout(cur ? '編輯行程' : '新增行程', [
      h('div', { className: 'card' },
        locked ? h('p', { className: 'muted' }, '此行程已開啟服務紀錄,個案與軌別不可更換。') : null,
        f('個案', patientSel),
        h('div', { className: 'grid2' }, f('日期', dateIn), f('軌別', trackSel)),
        h('div', { className: 'grid2' }, f('開始', startIn), f('結束', endIn)),
        f('地址', loc), f('備註', note), msg,
        h('div', { className: 'row' }, h('button', { className: 'primary grow', onclick: () => void save() }, '儲存'), h('a', { className: 'btn', href: `#/schedule/day/${cur ? dateOf(cur.start_at) : date}` }, '取消')),
      ),
    ], `#/schedule/day/${cur ? dateOf(cur.start_at) : date}`);
    await ctx.refreshStatus();
  }

  return { viewSchedule, viewAppointmentForm };
}
