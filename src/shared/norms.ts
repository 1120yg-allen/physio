// 標準化測驗的「參考值」比對。僅呈現文獻參考數字供治療師對照,
// 不做「異常/風險」判定(避免被認定為醫療器材軟體,CLAUDE.md 禁止事項)。
import type { Gender, Patient, TestDef } from './schema';

export interface NormBand {
  sex?: 'male' | 'female';
  age_min: number;
  age_max: number;
  value: number;
  label: string;
}

export interface NormData {
  source: string;
  note?: string;
  bands: NormBand[];
}

export interface CutoffData {
  value: number;
  /** 數值越高越好,或越低越好 */
  direction: 'higher_better' | 'lower_better';
  label: string;
  source: string;
}

export function ageOn(birthDate: string, onDate: string): number {
  const b = new Date(`${birthDate}T00:00:00Z`);
  const d = new Date(`${onDate}T00:00:00Z`);
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  const m = d.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && d.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

function sexOf(g: Gender | null): 'male' | 'female' | null {
  return g === 'male' || g === 'female' ? g : null;
}

/** 找出符合個案年齡(與性別)的參考區間 */
export function findBand(test: TestDef, patient: Pick<Patient, 'birth_date' | 'gender'>, onDate: string): NormBand | null {
  const norms = test.norms as unknown as NormData | null;
  if (!norms?.bands?.length) return null;
  const age = ageOn(patient.birth_date, onDate);
  const sex = sexOf(patient.gender);
  return (
    norms.bands.find((b) => age >= b.age_min && age <= b.age_max && (b.sex === undefined || b.sex === sex)) ?? null
  );
}

export interface ReferenceInfo {
  /** 例:「同年齡層參考:9.2 秒(Bohannon 2006)」 */
  normLine: string | null;
  /** 例:「文獻切點 13.5 秒(數值越低越好)」;只陳述數字,不下判斷 */
  cutoffLine: string | null;
  /** 本次數值相對於切點的中性描述:「高於切點」「低於切點」「等於切點」 */
  relation: string | null;
}

export function referenceFor(test: TestDef, patient: Pick<Patient, 'birth_date' | 'gender'>, onDate: string, value: number | null): ReferenceInfo {
  const norms = test.norms as unknown as NormData | null;
  const cut = test.cutoffs as unknown as CutoffData | null;
  const band = findBand(test, patient, onDate);
  const normLine = band && norms ? `同年齡層參考:${band.value} ${test.unit}(${band.label};${norms.source})` : null;
  let cutoffLine: string | null = null;
  let relation: string | null = null;
  if (cut) {
    cutoffLine = `${cut.label} ${cut.value} ${test.unit}(${cut.direction === 'lower_better' ? '數值越低越好' : '數值越高越好'};${cut.source})`;
    if (value !== null) relation = value > cut.value ? '高於切點' : value < cut.value ? '低於切點' : '等於切點';
  }
  return { normLine, cutoffLine, relation };
}
