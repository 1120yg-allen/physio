// 家屬版白話摘要(SPEC §3.4)——規則式轉譯,不使用任何 LLM(CLAUDE.md C1)。
//
// 原則:
// - 無術語:測驗、量表、動作名稱一律換成白話;自由文字經術語表替換,並標出仍殘留的疑似術語供治療師確認
// - 數據圖像化:同一測驗的歷次數值畫成長條圖(LINE Flex,不需公網圖片)
// - 永遠以「接下來怎麼做」收尾
// - 不放:臨床推理、風險標記、生命徵象、常模/切點比較(不做判讀,也避免嚇到家屬)
// 內容為個案健康資料,不得寫入 log。
import type { Exercise, Goal, TestDef } from './schema';
import type { Dose, SoapContent } from './soap';

export interface TrendPt {
  date: string;
  value: number;
}

export interface FamilyChart {
  title: string;
  unit: string;
  higherBetter: boolean | null;
  points: { label: string; value: number }[];
}

export interface FamilySummary {
  greeting: string;
  did: string[];
  progress: string[];
  chart: FamilyChart | null;
  home: string[];
  /** 「接下來怎麼做」——必定非空,且為最後一段 */
  next: string[];
}

export interface FamilyInput {
  patientName: string;
  serviceDate: string;
  content: SoapContent;
  prev: SoapContent | null;
  tests: TestDef[];
  exercises: Exercise[];
  goals: Goal[];
  /** 各測驗歷次數值(含本次,依時間排序) */
  trends: Map<string, TrendPt[]>;
  nextAppointment: { date: string; time: string } | null;
}

// ───────────── 術語替換 ─────────────

const TERMS: [RegExp, string][] = [
  [/髖屈曲攣縮/g, '髖部緊繃影響站直'],
  [/攣縮/g, '肌肉緊繃'],
  [/關節活動度|ROM/g, '關節能動的範圍'],
  [/肌力/g, '力氣'],
  [/本體感覺/g, '身體位置感'],
  [/步態/g, '走路姿勢'],
  [/阻力訓練/g, '用重量或彈力帶的訓練'],
  [/核心(肌群)?/g, '腹背穩定肌群'],
  [/代償/g, '用別的部位出力補償'],
  [/NPRS/gi, '疼痛分數'],
  [/HEP/gi, '居家運動'],
  [/TUG/gi, '起立走路測試'],
  [/BBS/gi, '平衡測試'],
  [/SPPB/gi, '體能綜合測試'],
  [/跌倒風險/g, '跌倒的可能'],
  [/水腫/g, '腫脹'],
  [/疼痛閾值/g, '能忍受的疼痛程度'],
  [/鬆動術/g, '放鬆活動'],
  [/軟組織/g, '肌肉與筋膜'],
  [/神經肌肉/g, '神經與肌肉'],
];

/** 把常見專業術語換成白話 */
export function plainify(text: string): string {
  return TERMS.reduce((t, [re, to]) => t.replace(re, to), text);
}

/** 換完後仍疑似專業術語的片段(連續 2 個以上英文大寫縮寫),供治療師確認 */
export function jargonLeft(text: string): string[] {
  return [...new Set(text.match(/\b[A-Z]{2,}[A-Za-z0-9]*\b/g) ?? [])];
}

// ───────────── 測驗與動作的白話名稱 ─────────────

interface FamilyTest {
  label: string;
  higherBetter: boolean | null;
  unit?: string;
  hide?: boolean;
}

const FAMILY_TEST: Record<string, FamilyTest> = {
  'test-tug': { label: '起立走路測試', higherBetter: false },
  'test-30scs': { label: '30 秒坐站測試', higherBetter: true },
  'test-bbs': { label: '平衡測試', higherBetter: true },
  'test-gait-4m': { label: '走路速度', higherBetter: true, unit: '公尺/秒' },
  'test-gait-10m': { label: '走路速度', higherBetter: true, unit: '公尺/秒' },
  'test-sppb': { label: '體能綜合測試', higherBetter: true },
  'test-grip': { label: '握力', higherBetter: true },
  'test-sls': { label: '單腳站立時間', higherBetter: true },
  'test-mmse': { label: '', higherBetter: null, hide: true }, // 認知測驗不放家屬摘要
};

