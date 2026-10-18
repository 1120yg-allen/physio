// SOAP 表單(快速/完整共用同一份資料結構,差別只在顯示多少欄位)。
// 處理特種個資,不寫 log。文字欄位皆為一般 input/textarea,可直接使用 iOS 鍵盤的裝置端聽寫(C1)。
import { referenceFor } from '../shared/norms';
import type { Encounter, Exercise, Goal, Patient, TestDef } from '../shared/schema';
import type { DataService } from '../shared/service';
import { emptyDose, type Dose, type HepItem, type Intervention, type InterventionCategory, type Observation, type RiskFlag, type SoapContent, type Trend } from '../shared/soap';
import { goalPct } from '../shared/trend';
import { nowTaipei } from '../shared/time';
import { allRegions, bodyMap, regionLabel } from './bodymap';
import { h } from './dom';

export type FormMode = 'quick' | 'full';

export interface SoapFormCtx {
  svc: DataService;
  patient: Patient;
  encounter: Encounter;
  mode: FormMode;
  initial: SoapContent;
  /** 上一次紀錄(供對照上次數值) */
  prev: SoapContent | null;
  tests: TestDef[];
  exercises: Exercise[];
  goals: Goal[];
  /** 各目標在「本次之前」的最新測驗數值 */
  goalLatest: Map<string, number | null>;
  favTests: string[];
  favExercises: string[];
  onSaveState: (s: 'saving' | 'saved' | 'error', msg?: string) => void;
}

export interface SoapForm {
  el: HTMLElement;
  /** 立即儲存(簽章前呼叫) */
  flush(): Promise<void>;
  content(): SoapContent;
}

const CAT_LABEL: Record<InterventionCategory, string> = { manual: '徒手', exercise: '運動', functional: '功能性', education: '衛教' };
const TREND_LABEL: Record<Trend, string> = { improving: '進步', maintaining: '持平', declining: '退步' };
const RISK_LABEL: Record<RiskFlag, string> = { fall: '跌倒', cardiac: '心臟', skin: '皮膚', swallowing: '吞嚥', other: '其他' };

