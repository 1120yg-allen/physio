// 排程相關純函式:日期運算(台北時區)、時間重疊、同日地址排序提示(SPEC §5)。
import type { Appointment } from './schema';
import { toTaipeiIso } from './time';

const DAY_MS = 86_400_000;

/** 日期字串加減天數(YYYY-MM-DD) */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** 該日所在週的星期一 */
export function weekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0=日
  return addDays(date, -((dow + 6) % 7));
}

export function weekDates(date: string): string[] {
  const s = weekStart(date);
  return Array.from({ length: 7 }, (_, i) => addDays(s, i));
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
export function weekdayLabel(date: string): string {
  return `週${WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]}`;
}

/** ISO 時間 → 台北日期 YYYY-MM-DD */
export function dateOf(iso: string): string {
  return toTaipeiIso(new Date(Date.parse(iso))).slice(0, 10);
}

/** ISO 時間 → 台北時刻 HH:mm */
export function timeOf(iso: string): string {
  return toTaipeiIso(new Date(Date.parse(iso))).slice(11, 16);
}

/** 日期 + 時刻 → ISO 8601(+08:00) */
export function makeIso(date: string, time: string): string {
  return `${date}T${time}:00+08:00`;
}

/** 同日行程依開始時間排序,不含已取消者(除非 includeCancelled) */
export function appointmentsOn(list: Appointment[], date: string, includeCancelled = false): Appointment[] {
  return list
    .filter((a) => dateOf(a.start_at) === date && (includeCancelled || a.status !== 'cancelled'))
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
}

/** 找出時間重疊的行程對(已取消者不計) */
export function overlappingIds(list: Appointment[]): Set<string> {
  const active = list.filter((a) => a.status !== 'cancelled').sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  const out = new Set<string>();
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i] as Appointment;
      const b = active[j] as Appointment;
      if (Date.parse(b.start_at) >= Date.parse(a.end_at)) break;
      out.add(a.id);
      out.add(b.id);
    }
  }
  return out;
}

// ───────────── 地址排序提示 ─────────────

export interface ParsedAddress {
  city: string;
  district: string;
  road: string;
  /** 門牌號(數字),無法解析為 0 */
  number: number;
  raw: string;
}

const CITY_RE = /^(.{2,3}[縣市])/;
const DISTRICT_RE = /^(.{1,3}?[區鄉鎮市])/;
const ROAD_RE = /^(.+?(?:大道|路|街))(?:([一二三四五六七八九十]+)段)?/;

const CN_DIGIT: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function sectionNo(s: string | undefined): number {
  if (!s) return 0;
  if (s === '十') return 10;
  if (s.startsWith('十')) return 10 + (CN_DIGIT[s.slice(1)] ?? 0);
  if (s.endsWith('十')) return (CN_DIGIT[s.slice(0, -1)] ?? 0) * 10;
  return CN_DIGIT[s] ?? 0;
}

/** 解析台灣地址;解析不出的層級為空字串(排序時排在最後) */
export function parseAddress(raw: string): ParsedAddress {
  let rest = raw.trim().replace(/^\d{3,6}/, '').replace(/臺/g, '台').replace(/\s+/g, '');
  const city = CITY_RE.exec(rest)?.[1] ?? '';
  rest = rest.slice(city.length);
  const district = DISTRICT_RE.exec(rest)?.[1] ?? '';
  rest = rest.slice(district.length);
  const rm = ROAD_RE.exec(rest);
  const road = rm ? `${rm[1]}${rm[2] ? String(sectionNo(rm[2])).padStart(2, '0') : ''}` : '';
  rest = rm ? rest.slice(rm[0].length) : rest;
  const num = /(\d+)[號之]?/.exec(rest.replace(/^.*?巷\d*弄?/, '').replace(/^\d+巷/, ''));
  return { city, district, road, number: num ? Number(num[1]) : 0, raw };
}

const cmpStr = (a: string, b: string): number => (a === '' && b !== '' ? 1 : b === '' && a !== '' ? -1 : a.localeCompare(b, 'zh-Hant'));

/**
 * 同日多個到宅行程的地址排序建議:縣市 → 區 → 路 → 門牌,讓相近地點排在一起。
 * 僅供參考,**不是路線規劃**(不計距離、不考慮時間窗與交通)。
 * 回傳依建議順序排列的行程;沒有地址的行程排最後。
 */
export function addressOrder(list: Appointment[]): Appointment[] {
  return list
    .filter((a) => a.status !== 'cancelled')
    .map((a) => ({ a, p: parseAddress(a.location_text ?? '') }))
    .sort(
      (x, y) =>
        cmpStr(x.p.city, y.p.city) || cmpStr(x.p.district, y.p.district) || cmpStr(x.p.road, y.p.road) || x.p.number - y.p.number ||
        Date.parse(x.a.start_at) - Date.parse(y.a.start_at),
    )
    .map((x) => x.a);
}

/** 建議順序是否與時間順序不同(不同時才值得提示) */
export function orderDiffersFromTime(list: Appointment[]): boolean {
  const byTime = list.filter((a) => a.status !== 'cancelled').sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  const byAddr = addressOrder(list);
  return byTime.some((a, i) => a.id !== byAddr[i]?.id);
}
