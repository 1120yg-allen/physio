import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeText, detectDelimiter, parseCsv, toCsv } from '../src/shared/csv';
import {
  analyzeColumns, convertRows, detectHeaderRow, matchHeader, normalizePhone, parseDate, parseGender, parseTrack, type DateOptions, type ImportOptions,
} from '../src/shared/import';
import { excelSerialToDate, readXlsx } from '../src/shared/xlsx';
import { DataService } from '../src/shared/service';
import { SqliteRepo } from '../src/server/db';
import { fakeClock, seqIds } from './helpers';

const TODAY = '2026-10-18';
const D: DateOptions = { twoDigitYear: 'roc', today: TODAY };

describe('CSV', () => {
  it('引號、逗號、換行、雙引號跳脫、CRLF、空白列', () => {
    const rows = parseCsv('姓名,備註\r\n"王,大明","第一行\n第二行"\r\n\r\n李小華,"他說""好"""\r\n');
    expect(rows).toEqual([['姓名', '備註'], ['王,大明', '第一行\n第二行'], ['李小華', '他說"好"']]);
  });
  it('分隔符號偵測:逗號、Tab、分號', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(parseCsv('姓名\t生日\n王大明\t1950-01-01')).toEqual([['姓名', '生日'], ['王大明', '1950-01-01']]);
  });
  it('編碼:UTF-8(含 BOM)與 Big5 都能正確解碼', () => {
    const utf8 = new TextEncoder().encode('﻿姓名,生日\n王大明,1950-01-01');
    expect(decodeText(utf8)).toEqual({ text: '姓名,生日\n王大明,1950-01-01', encoding: 'utf-8' });
    // Big5:姓名,生日\n王大明(以 iconv 預先轉好的位元組)
    const big5 = new Uint8Array([0xa9, 0x6d, 0xa6, 0x57, 0x2c, 0xa5, 0xcd, 0xa4, 0xe9, 0x0a, 0xa4, 0xfd, 0xa4, 0x6a, 0xa9, 0xfa]);
    const d = decodeText(big5);
    expect(d.encoding).toBe('big5');
    expect(d.text).toContain('姓名');
    expect(d.text).toContain('王大明');
  });
  it('toCsv 跳脫', () => {
    expect(toCsv([['a', 'b,c'], [1, 'x"y']])).toBe('a,"b,c"\r\n1,"x""y"');
  });
});

describe('xlsx 讀取', () => {
  /** 以最小 ZIP 寫出器建立測試用 xlsx(可選擇壓縮),驗證解析器兩種路徑 */
  function zip(files: Record<string, string>, compress: boolean): ArrayBuffer {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    const u16 = (n: number) => new Uint8Array([n & 255, (n >> 8) & 255]);
    const u32 = (n: number) => new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
    const cat = (...xs: Uint8Array[]) => { const o = new Uint8Array(xs.reduce((a, x) => a + x.length, 0)); let p = 0; for (const x of xs) { o.set(x, p); p += x.length; } return o; };
    for (const [name, content] of Object.entries(files)) {
      const raw = enc.encode(content);
      const data = compress ? new Uint8Array(deflateRawSync(raw)) : raw;
      const nameB = enc.encode(name);
      const method = compress ? 8 : 0;
      const local = cat(u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0), u32(data.length), u32(raw.length), u16(nameB.length), u16(0), nameB, data);
      central.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0), u32(data.length), u32(raw.length), u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB));
      parts.push(local);
      offset += local.length;
    }
    const cd = cat(...central);
    const end = cat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cd.length), u32(offset), u16(0));
    const all = cat(...parts, cd, end);
    return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
  }

  const files = {
    'xl/workbook.xml': '<workbook xmlns:r="x"><sheets><sheet name="個案" sheetId="1" r:id="rId1"/><sheet name="第二頁" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>姓名</t></si><si><t>生日</t></si><si><t>電話</t></si><si><r><t>王</t></r><r><t>大明</t></r></si><si><t xml:space="preserve">備註 &amp; 說明</t></si></sst>',
    'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="E1" t="s"><v>4</v></c></row>
      <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>18264</v></c><c r="C2"><v>912345678</v></c><c r="E2" t="inlineStr"><is><t>內嵌</t></is></c></row>
      <row r="4"><c r="A4" t="str"><v>李小華</v></c><c r="B4" s="2"><v>28000</v></c><c r="C4" t="b"><v>1</v></c></row>
    </sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>不該讀到</t></is></c></row></sheetData></worksheet>',
  };

  for (const compress of [false, true]) {
    it(`解析第一個工作表(${compress ? 'deflate 壓縮' : '未壓縮'}):共用字串、rich text、日期樣式、空白格補齊、略過空白列`, async () => {
      const rows = await readXlsx(zip(files, compress));
      expect(rows).toEqual([
        ['姓名', '生日', '電話', '', '備註 & 說明'],
        ['王大明', '1950-01-01', '912345678', '', '內嵌'],
        ['李小華', '1976-08-28', 'TRUE'],
      ]);
    });
  }

  it('Excel 序號轉日期、無效檔案報錯', async () => {
    expect(excelSerialToDate(18264)).toBe('1950-01-01');
    expect(excelSerialToDate(1)).toBe('1899-12-31');
    await expect(readXlsx(new TextEncoder().encode('not a zip at all, definitely').buffer as ArrayBuffer)).rejects.toThrow('不是有效的 .xlsx');
  });
});