function familyTest(t: TestDef | undefined, id: string): FamilyTest | null {
  const f = FAMILY_TEST[id];
  if (f?.hide) return null;
  if (f) return f;
  return { label: plainify(t?.name ?? id), higherBetter: null };
}

const PLAIN_EX: Record<string, string> = {
  'ex-mob-joint': '關節放鬆活動', 'ex-mob-soft': '肌肉放鬆按摩', 'ex-stretch': '伸展放鬆',
  'ex-sit-stand': '坐下站起練習', 'ex-heel-raise': '踮腳尖練習', 'ex-bridge': '躺著抬屁股練習',
  'ex-slr': '躺著抬直腿練習', 'ex-clam': '側躺開腿練習', 'ex-mini-squat': '小幅度蹲下練習',
  'ex-wall-push': '靠牆推牆練習', 'ex-band-row': '拉彈力帶練習', 'ex-balance-tandem': '一腳在前一腳在後站穩練習',
  'ex-sls': '單腳站立練習', 'ex-gait': '走路練習', 'ex-transfer': '起身移位練習', 'ex-stairs': '上下樓梯練習',
  'ex-edu-posture': '日常姿勢與活動方式的說明', 'ex-edu-fall': '居家環境安全的說明',
};

export function plainExerciseName(ex: Exercise | undefined, id: string): string {
  return PLAIN_EX[id] ?? plainify(ex?.name ?? id);
}

