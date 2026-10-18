// 已簽章 SOAP 的唯讀「專業版」檢視。
import type { Exercise, TestDef } from '../shared/schema';
import type { Dose, SoapContent } from '../shared/soap';
import { regionLabel } from './bodymap';
import { h } from './dom';

const TREND = { improving: '進步', maintaining: '持平', declining: '退步' } as const;
const RISK = { fall: '跌倒', cardiac: '心臟', skin: '皮膚', swallowing: '吞嚥', other: '其他' } as const;
const CAT = { manual: '徒手', exercise: '運動', functional: '功能性', education: '衛教' } as const;

function dose(d: Dose): string {
  return [d.sets !== null && d.reps !== null ? `${d.sets}×${d.reps}` : d.sets !== null ? `${d.sets} 組` : d.reps !== null ? `${d.reps} 次` : null, d.resistance, d.duration].filter(Boolean).join(' / ');
}

export function soapReadonly(c: SoapContent, tests: TestDef[], exercises: Exercise[]): HTMLElement {
  const ex = (id: string): string => exercises.find((e) => e.id === id)?.name ?? id;
  const tn = (id: string): TestDef | undefined => tests.find((t) => t.id === id);
  const row = (label: string, value: string | null | false | undefined): HTMLElement[] =>
    value ? [h('dt', null, label), h('dd', null, value)] : [];
  const s = c.subjective;
  const o = c.objective;
  const a = c.assessment;
  const p = c.plan;
  const v = o.vitals;

  const card = (title: string, ...kids: HTMLElement[]): HTMLElement => h('div', { className: 'card ro' }, h('h2', null, title), h('dl', null, ...kids));

  return h('div', null,
    card('S 主觀',
      ...row('主訴', s.chief_complaint),
      ...row('NPRS', s.nprs.score !== null && `${s.nprs.score} / 10${s.nprs.site.length ? `(${s.nprs.site.map(regionLabel).join('、')})` : ''}`),
      ...row('Borg RPE', s.borg_rpe !== null && String(s.borg_rpe)),
      ...row('居家運動回報', s.hep_adherence.reported_sessions !== null && `${s.hep_adherence.reported_sessions} 次/週${s.hep_adherence.note ? `;${s.hep_adherence.note}` : ''}`),
      ...row('睡眠/食慾/情緒', [s.flags.sleep && '睡眠不佳', s.flags.appetite && '食慾不佳', s.flags.mood && '情緒低落', s.flags.note].filter(Boolean).join('、')),
    ),
    card('O 客觀',
      ...row('介入', o.interventions.map((i) => `[${CAT[i.category]}] ${ex(i.item_id)} ${dose(i.dose)}`.trim()).join('\n')),
      ...row('測驗', o.measures.map((m) => `${tn(m.test_id)?.name ?? m.test_id}:${m.value} ${m.unit}`).join('\n')),
      ...row('生命徵象', [v.bp_s !== null && v.bp_d !== null && `血壓 ${v.bp_s}/${v.bp_d}`, v.hr !== null && `心率 ${v.hr}`, v.spo2 !== null && `血氧 ${v.spo2}%`].filter(Boolean).join('  ')),
      ...row('觀察', o.observations.map((b) => `${regionLabel(b.region)}:${[...b.quality_tag, b.note].filter(Boolean).join('、')}`).join('\n')),
    ),
    card('A 評估',
      ...row('趨勢', a.trend && TREND[a.trend]),
      ...row('目標進度', a.goal_progress.map((g) => `基準 ${g.baseline ?? '–'} → 目前 ${g.current ?? '–'} → 目標 ${g.target ?? '–'}${g.pct === null ? '' : `(${g.pct}%)`}`).join('\n')),
      ...row('臨床推理', a.clinical_reasoning),
      ...row('風險標記', a.risk_flags.map((r) => RISK[r]).join('、')),
    ),
    card('P 計畫',
      ...row('下次重點', p.next_focus),
      ...row('居家運動處方', p.hep.map((i) => `${ex(i.item_id)} ${dose(i.dose)}`.trim()).join('\n')),
      ...row('頻率調整', p.frequency_change),
      ...row('轉介/照會', p.referral),
    ),
  );
}
