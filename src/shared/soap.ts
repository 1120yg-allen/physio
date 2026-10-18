// SPEC §2.3 SOAP 內容結構(存於 soap_notes 的四個 JSON 欄位)與相關純函式。
// 注意:SPEC 原文的 `npre` 為 NPRS 之筆誤,本實作欄位名為 `nprs`。
// 內容皆為特種個資,不得寫入 log。
import type { Encounter, SoapNote } from './schema';

export type InterventionCategory = 'manual' | 'exercise' | 'functional' | 'education';
export type Trend = 'improving' | 'maintaining' | 'declining';
export type RiskFlag = 'fall' | 'cardiac' | 'skin' | 'swallowing' | 'other';

export interface Dose {
  sets: number | null;
  reps: number | null;
  resistance: string | null;
  duration: string | null;
}

export interface Intervention {
  category: InterventionCategory;
  item_id: string;
  dose: Dose;
}

export interface Measure {
  test_id: string;
  value: number;
  unit: string;
  measured_at: string;
}

export interface Observation {
  region: string;
  quality_tag: string[];
  note: string;
}

export interface HepItem {
  item_id: string;
  dose: Dose;
  video_ref: string | null;
}

export interface Subjective {
  chief_complaint: string;
  nprs: { score: number | null; site: string[] };
  borg_rpe: number | null;
  hep_adherence: { prescribed: string[]; reported_sessions: number | null; note: string };
  flags: { sleep: boolean; appetite: boolean; mood: boolean; note: string };
}

export interface Objective {
  vitals: { bp_s: number | null; bp_d: number | null; hr: number | null; spo2: number | null };
  measures: Measure[];
  observations: Observation[];
  interventions: Intervention[];
}

export interface GoalProgress {
  goal_id: string;
  baseline: number | null;
  current: number | null;
  target: number | null;
  pct: number | null;
}

export interface Assessment {
  goal_progress: GoalProgress[];
  clinical_reasoning: string;
  trend: Trend | null;
  /** 治療師自行勾選;系統不做自動判讀(CLAUDE.md 禁止事項) */
  risk_flags: RiskFlag[];
}

export interface Plan {
  next_focus: string;
  hep: HepItem[];
  frequency_change: string;
  referral: string;
}

export interface SoapContent {
  subjective: Subjective;
  objective: Objective;
  assessment: Assessment;
  plan: Plan;
}

export const emptyDose = (): Dose => ({ sets: null, reps: null, resistance: null, duration: null });

export function emptySoap(): SoapContent {
  return {
    subjective: {
      chief_complaint: '',
      nprs: { score: null, site: [] },
      borg_rpe: null,
      hep_adherence: { prescribed: [], reported_sessions: null, note: '' },
      flags: { sleep: false, appetite: false, mood: false, note: '' },
    },
    objective: {
      vitals: { bp_s: null, bp_d: null, hr: null, spo2: null },
      measures: [],
      observations: [],
      interventions: [],
    },
    assessment: { goal_progress: [], clinical_reasoning: '', trend: null, risk_flags: [] },
    plan: { next_focus: '', hep: [], frequency_change: '', referral: '' },
  };
}

function obj(v: Record<string, unknown> | null): Record<string, unknown> {
  return v ?? {};
}

/** 將儲存的四個 JSON 欄位還原為完整結構(缺漏欄位以預設值補齊,相容舊資料) */
export function parseSoap(note: Pick<SoapNote, 'subjective' | 'objective' | 'assessment' | 'plan'> | null): SoapContent {
  const base = emptySoap();
  if (!note) return base;
  const s = obj(note.subjective) as Partial<Subjective>;
  const o = obj(note.objective) as Partial<Objective>;
  const a = obj(note.assessment) as Partial<Assessment>;
  const p = obj(note.plan) as Partial<Plan>;
  return {
    subjective: {
      ...base.subjective,
      ...s,
      nprs: { ...base.subjective.nprs, ...(s.nprs ?? {}) },
      hep_adherence: { ...base.subjective.hep_adherence, ...(s.hep_adherence ?? {}) },
      flags: { ...base.subjective.flags, ...(s.flags ?? {}) },
    },
    objective: { ...base.objective, ...o, vitals: { ...base.objective.vitals, ...(o.vitals ?? {}) } },
    assessment: { ...base.assessment, ...a },
    plan: { ...base.plan, ...p },
  };
}

/** 轉為可存入 soap_notes 的四個欄位 */
export function serializeSoap(c: SoapContent): Pick<SoapNote, 'subjective' | 'objective' | 'assessment' | 'plan'> {
  return {
    subjective: c.subjective as unknown as Record<string, unknown>,
    objective: c.objective as unknown as Record<string, unknown>,
    assessment: c.assessment as unknown as Record<string, unknown>,
    plan: c.plan as unknown as Record<string, unknown>,
  };
}

/**
 * 快速模式「複製上次治療」:把上次的介入清單、觀察與 HEP 處方帶入新紀錄,讓「寫紀錄」變成「校對紀錄」。
 * 刻意不複製:測驗數值、生命徵象、NPRS、主訴(這些是本次新測量,舊值不可冒充新值)。
 */
export function prefillFromPrevious(prev: SoapContent | null): SoapContent {
  const next = emptySoap();
  if (!prev) return next;
  next.objective.interventions = prev.objective.interventions.map((i) => ({ ...i, dose: { ...i.dose } }));
  next.objective.observations = prev.objective.observations.map((o) => ({ ...o, quality_tag: [...o.quality_tag] }));
  next.plan.hep = prev.plan.hep.map((h) => ({ ...h, dose: { ...h.dose } }));
  next.plan.next_focus = prev.plan.next_focus;
  next.subjective.hep_adherence.prescribed = prev.plan.hep.map((h) => h.item_id);
  return next;
}

/** 簽章前提:S 有主訴,O 至少有一項介入/測驗/觀察。其餘欄位不強制,以免擋住日常回診。 */
export function soapMissing(c: SoapContent): string[] {
  const missing: string[] = [];
  if (c.subjective.chief_complaint.trim() === '') missing.push('主訴');
  const o = c.objective;
  if (o.interventions.length + o.measures.length + o.observations.length === 0) missing.push('介入、測驗或觀察(至少一項)');
  return missing;
}

/** 從同一個案的服務紀錄中找出「上一次」自費紀錄(排除自己、取最新版本、日期最近者) */
export function pickPreviousEncounter(all: Encounter[], excludeId: string | null): Encounter | null {
  const superseded = new Set(all.map((e) => e.supersedes_id).filter((x): x is string => x !== null));
  const cand = all
    .filter((e) => e.track === 'self_pay' && e.id !== excludeId && !superseded.has(e.id))
    .sort((a, b) => b.service_date.localeCompare(a.service_date) || b.start_time.localeCompare(a.start_time));
  return cand[0] ?? null;
}