const numOrNull = (v: string): number | null => {
  const n = v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

const field = (label: string, ...kids: Node[]): HTMLElement => h('div', null, h('label', { className: 'f' }, label), ...kids);

function section(tag: string, title: string, ...kids: (Node | null)[]): HTMLElement {
  return h('section', { className: 'card sec' }, h('h2', null, h('span', { className: 'tag' }, tag), title), ...kids);
}

function text(value: string, onInput: (v: string) => void, placeholder = ''): HTMLInputElement {
  const i = h('input', { type: 'text', value, placeholder, lang: 'zh-TW', autocomplete: 'off', enterKeyHint: 'done' });
  i.addEventListener('input', () => onInput(i.value));
  return i;
}

function area(value: string, onInput: (v: string) => void, placeholder = ''): HTMLTextAreaElement {
  const a = h('textarea', { value, placeholder, lang: 'zh-TW' });
  a.addEventListener('input', () => onInput(a.value));
  return a;
}

function numInput(value: number | null, onInput: (v: number | null) => void, placeholder = ''): HTMLInputElement {
  const i = h('input', { type: 'text', inputMode: 'decimal', value: value === null ? '' : String(value), placeholder });
  i.addEventListener('input', () => onInput(numOrNull(i.value)));
  return i;
}

export function soapForm(ctx: SoapFormCtx): SoapForm {
  const c: SoapContent = structuredClone(ctx.initial);
  const full = ctx.mode === 'full';
  const root = h('div');
  const exName = (id: string): string => ctx.exercises.find((e) => e.id === id)?.name ?? id;
  const testOf = (id: string): TestDef | undefined => ctx.tests.find((t) => t.id === id);
  const favEx = new Set(ctx.favExercises);
  const favTest = new Set(ctx.favTests);

  // ── 自動儲存 ──
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> = Promise.resolve();
  const refreshGoals = (): void => {
    c.assessment.goal_progress = ctx.goals
      .filter((g) => g.test_id)
      .map((g) => {
        const own = c.objective.measures.find((m) => m.test_id === g.test_id);
        const current = own ? own.value : (ctx.goalLatest.get(g.id) ?? null);
        return { goal_id: g.id, baseline: g.baseline_value, current, target: g.target_value, pct: goalPct(g.baseline_value, current, g.target_value) };
      });
  };
  const save = (): Promise<void> => {
    clearTimeout(timer);
    refreshGoals();
    ctx.onSaveState('saving');
    inflight = inflight
      .then(() => ctx.svc.saveSoapContent(ctx.encounter.id, c))
      .then(() => ctx.onSaveState('saved'))
      .catch((e: unknown) => ctx.onSaveState('error', e instanceof Error ? e.message : '儲存失敗'));
    return inflight;
  };
  const dirty = (): void => {
    clearTimeout(timer);
    ctx.onSaveState('saving');
    timer = setTimeout(() => void save(), 600);
  };
  const redraw = (): void => {
    const top = window.scrollY;
    build();
    window.scrollTo(0, top);
    dirty();
  };

  // ── 共用小元件 ──
  const doseEditor = (dose: Dose): HTMLElement =>
    h('div', { className: 'dose' },
      h('div', null, h('label', null, '組'), numInput(dose.sets, (v) => { dose.sets = v; dirty(); })),
      h('div', null, h('label', null, '次'), numInput(dose.reps, (v) => { dose.reps = v; dirty(); })),
      h('div', null, h('label', null, '阻力'), text(dose.resistance ?? '', (v) => { dose.resistance = v || null; dirty(); })),
      h('div', null, h('label', null, '時間'), text(dose.duration ?? '', (v) => { dose.duration = v || null; dirty(); })),
    );

  const favButton = (set: Set<string>, kind: 'exercise' | 'test', id: string): HTMLButtonElement => {
    const b = h('button', { type: 'button', className: 'chip', ariaLabel: '加入或移出常用清單' }, set.has(id) ? '★' : '☆');
    b.addEventListener('click', () => {
      const on = !set.has(id);
      if (on) set.add(id);
      else set.delete(id);
      b.textContent = on ? '★' : '☆';
      void ctx.svc.setFavorite(kind, id, on);
    });
    return b;
  };

  /** 動作選擇器:常用清單置頂成 chip,其餘在下拉選單 */
  function exercisePicker(onPick: (e: Exercise) => void, category?: InterventionCategory): HTMLElement {
    const pool = ctx.exercises.filter((e) => !category || e.category === category);
    const favs = pool.filter((e) => favEx.has(e.id));
    const sel = h('select', { ariaLabel: '從動作庫加入' }, h('option', { value: '' }, '＋ 從動作庫加入…'));
    for (const e of pool) sel.append(h('option', { value: e.id }, `${CAT_LABEL[e.category]}・${e.name}${favEx.has(e.id) ? ' ★' : ''}`));
    sel.addEventListener('change', () => {
      const e = ctx.exercises.find((x) => x.id === sel.value);
      if (e) onPick(e);
    });
    const chips = h('div', { className: 'chips' }, favs.map((e) => {
      const b = h('button', { type: 'button', className: 'chip fav' }, `＋ ${e.name}`);
      b.addEventListener('click', () => onPick(e));
      return b;
    }));
    return h('div', null, favs.length ? chips : null, sel);
  }

  const doseOf = (e: Exercise): Dose => ({ ...emptyDose(), ...((e.default_dose ?? {}) as Partial<Dose>) });

  // ── S ──
  function secS(): HTMLElement {
    const s = c.subjective;
    const out = h('output', null, s.nprs.score === null ? '–' : String(s.nprs.score));
    const slider = h('input', { type: 'range', min: '0', max: '10', step: '1', value: String(s.nprs.score ?? 0), ariaLabel: 'NPRS 疼痛指數 0 到 10' });
    slider.addEventListener('input', () => {
      s.nprs.score = Number(slider.value);
      out.textContent = slider.value;
      dirty();
    });
    const clear = h('button', { type: 'button', onclick: () => { s.nprs.score = null; slider.value = '0'; out.textContent = '–'; dirty(); } }, '未填');

    const prescribed = s.hep_adherence.prescribed;
    const rep = h('output', null, s.hep_adherence.reported_sessions === null ? '–' : String(s.hep_adherence.reported_sessions));
    const step = (d: number): void => {
      s.hep_adherence.reported_sessions = Math.max(0, (s.hep_adherence.reported_sessions ?? 0) + d);
      rep.textContent = String(s.hep_adherence.reported_sessions);
      dirty();
    };

    return section('S', '主觀', 
      field('主訴(可按鍵盤麥克風語音輸入一句話)', text(s.chief_complaint, (v) => { s.chief_complaint = v; dirty(); }, '例:右膝爬樓梯還是會痛')),
      field('NPRS 疼痛(0–10)', h('div', { className: 'nprs' }, slider, out, clear)),
      field('疼痛部位', bodyMap(s.nprs.site, (sites) => { s.nprs.site = sites; dirty(); })),
      prescribed.length
        ? field(`居家運動回報(處方:${prescribed.map(exName).join('、')})`,
            h('div', { className: 'stepper' }, h('button', { type: 'button', onclick: () => step(-1) }, '−'), rep, h('button', { type: 'button', onclick: () => step(1) }, '＋'), h('span', { className: 'muted' }, '次/週')))
        : null,
      full ? field('居家運動回報備註', text(s.hep_adherence.note, (v) => { s.hep_adherence.note = v; dirty(); })) : null,
      full ? field('Borg RPE(6–20)', numInput(s.borg_rpe, (v) => { s.borg_rpe = v; dirty(); }, '6–20')) : null,
      full
        ? field('睡眠/食慾/情緒',
            h('div', { className: 'chips' },
              (['sleep', 'appetite', 'mood'] as const).map((k) => {
                const label = { sleep: '睡眠不佳', appetite: '食慾不佳', mood: '情緒低落' }[k];
                const b = h('button', { type: 'button', className: `chip${s.flags[k] ? ' on' : ''}` }, label);
                b.addEventListener('click', () => { s.flags[k] = !s.flags[k]; b.classList.toggle('on', s.flags[k]); dirty(); });
                return b;
              })),
            text(s.flags.note, (v) => { s.flags.note = v; dirty(); }, '備註'))
        : null,
    );
  }

  // ── O ──
  function interventionRow(i: Intervention, idx: number): HTMLElement {
    return h('div', { className: 'irow' },
      h('div', { className: 'top' },
        h('span', { className: 'badge' }, CAT_LABEL[i.category]),
        h('span', { className: 'nm' }, exName(i.item_id)),
        favButton(favEx, 'exercise', i.item_id),
        h('button', { type: 'button', className: 'chip', ariaLabel: '移除', onclick: () => { c.objective.interventions.splice(idx, 1); redraw(); } }, '✕'),
      ),
      doseEditor(i.dose),
    );
  }

  function measureRows(): HTMLElement {
    const rows = h('div');
    const used = new Set(c.objective.measures.map((m) => m.test_id));
    const pending = pendingTests.filter((t) => !used.has(t));
    const render = (testId: string): HTMLElement => {
      const t = testOf(testId);
      const m = c.objective.measures.find((x) => x.test_id === testId);
      const prevM = ctx.prev?.objective.measures.filter((x) => x.test_id === testId).pop();
      const refEl = h('div', { className: 'ref' });
      const paintRef = (): void => {
        const cur = c.objective.measures.find((x) => x.test_id === testId)?.value ?? null;
        const r = t ? referenceFor(t, ctx.patient, ctx.encounter.service_date, cur) : null;
        refEl.replaceChildren(
          ...[prevM ? `上次:${prevM.value} ${prevM.unit}` : null, r?.normLine, r?.cutoffLine ? `${r.cutoffLine}${r.relation ? `;本次${r.relation}` : ''}` : null]
            .filter((x): x is string => !!x)
            .map((x) => h('div', null, x)),
        );
      };
      paintRef();
      const input = numInput(m?.value ?? null, (v) => {
        const idx = c.objective.measures.findIndex((x) => x.test_id === testId);
        if (v === null) {
          if (idx >= 0) c.objective.measures.splice(idx, 1);
        } else if (idx >= 0) {
          (c.objective.measures[idx] as { value: number }).value = v;
        } else {
          c.objective.measures.push({ test_id: testId, value: v, unit: t?.unit ?? '', measured_at: nowTaipei() });
        }
        paintRef();
        dirty();
      }, t?.unit ?? '');
      return h('div', { className: 'irow' },
        h('div', { className: 'top' }, h('span', { className: 'nm' }, t?.name ?? testId), favButton(favTest, 'test', testId),
          h('button', { type: 'button', className: 'chip', ariaLabel: '移除', onclick: () => {
            const idx = c.objective.measures.findIndex((x) => x.test_id === testId);
            if (idx >= 0) c.objective.measures.splice(idx, 1);
            const p = pendingTests.indexOf(testId);
            if (p >= 0) pendingTests.splice(p, 1);
            redraw();
          } }, '✕')),
        input, refEl);
    };
    for (const id of [...new Set([...c.objective.measures.map((m) => m.test_id), ...pending])]) rows.append(render(id));

    const add = (id: string): void => { if (!pendingTests.includes(id)) pendingTests.push(id); redraw(); };
    const favs = ctx.tests.filter((t) => favTest.has(t.id) && !c.objective.measures.some((m) => m.test_id === t.id) && !pendingTests.includes(t.id));
    const sel = h('select', { ariaLabel: '加入測驗' }, h('option', { value: '' }, '＋ 加入標準化測驗…'), ctx.tests.map((t) => h('option', { value: t.id }, `${t.name}${favTest.has(t.id) ? ' ★' : ''}`)));
    sel.addEventListener('change', () => sel.value && add(sel.value));
    return h('div', null, rows,
      favs.length ? h('div', { className: 'chips' }, favs.map((t) => { const b = h('button', { type: 'button', className: 'chip fav' }, `＋ ${t.name}`); b.addEventListener('click', () => add(t.id)); return b; })) : null,
      sel);
  }

  function secO(): HTMLElement {
    const o = c.objective;
    const cats: (InterventionCategory | undefined)[] = [undefined, 'manual', 'exercise', 'functional', 'education'];
    const pickerHolder = h('div');
    const drawPicker = (): void => {
      pickerHolder.replaceChildren(
        h('div', { className: 'chips' }, cats.map((k) => {
          const b = h('button', { type: 'button', className: `chip${pickCat === k ? ' on' : ''}` }, k ? CAT_LABEL[k] : '全部');
          b.addEventListener('click', () => { pickCat = k; drawPicker(); });
          return b;
        })),
        exercisePicker((e) => { o.interventions.push({ category: e.category, item_id: e.id, dose: doseOf(e) }); redraw(); }, pickCat),
      );
    };
    drawPicker();

    return section('O', '客觀',
      h('label', { className: 'f' }, '介入項目'),
      o.interventions.length === 0 ? h('p', { className: 'muted' }, '尚未加入。') : null,
      ...o.interventions.map(interventionRow),
      pickerHolder,
      h('label', { className: 'f' }, '標準化測驗'),
      measureRows(),
      full ? h('label', { className: 'f' }, '生命徵象') : null,
      full
        ? h('div', { className: 'grid2' },
            field('收縮壓', numInput(o.vitals.bp_s, (v) => { o.vitals.bp_s = v; dirty(); }, 'mmHg')),
            field('舒張壓', numInput(o.vitals.bp_d, (v) => { o.vitals.bp_d = v; dirty(); }, 'mmHg')),
            field('心率', numInput(o.vitals.hr, (v) => { o.vitals.hr = v; dirty(); }, 'bpm')),
            field('血氧', numInput(o.vitals.spo2, (v) => { o.vitals.spo2 = v; dirty(); }, '%')))
        : null,
      full ? observationEditor(o.observations) : null,
    );
  }

  function observationEditor(list: Observation[]): HTMLElement {
    return h('div', null,
      h('label', { className: 'f' }, '觀察/理學檢查'),
      ...list.map((ob, idx) => {
        const region = h('select', null, allRegions().map((r) => h('option', { value: r }, regionLabel(r))));
        region.value = ob.region;
        region.addEventListener('change', () => { ob.region = region.value; dirty(); });
        return h('div', { className: 'irow' },
          h('div', { className: 'top' }, region, h('button', { type: 'button', className: 'chip', ariaLabel: '移除', onclick: () => { list.splice(idx, 1); redraw(); } }, '✕')),
          text(ob.quality_tag.join('、'), (v) => { ob.quality_tag = v.split(/[、,,\s]+/).filter(Boolean); dirty(); }, '特徵標籤(以、分隔)例:腫脹、活動度受限'),
          text(ob.note, (v) => { ob.note = v; dirty(); }, '備註'));
      }),
      h('button', { type: 'button', onclick: () => { list.push({ region: 'head', quality_tag: [], note: '' }); redraw(); } }, '＋ 新增觀察'),
    );
  }

  // ── A ──
  function secA(): HTMLElement {
    const a = c.assessment;
    refreshGoals();
    const goalLines = a.goal_progress.map((g) => {
      const goal = ctx.goals.find((x) => x.id === g.goal_id);
      return h('div', { className: 'ref' }, `${goal?.description ?? '目標'}:基準 ${g.baseline ?? '–'} → 目前 ${g.current ?? '–'} → 目標 ${g.target ?? '–'}${g.pct === null ? '' : `(達成 ${g.pct}%)`}`);
    });
    return section('A', '評估',
      field('整體趨勢(治療師判斷)', h('div', { className: 'seg' }, (['improving', 'maintaining', 'declining'] as Trend[]).map((t) => {
        const b = h('button', { type: 'button', className: a.trend === t ? 'on' : '' }, TREND_LABEL[t]);
        b.addEventListener('click', () => { a.trend = a.trend === t ? null : t; redraw(); });
        return b;
      }))),
      goalLines.length ? field('目標進度(依測驗數值自動計算)', ...goalLines) : null,
      field('臨床推理', full ? area(a.clinical_reasoning, (v) => { a.clinical_reasoning = v; dirty(); }) : text(a.clinical_reasoning, (v) => { a.clinical_reasoning = v; dirty(); }, '一句話即可')),
      full
        ? field('風險標記(治療師自行勾選)', h('div', { className: 'chips' }, (Object.keys(RISK_LABEL) as RiskFlag[]).map((r) => {
            const b = h('button', { type: 'button', className: `chip${a.risk_flags.includes(r) ? ' on' : ''}` }, RISK_LABEL[r]);
            b.addEventListener('click', () => {
              a.risk_flags = a.risk_flags.includes(r) ? a.risk_flags.filter((x) => x !== r) : [...a.risk_flags, r];
              b.classList.toggle('on', a.risk_flags.includes(r));
              dirty();
            });
            return b;
          })))
        : null,
    );
  }

  // ── P ──
  function hepRow(item: HepItem, idx: number): HTMLElement {
    return h('div', { className: 'irow' },
      h('div', { className: 'top' }, h('span', { className: 'nm' }, exName(item.item_id)), favButton(favEx, 'exercise', item.item_id),
        h('button', { type: 'button', className: 'chip', ariaLabel: '移除', onclick: () => { c.plan.hep.splice(idx, 1); redraw(); } }, '✕')),
      doseEditor(item.dose));
  }

  function secP(): HTMLElement {
    const p = c.plan;
    return section('P', '計畫',
      field('下次治療重點', text(p.next_focus, (v) => { p.next_focus = v; dirty(); }, '一句話即可')),
      h('label', { className: 'f' }, '居家運動處方(HEP)'),
      p.hep.length === 0 ? h('p', { className: 'muted' }, '尚未開立。') : null,
      ...p.hep.map(hepRow),
      exercisePicker((e) => { p.hep.push({ item_id: e.id, dose: doseOf(e), video_ref: e.video_ref }); redraw(); }, 'exercise'),
      full ? field('頻率調整', text(p.frequency_change, (v) => { p.frequency_change = v; dirty(); }, '例:改為每週兩次')) : null,
      full ? field('轉介/照會', area(p.referral, (v) => { p.referral = v; dirty(); })) : null,
    );
  }

  let pickCat: InterventionCategory | undefined;
  const pendingTests: string[] = [];

  function build(): void {
    root.replaceChildren(secS(), secO(), secA(), secP());
  }
  build();

  return {
    el: root,
    flush: save,
    content: () => c,
  };
}
