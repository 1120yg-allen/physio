// 最小化 .xlsx 讀取(不依賴任何套件):解 ZIP(DecompressionStream)→ 讀第一個工作表。
// 支援共用字串、內嵌字串、數字、布林,並依儲存格樣式把日期序號轉成 YYYY-MM-DD。
// 不支援:加密檔、巨集、公式計算結果以外的內容。

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  localOffset: number;
}

const u16 = (d: DataView, o: number): number => d.getUint16(o, true);
const u32 = (d: DataView, o: number): number => d.getUint32(o, true);

function readEntries(buf: ArrayBuffer): ZipEntry[] {
  const d = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (u32(d, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 .xlsx 檔案');
  const count = u16(d, eocd + 10);
  let p = u32(d, eocd + 16);
  const out: ZipEntry[] = [];
  const td = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (u32(d, p) !== 0x02014b50) throw new Error('.xlsx 檔案結構損毀');
    const nameLen = u16(d, p + 28);
    const extraLen = u16(d, p + 30);
    const commentLen = u16(d, p + 32);
    out.push({ name: td.decode(new Uint8Array(buf, p + 46, nameLen)), method: u16(d, p + 10), compSize: u32(d, p + 20), localOffset: u32(d, p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readEntry(buf: ArrayBuffer, e: ZipEntry): Promise<string> {
  const d = new DataView(buf);
  const start = e.localOffset + 30 + u16(d, e.localOffset + 26) + u16(d, e.localOffset + 28);
  const data = new Uint8Array(buf, start, e.compSize);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error('.xlsx 使用了不支援的壓縮方式');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

const unescapeXml = (s: string): string =>
  s.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** 取出所有 <t>…</t> 文字(含多段 rich text)並串接 */
function textOf(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1] as string)).join('');
}

const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function dateStyles(stylesXml: string | null): Set<number> {
  const set = new Set<number>();
  if (!stylesXml) return set;
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\s+[^>]*?numFmtId="(\d+)"[^>]*?formatCode="([^"]*)"/g)) custom.set(Number(m[1]), unescapeXml(m[2] as string));
  const cellXfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  let i = 0;
  for (const m of cellXfs.matchAll(/<xf\s[^>]*?numFmtId="(\d+)"/g)) {
    const id = Number(m[1]);
    const code = custom.get(id);
    const isDate = BUILTIN_DATE_FMT.has(id) || (code !== undefined && /[ymd]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')));
    if (isDate) set.add(i);
    i++;
  }
  return set;
}

/** Excel 日期序號 → YYYY-MM-DD(1900 日期系統,含 1900 閏年 bug 的修正) */
export function excelSerialToDate(serial: number): string {
  const days = Math.floor(serial);
  return new Date(Date.UTC(1899, 11, 30) + days * 86_400_000).toISOString().slice(0, 10);
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? '') n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 讀取第一個工作表為二維字串陣列 */
export async function readXlsx(buf: ArrayBuffer): Promise<string[][]> {
  const entries = readEntries(buf);
  const get = async (name: string): Promise<string | null> => {
    const e = entries.find((x) => x.name === name);
    return e ? readEntry(buf, e) : null;
  };
  const workbook = await get('xl/workbook.xml');
  if (!workbook) throw new Error('不是有效的 .xlsx 檔案(缺少 workbook)');
  const rels = (await get('xl/_rels/workbook.xml.rels')) ?? '';
  const firstRid = /<sheet\s[^>]*?r:id="([^"]+)"/.exec(workbook)?.[1];
  const target = firstRid ? new RegExp(`<Relationship\\s[^>]*?Id="${firstRid}"[^>]*?Target="([^"]+)"|<Relationship\\s[^>]*?Target="([^"]+)"[^>]*?Id="${firstRid}"`).exec(rels) : null;
  let sheetPath = (target?.[1] ?? target?.[2]) ?? 'worksheets/sheet1.xml';
  sheetPath = sheetPath.startsWith('/') ? sheetPath.slice(1) : `xl/${sheetPath}`;
  const sheet = await get(sheetPath);
  if (!sheet) throw new Error('找不到工作表內容');

  const shared: string[] = [];
  const ss = await get('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1] as string));
  const dates = dateStyles(await get('xl/styles.xml'));

  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\s[^>]*?r="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(rm[1]) - 1;
    const cells: string[] = [];
    for (const cm of (rm[2] ?? '').matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] as string;
      const body = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? '-1');
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      let val = '';
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = textOf(body);
      else if (type === 'str') val = unescapeXml(v);
      else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== '') {
        const n = Number(v);
        val = dates.has(style) && Number.isFinite(n) ? excelSerialToDate(n) : Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : String(n)) : v;
      }
      cells[colIndex(ref)] = val;
    }
    for (let i = 0; i < cells.length; i++) cells[i] ??= '';
    while (rows.length < r) rows.push([]);
    rows[r] = cells;
  }
  return rows.filter((row) => row.some((c) => (c ?? '').trim() !== ''));
}
