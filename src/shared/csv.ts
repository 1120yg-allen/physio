// CSV 解析與編碼偵測(P5 匯入)。處理的檔案含個案個資,不得寫入 log。

/** 解碼 CSV 位元組:先嚴格 UTF-8,失敗(台灣 Excel 另存 CSV 常為 Big5)改用 Big5;去除 BOM。 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'big5' } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text: text.replace(/^﻿/, ''), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('big5').decode(bytes).replace(/^﻿/, ''), encoding: 'big5' };
  }
}

/** 偵測分隔符號:逗號、Tab、分號、直線(取前幾行出現最多且各行一致者) */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 10);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', '\t', ';', '|']) {
    const counts = lines.map((l) => (l.match(new RegExp(d === '|' ? '\\|' : d, 'g')) ?? []).length);
    const min = Math.min(...counts);
    const score = counts.length === 0 ? 0 : min * 1000 + counts.reduce((a, b) => a + b, 0);
    if (min > 0 && score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** RFC 4180 風格解析:支援引號、引號內的逗號與換行、"" 跳脫、CRLF。空白列略過。 */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"' && cell === '') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

/** 產生含 BOM 的 CSV 文字(Excel 才會正確辨識 UTF-8 中文) */
export function toCsv(rows: (string | number)[][]): string {
  const cell = (v: string | number): string => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