describe('日期解析(民國、序號、模糊格式)', () => {
  const ok = (raw: string, opt: DateOptions = D) => { const r = parseDate(raw, opt); return r && 'iso' in r ? r.iso : r; };
  it('西元各種寫法', () => {
    for (const s of ['1950-01-02', '1950/1/2', '1950.01.02', '1950年1月2日', '19500102', '１９５０－０１－０２'.replace(/－/g, '-')]) expect(ok(s), s).toBe('1950-01-02');
  });
  it('民國年:65/3/2、065-03-02、650302、0650302、民國三位數年份', () => {
    for (const s of ['65/3/2', '065-03-02', '650302', '0650302', '65年3月2日']) expect(ok(s), s).toBe('1976-03-02');
    expect(ok('105/12/31')).toBe('2016-12-31');
  });
  it('兩位數年份可選視為西元', () => {
    expect(ok('76/3/2', { twoDigitYear: 'ad', today: TODAY })).toBe('1976-03-02');
    expect(ok('760302', { twoDigitYear: 'ad', today: TODAY })).toBe('1976-03-02');
    expect(ok('76/3/2')).toBe('1987-03-02');
  });
  it('Excel 日期序號;含轉換註記', () => {
    const r = parseDate('18264', D);
    expect(r).toMatchObject({ iso: '1950-01-01' });
    expect((r as { note: string }).note).toContain('Excel 日期序號');
  });
  it('不確定就不猜:月日順序不明、不存在的日期、無法辨識', () => {
    expect(parseDate('3/2/1976', D)).toMatchObject({ error: expect.stringContaining('不明確') });
    expect(parseDate('1950-02-30', D)).toMatchObject({ error: expect.stringContaining('不是有效日期') });
    expect(parseDate('65/13/1', D)).toMatchObject({ error: expect.stringContaining('不是有效日期') });
    expect(parseDate('昨天', D)).toMatchObject({ error: expect.stringContaining('無法辨識') });
    expect(parseDate('', D)).toBeNull();
    expect(parseDate('  ', D)).toBeNull();
  });
});

describe('值轉換', () => {
  it('性別、軌別', () => {
    expect([parseGender('男'), parseGender('F'), parseGender('先生'), parseGender(''), parseGender('不詳')]).toEqual(['male', 'female', 'male', null, 'unknown']);
    expect([parseTrack('自費'), parseTrack('長照'), parseTrack('自費+長照'), parseTrack('CMS'), parseTrack('其他')]).toEqual(['self_pay', 'ltc', 'both', 'ltc', null]);
  });
  it('電話:補前導 0、去空白、科學記號、保留市話', () => {
    expect(normalizePhone('912345678')).toMatchObject({ phone: '0912345678', note: expect.stringContaining('前導 0') });
    expect(normalizePhone('0912 345 678').phone).toBe('0912345678');
    expect(normalizePhone('9.12345678E+8')).toMatchObject({ phone: '0912345678' });
    expect(normalizePhone('02-2345-6789').phone).toBe('02-2345-6789');
    expect(normalizePhone('')).toEqual({ phone: null, note: null });
  });
});