export function plainDose(d: Dose): string {
  const parts: string[] = [];
  if (d.sets !== null && d.reps !== null) parts.push(`做 ${d.sets} 回,每回 ${d.reps} 下`);
  else if (d.sets !== null) parts.push(`做 ${d.sets} 回`);
  else if (d.reps !== null) parts.push(`每次 ${d.reps} 下`);
  if (d.duration) parts.push(`每次約 ${plainify(d.duration)}`);
  if (d.resistance) parts.push(`負重/阻力:${plainify(d.resistance)}`);
  return parts.join(',');
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
function mdw(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(週${WEEKDAY[d.getUTCDay()]})`;
}

const fmt = (v: number): string => String(Math.round(v * 100) / 100);

// ───────────── 建立摘要 ─────────────

export function buildFamilySummary(i: FamilyInput): FamilySummary {
  const c = i.content;
  const exOf = (id: string): Exercise | undefined => i.exercises.find((e) => e.id === id);
  const testOf = (id: string): TestDef | undefined => i.tests.find((t) => t.id === id);

  // 今天做了什麼
  const did = c.objective.interventions.map((iv) => {
    const name = plainExerciseName(exOf(iv.item_id), iv.item_id);
    const dose = plainDose(iv.dose);
    return iv.category === 'manual' || iv.category === 'education' ? name : dose ? `${name}(${dose})` : name;
  });
  if (did.length === 0) did.push('今天進行了身體狀況的檢查與討論');

  // 進步在哪
  const progress: string[] = [];
  const now = c.subjective.nprs.score;
  const before = i.prev?.subjective.nprs.score ?? null;
  if (now !== null) {
    if (before === null) progress.push(`今天的疼痛程度是 ${now} 分(0 分最不痛、10 分最痛)`);
    else if (now < before) progress.push(`疼痛程度從上次的 ${before} 分降到 ${now} 分,有減輕`);
    else if (now === before) progress.push(`疼痛程度維持在 ${now} 分`);
    else progress.push(`疼痛程度這次是 ${now} 分(上次 ${before} 分),我們會留意並調整治療內容`);
  }

  let chart: FamilyChart | null = null;
  for (const m of c.objective.measures) {
    const ft = familyTest(testOf(m.test_id), m.test_id);
    if (!ft) continue;
    const unit = ft.unit ?? m.unit;
    const pts = i.trends.get(m.test_id) ?? [];
    const prevPt = pts.length >= 2 ? (pts[pts.length - 2] as TrendPt) : null;
    if (!prevPt) {
      progress.push(`${ft.label}:今天測得 ${fmt(m.value)} ${unit}`);
    } else if (m.value === prevPt.value) {
      progress.push(`${ft.label}:${fmt(m.value)} ${unit}(和上次一樣)`);
    } else {
      const better = ft.higherBetter === null ? null : ft.higherBetter ? m.value > prevPt.value : m.value < prevPt.value;
      const tail = better === null ? '' : better ? ',進步了' : ',比上次略退,我們會持續觀察';
      progress.push(`${ft.label}:從 ${fmt(prevPt.value)} 變成 ${fmt(m.value)} ${unit}${tail}`);
    }
    // 圖表取第一個有 2 筆以上資料的測驗
    if (!chart && pts.length >= 2) {
      chart = { title: `${ft.label}(${unit})`, unit, higherBetter: ft.higherBetter, points: pts.slice(-5).map((p) => ({ label: p.date.slice(5).replace('-', '/'), value: p.value })) };
    }
  }

  for (const g of c.assessment.goal_progress) {
    const goal: Goal | undefined = i.goals.find((x) => x.id === g.goal_id);
    if (!goal || g.pct === null || g.pct < 0) continue;
    progress.push(g.pct >= 100 ? `目標「${plainify(goal.description)}」已經達成` : `目標「${plainify(goal.description)}」已完成約 ${g.pct}%`);
  }
  if (c.assessment.trend === 'improving') progress.push('整體恢復狀況持續進步');
  else if (c.assessment.trend === 'maintaining') progress.push('整體狀況穩定');
  else if (c.assessment.trend === 'declining') progress.push('近期進展比較慢,我們會調整訓練內容');
  if (progress.length === 0) progress.push('今天先確認目前的狀況,作為之後比較的起點');

  // 回家要做
  const home = c.plan.hep.map((h) => {
    const name = plainExerciseName(exOf(h.item_id), h.item_id);
    const dose = plainDose(h.dose);
    return dose ? `${name}:${dose}` : name;
  });

  // 接下來怎麼做(必定非空、最後一段)
  const next: string[] = [];
  if (home.length > 0) next.push('請照上面的居家運動,在家持續練習;練習時如果疼痛變厲害、頭暈或不舒服,請先停下來並聯絡我們');
  if (c.plan.next_focus.trim()) next.push(`下次治療重點:${plainify(c.plan.next_focus.trim())}`);
  if (c.plan.frequency_change.trim()) next.push(`治療頻率:${plainify(c.plan.frequency_change.trim())}`);
  if (i.nextAppointment) next.push(`下次預計 ${mdw(i.nextAppointment.date)} ${i.nextAppointment.time} 到府`);
  if (next.length === 0) next.push('請依治療師的建議,維持平常的活動;有任何不舒服請隨時聯絡我們');

  return { greeting: `${i.patientName}今天(${mdw(i.serviceDate)})的治療摘要`, did, progress, chart, home, next };
}

/** 摘要純文字版(可由治療師在傳送前編輯) */
export function summaryToText(s: FamilySummary, clinicName: string): string {
  const bullets = (xs: string[]): string => xs.map((x) => `・${x}`).join('\n');
  const parts = [`【${clinicName}】${s.greeting}`, `今天做了什麼\n${bullets(s.did)}`, `進步在哪\n${bullets(s.progress)}`];
  if (s.home.length) parts.push(`回家要做的運動\n${bullets(s.home)}`);
  parts.push(`接下來怎麼做\n${bullets(s.next)}`);
  return parts.join('\n\n');
}
