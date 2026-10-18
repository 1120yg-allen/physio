// 趨勢與目標進度:從共用資料層取出同一測驗跨次數的數值(C5:資料只輸入一次,長照/自費不斷裂)。
import type { Repo } from './repo';
import type { Goal } from './schema';
import { parseSoap, type Measure } from './soap';

export interface TrendPoint {
  date: string;
  value: number;
  encounter_id: string;
  measured_at: string;
}

/**
 * 某個案、某測驗的歷次數值(依測量時間排序)。
 * 只取每條版本鏈的最新版本,避免舊版與更正版重複計入。
 * 目前的資料來源為自費 SOAP 的 objective.measures;長照紀錄於 P3 加入後,
 * 在此處合併即可,圖表與目標進度不需改動。
 */
export async function trendFor(repo: Repo, patientId: string, testId: string): Promise<TrendPoint[]> {
  const encs = await repo.listEncountersByPatient(patientId);
  const superseded = new Set(encs.map((e) => e.supersedes_id).filter((x): x is string => x !== null));
  const points: TrendPoint[] = [];
  for (const e of encs) {
    if (superseded.has(e.id)) continue;
    const note = await repo.getByEncounter('soap_notes', e.id);
    if (!note) continue;
    for (const m of parseSoap(note).objective.measures as Measure[]) {
      if (m.test_id === testId && Number.isFinite(m.value)) {
        points.push({ date: e.service_date, value: m.value, encounter_id: e.id, measured_at: m.measured_at });
      }
    }
  }
  return points.sort((a, b) => Date.parse(a.measured_at) - Date.parse(b.measured_at) || a.date.localeCompare(b.date));
}

/** 該個案有紀錄過的測驗 id(依最近一次測量排序,新到舊) */
export async function testsUsedBy(repo: Repo, patientId: string): Promise<string[]> {
  const encs = await repo.listEncountersByPatient(patientId);
  const superseded = new Set(encs.map((e) => e.supersedes_id).filter((x): x is string => x !== null));
  const last = new Map<string, number>();
  for (const e of encs) {
    if (superseded.has(e.id)) continue;
    const note = await repo.getByEncounter('soap_notes', e.id);
    if (!note) continue;
    for (const m of parseSoap(note).objective.measures) {
      last.set(m.test_id, Math.max(last.get(m.test_id) ?? 0, Date.parse(m.measured_at) || 0));
    }
  }
  return [...last.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** 目標達成百分比:(目前 − 基準) ÷ (目標 − 基準),可超過 100 或為負;越低越好的目標同樣適用。 */
export function goalPct(baseline: number | null, current: number | null, target: number | null): number | null {
  if (baseline === null || current === null || target === null || target === baseline) return null;
  return Math.round(((current - baseline) / (target - baseline)) * 100);
}

/** 以關聯測驗的最新數值計算目標進度 */
export async function goalProgressFor(repo: Repo, goal: Goal): Promise<{ current: number | null; pct: number | null }> {
  if (!goal.test_id) return { current: null, pct: null };
  const pts = await trendFor(repo, goal.patient_id, goal.test_id);
  const current = pts.length ? (pts[pts.length - 1] as TrendPoint).value : null;
  return { current, pct: goalPct(goal.baseline_value, current, goal.target_value) };
}