describe('欄位自動對應(5.2)', () => {
  const m = (h: string) => matchHeader(h)?.field ?? null;
  it('常見欄名:姓名/生日/電話/地址/初診日/診斷/備註/性別…(含中英文、符號、全形)', () => {
    const cases: [string, string | null][] = [
      ['姓名', 'name'], ['病人姓名', 'name'], ['Name', 'name'], ['個案姓名 *', 'name'],
      ['生日', 'birth_date'], ['出生日期', 'birth_date'], ['出生年月日', 'birth_date'], ['DOB', 'birth_date'], ['Birthday', 'birth_date'],
      ['電話', 'phone'], ['手機', 'phone'], ['聯絡電話', 'phone'], ['Mobile', 'phone'],
      ['地址', 'address'], ['居住地址', 'address'], ['到宅地址', 'address'],
      ['初診日', 'first_visit'], ['初診日期', 'first_visit'], ['診斷', 'diagnosis'], ['診斷名稱', 'diagnosis'], ['主診斷', 'diagnosis'],
      ['備註', 'note'], ['性別', 'gender'], ['禁忌症', 'precautions'], ['注意事項', 'precautions'], ['長照等級', 'ltc_level'], ['軌別', 'track'],
      ['緊急聯絡人', 'ec_name'], ['關係', 'ec_relation'], ['家屬電話', 'ec_phone'], ['緊急聯絡人電話', 'ec_phone'],
      ['完全不相關的欄', null], ['', null],
    ];
    for (const [h, f] of cases) expect(m(h), h).toBe(f);
  });
  it('較長/較精確的關鍵字優先:「聯絡人電話」是緊急聯絡人電話,不是本人電話', () => {
    expect(m('聯絡人電話')).toBe('ec_phone');
    expect(m('聯絡電話')).toBe('phone');
  });

  const sample = [
    ['No.', '姓名', '出生日期', '性別', '手機', '住址', '初診日', '主診斷', '聯絡人電話', '備註', '血型'],
    ['1', '王大明', '39/5/20', '男', '912345678', '台北市大安區甲路1號', '110/3/1', '右膝退化', '0922333444', '怕冷', 'A'],
    ['2', '李美玲', '45/1/1', '女', '988777666', '新北市板橋區乙路2號', '109/12/5', '中風後', '0933444555', '', 'B'],
  ];
  it('analyzeColumns:各欄對應、信心、未知欄保留原文', () => {
    const cols = analyzeColumns(sample, 0, TODAY);
    const by = (h: string) => cols.find((c) => c.header === h)!;
    expect(by('姓名')).toMatchObject({ target: 'name', confidence: 'high' });
    expect(by('出生日期')).toMatchObject({ target: 'birth_date', confidence: 'high' });
    expect(by('聯絡人電話').target).toBe('ec_phone');
    expect(by('初診日').target).toBe('first_visit');
    expect(by('血型')).toMatchObject({ target: 'history', confidence: 'none' });
    expect(by('No.')).toMatchObject({ target: 'history' });
    expect(by('姓名').samples).toEqual(['王大明', '李美玲']);
  });
  it('欄名認不得時用內容探測(信心低):電話、性別、生日', () => {
    const rows = [['A', 'B', 'C'], ['王', '0912345678', '男'], ['李', '0988777666', '女'], ['陳', '0933444555', '男']];
    const cols = analyzeColumns(rows, 0, TODAY);
    expect(cols[1]).toMatchObject({ target: 'phone', confidence: 'low' });
    expect(cols[2]).toMatchObject({ target: 'gender', confidence: 'low' });
    const withBirth = analyzeColumns([['x'], ['1950-03-02'], ['1960-05-06'], ['1971-07-08']], 0, TODAY);
    expect(withBirth[0]).toMatchObject({ target: 'birth_date', confidence: 'low' });
    expect(analyzeColumns([['x'], ['2026-10-01'], ['2026-10-02'], ['2026-10-03']], 0, TODAY)[0]?.target).toBe('history'); // 今年的日期不像生日
  });
  it('同一目標有兩欄時只保留較準的一欄,另一欄進歷史備註', () => {
    const cols = analyzeColumns([['姓名', '病人姓名'], ['王', '王大明']], 0, TODAY);
    expect(cols.map((c) => c.target)).toEqual(['history', 'name']); // 「病人姓名」較長
    expect(cols[0]!.reason).toContain('同一欄位');
  });
  it('標題列偵測:跳過前面的標題文字/空白列', () => {
    expect(detectHeaderRow([['某某診所個案名冊'], [''], ['姓名', '生日', '電話'], ['王', '1950-01-01', '0912']])).toBe(2);
    expect(detectHeaderRow([['王', '1950-01-01'], ['李', '1960-01-01']])).toBe(0);
  });
});

