// 時間工具:一律輸出 ISO 8601 並帶 Asia/Taipei(+08:00)時區。

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 將時間點格式化為 `YYYY-MM-DDTHH:mm:ss.sss+08:00` */
export function toTaipeiIso(d: Date): string {
  const shifted = new Date(d.getTime() + TAIPEI_OFFSET_MS);
  return shifted.toISOString().replace('Z', '+08:00');
}

export function nowTaipei(): string {
  return toTaipeiIso(new Date());
}

/** 今日日期 `YYYY-MM-DD`(台北時區) */
export function todayTaipei(): string {
  return nowTaipei().slice(0, 10);
}

/** 現在時刻 `HH:mm`(台北時區) */
export function timeNowTaipei(): string {
  return nowTaipei().slice(11, 16);
}

/** 比較兩個含時區的 ISO 時間;a 早於 b 回傳負數 */
export function compareIso(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}