describe('轉換、驗證、錯誤清單(5.1 / 5.3)', () => {
  const rows = [
    ['No.', '姓名', '出生日期', '性別', '手機', '住址', '初診日', '主診斷', '備註', '血型'],
    ['1', '王大明', '39/5/20', '男', '912345678', '台北市大安區甲路1號', '110/3/1', '右膝退化', '怕冷', 'A'],
    ['2', '李美玲', '1945-01-01', '女', '0988777666', '', '', '', '', ''],
    ['3', '', '1950-01-01', '男', '', '', '', '', '', ''],
    ['4', '陳無生日', '', '女', '', '', '', '', '', ''],
    ['5', '壞日期', '3/2/1976', '男', '', '', '', '', '', ''],
    ['6', '王大明', '39/5/20', '男', '', '', '', '', '', ''],
    ['7', '已存在者', '1960-06-06', '女', '', '', '', '', '', ''],
    ['8', '未來人', '2099-01-01', '男', '', '', '', '', '', ''],
    ['9', '不詳性別', '1955-05-05', '不詳', '', '', '', '', '', ''],
  ];
  const mapping = analyzeColumns(rows, 0, TODAY).map((c) => c.target);
  const opt = (over: Partial<ImportOptions> = {}): ImportOptions => ({ headerRow: 0, mapping, twoDigitYear: 'roc', defaultTrack: 'self_pay', defaultLtcLevel: null, referralRequired: true, sourceName: 'old.xlsx', today: TODAY, ...over });
  const existing = [{ name: '已存在者', birth_date: '1960-06-06' }];

  it('合格列轉成結構化資料;民國年、前導 0 轉換並記錄註記', () => {
    const res = convertRows(rows, opt(), existing);
    const a = res.valid.find((v) => v.rowNumber === 1)!;
    expect(a.input).toMatchObject({ name: '王大明', birth_date: '1950-05-20', gender: 'male', phone: '0912345678', address: '台北市大安區甲路1號', track: 'self_pay', referral_required: true });
    expect(a.notes.join('|')).toContain('民國 39 年 → 西元 1950');
    expect(a.notes.join('|')).toContain('手機缺少前導 0');
  });

  it('歷史備註保留原文:初診日、診斷、備註與無法辨識的欄位(血型、No.)', () => {
    const a = convertRows(rows, opt(), existing).valid.find((v) => v.rowNumber === 1)!;
    expect(a.input.history_note).toBe('【匯入自 old.xlsx,2026-10-18】\n初診日:110/3/1\n診斷:右膝退化\n備註:怕冷\nNo.:1\n血型:A');
    // 沒有可保留內容時不產生空備註
    const b = convertRows(rows, opt(), existing).valid.find((v) => v.rowNumber === 2)!;
    expect(b.input.history_note).toBe('【匯入自 old.xlsx,2026-10-18】\nNo.:2');
  });

  it('無法辨識的性別不丟棄,改存歷史備註', () => {
    const c = convertRows(rows, opt(), existing).valid.find((v) => v.rowNumber === 9)!;
    expect(c.input.gender).toBeNull();
    expect(c.input.history_note).toContain('性別:不詳');
  });

  it('錯誤清單:缺姓名、缺生日、日期不明確、未來生日、檔案內重複、系統已存在,各有明確原因', () => {
    const res = convertRows(rows, opt(), existing);
    expect(res.total).toBe(9);
    const reason = (n: number) => res.errors.find((e) => e.rowNumber === n)?.reason;
    expect(reason(3)).toBe('缺少姓名');
    expect(reason(4)).toBe('缺少生日');
    expect(reason(5)).toContain('日期格式不明確');
    expect(reason(6)).toContain('檔案內有姓名與生日完全相同');
    expect(reason(7)).toBe('系統內已有同姓名同生日的個案');
    expect(reason(8)).toContain('未來日期');
    expect(res.errors.map((e) => e.kind)).toEqual(['invalid', 'invalid', 'invalid', 'duplicate_in_file', 'exists', 'invalid']);
    expect(res.valid.map((v) => v.rowNumber)).toEqual([1, 2, 9]);
    expect(res.valid.length + res.errors.length).toBe(res.total); // 每一列都有去處,沒有遺漏
  });

  it('兩位數年份視為西元的選項會改變結果', () => {
    expect(convertRows(rows, opt({ twoDigitYear: 'ad' }), existing).valid.find((v) => v.rowNumber === 1)!.input.birth_date).toBe('1939-05-20');
  });

  it('長照個案缺等級:預設為錯誤;提供預設等級則採用並註記', () => {
    const r = [['姓名', '生日', '軌別'], ['甲', '1940-01-01', '長照'], ['乙', '1941-01-01', '自費+長照']];
    const m2 = analyzeColumns(r, 0, TODAY).map((c) => c.target);
    const o = (d: number | null): ImportOptions => ({ ...opt(), mapping: m2, defaultLtcLevel: d });
    expect(convertRows(r, o(null), []).errors.map((e) => e.reason)).toEqual(['長照個案缺少長照需要等級', '長照個案缺少長照需要等級']);
    const ok = convertRows(r, o(4), []);
    expect(ok.valid.map((v) => [v.input.track, v.input.ltc_level])).toEqual([['ltc', 4], ['both', 4]]);
    expect(ok.valid[0]!.notes.join('')).toContain('預設值 4');
  });

  it('緊急聯絡人整理成一組;姓名有空白會正規化;全部欄位忽略時仍可匯入姓名+生日', () => {
    const r = [['姓名', '生日', '緊急聯絡人', '關係', '家屬電話'], ['  王   大明 ', '1950-01-01', '王小美', '女兒', '922333444']];
    const mp = analyzeColumns(r, 0, TODAY).map((c) => c.target);
    const v = convertRows(r, { ...opt(), mapping: mp }, []).valid[0]!;
    expect(v.input.name).toBe('王 大明');
    expect(v.input.emergency_contact).toEqual({ name: '王小美', relation: '女兒', phone: '0922333444' });
    const minimal = convertRows([['n', 'b'], ['甲', '1950-01-01']], { ...opt(), mapping: ['name', 'birth_date'] }, []);
    expect(minimal.valid).toHaveLength(1);
  });

  it('實際匯入資料庫:通過規則驗證,可再查詢;重複執行不會產生重複個案', async () => {
    const repo = new SqliteRepo(':memory:');
    const svc = new DataService({ repo, newId: seqIds(), now: fakeClock('2026-10-18T09:00:00+08:00') });
    const res = convertRows(rows, opt(), []);
    for (const v of res.valid) await svc.createPatient(v.input);
    const all = await svc.searchPatients('', true);
    expect(all.map((p) => p.name).sort()).toEqual(['不詳性別', '已存在者', '李美玲', '王大明'].sort()); // existing 傳空陣列,所以「已存在者」這列也會匯入
    const wang = all.find((p) => p.name === '王大明')!;
    expect(wang.history_note).toContain('血型:A');
    // 第二次:以現有個案作為 existing,全部合格列都被判為已存在
    const again = convertRows(rows, opt(), all.map((p) => ({ name: p.name, birth_date: p.birth_date })));
    expect(again.valid).toEqual([]);
    expect(again.errors.filter((e) => e.kind === 'exists').length).toBeGreaterThanOrEqual(3);
  });
});
