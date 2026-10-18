// 資料匯入精靈(SPEC §七 第一層):上傳 → 自動偵測 → 人工確認 → 預覽 5 筆 → 匯入 → 錯誤清單。
// 畫面與檔案內容皆為個案個資,不寫 log。
import { decodeText, parseCsv, toCsv } from '../shared/csv';
import { analyzeColumns, convertRows, detectHeaderRow, errorRows, TARGET_LABEL, type ColumnInfo, type ConvertResult, type ImportError, type ImportOptions, type TargetField } from '../shared/import';
import type { Track } from '../shared/schema';
import { todayTaipei } from '../shared/time';
import { readXlsx } from '../shared/xlsx';
import { DomainError } from '../shared/validate';
import { h } from './dom';
import type { ViewCtx } from './schedule';

interface Wizard {
  step: 1 | 2 | 3 | 4 | 5 | 6;
  fileName: string;
  rows: string[][];
  headerRow: number;
  columns: ColumnInfo[];
  mapping: TargetField[];
  twoDigitYear: 'roc' | 'ad';
  defaultTrack: Track;
  defaultLtcLevel: number | null;
  referralRequired: boolean;
  result: ConvertResult | null;
  imported: number;
  importErrors: ImportError[];
  progress: number;
}

const STEPS = ['上傳檔案', '自動偵測', '人工確認', '預覽 5 筆', '匯入', '錯誤清單'];
const CONF_LABEL = { high: '高', medium: '中', low: '低(猜測)', none: '—' } as const;
const TARGETS = Object.keys(TARGET_LABEL) as TargetField[];

let w: Wizard | null = null;

function fresh(): Wizard {
  return {
    step: 1, fileName: '', rows: [], headerRow: 0, columns: [], mapping: [], twoDigitYear: 'roc', defaultTrack: 'self_pay', defaultLtcLevel: null,
    referralRequired: true, result: null, imported: 0, importErrors: [], progress: 0,
  };
}

function download(name: string, text: string): void {
  const blob = new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

export async function viewImport(ctx: ViewCtx): Promise<void> {
  ctx.setEditing(true);
  if (!w) w = fresh();
  const wiz = w;
  const msg = h('div');
  const go = (s: Wizard['step']): void => {
    wiz.step = s;
    void viewImport(ctx);
  };
  const today = todayTaipei();

  const stepper = h('ol', { className: 'steps' }, STEPS.map((n, i) => h('li', { className: i + 1 < wiz.step ? 'done' : i + 1 === wiz.step ? 'cur' : '' }, `${i + 1} ${n}`)));
  const body: (Node | null)[] = [stepper, wiz.step > 1 && wiz.step !== 5 ? h('p', null, h('button', { className: 'chip', onclick: () => { w = fresh(); void viewImport(ctx); } }, '↺ 重新開始(換一個檔案)')) : null, msg];

  // ── 1 上傳 ──
  if (wiz.step === 1) {
    const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.xlsx,text/csv' });
    file.addEventListener('change', () => {
      void (async () => {
        msg.replaceChildren();
        const f = file.files?.[0];
        if (!f) return;
        try {
          if (/\.xls$/i.test(f.name)) throw new DomainError('bad', '不支援舊版 .xls,請在 Excel 另存為 .xlsx 或 .csv 後再上傳');
          const rows = /\.xlsx$/i.test(f.name) ? await readXlsx(await f.arrayBuffer()) : parseCsv(decodeText(new Uint8Array(await f.arrayBuffer())).text);
          if (rows.length < 2) throw new DomainError('bad', '檔案沒有資料列(至少需要標題列與一筆資料)');
          wiz.fileName = f.name;
          wiz.rows = rows;
          wiz.headerRow = detectHeaderRow(rows);
          wiz.columns = analyzeColumns(rows, wiz.headerRow, today);
          wiz.mapping = wiz.columns.map((c) => c.target);
          go(2);
        } catch (e) {
          msg.replaceChildren(ctx.errorBox(e instanceof DomainError ? e.message : e instanceof Error ? e.message : '無法讀取這個檔案'));
        }
      })();
    });
    body.push(h('div', { className: 'card' },
      h('h2', null, '上傳既有個案資料'),
      h('p', { className: 'muted' }, '支援 Excel(.xlsx)與 CSV(UTF-8 或 Big5 編碼皆可)。第一列(或前幾列)為欄位名稱,之後每列一位個案。檔案只在你的瀏覽器內處理,不會上傳。'),
      file,
      h('p', { className: 'muted' }, '建議先備份(「備份與還原」)再匯入。匯入後個案資料依法需保存,無法刪除,只能結案。')));
  }

  // ── 2 自動偵測 ──
  if (wiz.step === 2) {
    body.push(h('div', { className: 'card' },
      h('h2', null, `自動偵測結果(${wiz.fileName},共 ${wiz.rows.length - wiz.headerRow - 1} 筆資料)`),
      h('p', { className: 'muted' }, '系統依欄名與內容猜測每一欄對應到哪個欄位。下一步可以逐欄修改。無法辨識的欄位會整段保留到「歷史備註」,不會被丟棄或錯誤拆解。'),
      h('table', { className: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, '檔案欄位'), h('th', null, '範例'), h('th', null, '偵測為'), h('th', null, '信心'))),
        h('tbody', null, ...wiz.columns.map((c) => h('tr', null,
          h('td', null, c.header || `(第 ${c.index + 1} 欄,無標題)`),
          h('td', { className: 'muted' }, c.samples.join(' / ')),
          h('td', null, TARGET_LABEL[c.target], h('div', { className: 'muted' }, c.reason)),
          h('td', null, CONF_LABEL[c.confidence]))))),
      h('div', { className: 'row' }, h('button', { onclick: () => go(1) }, '‹ 重新選檔'), h('button', { className: 'primary', onclick: () => go(3) }, '下一步:人工確認'))));
  }

  // ── 3 人工確認 ──
  if (wiz.step === 3) {
    const header = wiz.rows[wiz.headerRow] ?? [];
    const sels = wiz.columns.map((c) => {
      const s = h('select', null, TARGETS.map((t) => h('option', { value: t }, TARGET_LABEL[t])));
      s.value = wiz.mapping[c.index] ?? 'history';
      s.addEventListener('change', () => { wiz.mapping[c.index] = s.value as TargetField; check(); });
      return s;
    });
    const rowSel = h('select', null, wiz.rows.slice(0, 10).map((r, i) => h('option', { value: String(i) }, `第 ${i + 1} 列:${r.slice(0, 4).join('、')}…`)));
    rowSel.value = String(wiz.headerRow);
    rowSel.addEventListener('change', () => {
      wiz.headerRow = Number(rowSel.value);
      wiz.columns = analyzeColumns(wiz.rows, wiz.headerRow, today);
      wiz.mapping = wiz.columns.map((c) => c.target);
      void viewImport(ctx);
    });
    const yearSel = h('select', null, h('option', { value: 'roc' }, '兩位數年份視為民國(例 65/3/2 → 1976)'), h('option', { value: 'ad' }, '兩位數年份視為西元(例 65/3/2 → 1965)'));
    yearSel.value = wiz.twoDigitYear;
    yearSel.addEventListener('change', () => { wiz.twoDigitYear = yearSel.value as 'roc' | 'ad'; });
    const trackSel = h('select', null, h('option', { value: 'self_pay' }, '自費'), h('option', { value: 'ltc' }, '長照'), h('option', { value: 'both' }, '自費+長照'));
    trackSel.value = wiz.defaultTrack;
    trackSel.addEventListener('change', () => { wiz.defaultTrack = trackSel.value as Track; });
    const levelIn = h('input', { type: 'number', min: '1', max: '8', placeholder: '長照個案缺等級時使用(空白=視為錯誤)', value: wiz.defaultLtcLevel?.toString() ?? '' });
    levelIn.addEventListener('input', () => { wiz.defaultLtcLevel = levelIn.value ? Number(levelIn.value) : null; });
    const refCb = h('input', { type: 'checkbox', checked: wiz.referralRequired });
    refCb.addEventListener('change', () => { wiz.referralRequired = refCb.checked; });

    const next = h('button', { className: 'primary' }, '下一步:預覽 5 筆');
    const warn = h('div');
    const check = (): void => {
      const problems: string[] = [];
      if (!wiz.mapping.includes('name')) problems.push('必須有一欄對應到「姓名」');
      if (!wiz.mapping.includes('birth_date')) problems.push('必須有一欄對應到「生日」');
      for (const t of ['name', 'birth_date', 'gender', 'phone', 'address', 'ltc_level', 'track', 'precautions', 'ec_name', 'ec_relation', 'ec_phone'] as TargetField[]) {
        if (wiz.mapping.filter((x) => x === t).length > 1) problems.push(`「${TARGET_LABEL[t]}」被選了多次,只能選一欄(其餘請改「歷史備註」)`);
      }
      warn.replaceChildren(...problems.map((p) => ctx.errorBox(p)));
      next.disabled = problems.length > 0;
    };
    next.addEventListener('click', () => void (async () => {
      const existing = (await ctx.svc.searchPatients('', true)).map((p) => ({ name: p.name, birth_date: p.birth_date }));
      const opt: ImportOptions = { headerRow: wiz.headerRow, mapping: wiz.mapping, twoDigitYear: wiz.twoDigitYear, defaultTrack: wiz.defaultTrack, defaultLtcLevel: wiz.defaultLtcLevel, referralRequired: wiz.referralRequired, sourceName: wiz.fileName, today };
      wiz.result = convertRows(wiz.rows, opt, existing);
      go(4);
    })());

    body.push(h('div', { className: 'card' },
      h('h2', null, '人工確認欄位對應'),
      h('label', { className: 'f' }, '標題列在哪一列?'), rowSel,
      h('table', { className: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, '檔案欄位'), h('th', null, '範例'), h('th', null, '對應到'))),
        h('tbody', null, ...wiz.columns.map((c, i) => h('tr', null, h('td', null, header[c.index] || `(第 ${c.index + 1} 欄)`), h('td', { className: 'muted' }, c.samples.join(' / ')), h('td', null, sels[i] as HTMLElement))))),
      h('h2', null, '匯入選項'),
      h('label', { className: 'f' }, '日期年份'), yearSel,
      h('label', { className: 'f' }, '檔案中沒有軌別時,個案預設為'), trackSel,
      h('label', { className: 'f' }, '長照個案預設等級'), levelIn,
      h('label', { className: 'f' }, refCb, ' 視為「治療目的」(需診斷證明/照會單);若是健康促進請取消勾選'),
      warn,
      h('div', { className: 'row' }, h('button', { onclick: () => go(2) }, '‹ 上一步'), next)));
    queueMicrotask(check);
  }

  // ── 4 預覽 ──
  if (wiz.step === 4 && wiz.result) {
    const r = wiz.result;
    const dup = r.errors.filter((e) => e.kind !== 'invalid').length;
    const bad = r.errors.length - dup;
    const notes = r.valid.flatMap((v) => v.notes.map((n) => `第 ${v.rowNumber} 筆 ${v.input.name}:${n}`));
    const notesEl: Node | string = notes.length
      ? h('details', null,
          h('summary', null, `轉換註記(${notes.length}):請抽查民國年、電話等轉換是否正確`),
          h('ul', null, ...notes.slice(0, 50).map((n) => h('li', null, n)), notes.length > 50 ? h('li', null, `…還有 ${notes.length - 50} 筆`) : ''))
      : '';
    body.push(h('div', { className: 'card' },
      h('h2', null, '預覽與檢查'),
      h('p', null, `共 ${r.total} 筆:`, h('strong', null, ` 可匯入 ${r.valid.length}`), `、有錯誤 ${bad}、重複/已存在 ${dup}(不會匯入,會列在錯誤清單)`),
      h('h2', null, '前 5 筆轉換結果'),
      ...r.valid.slice(0, 5).map((v) => h('div', { className: 'irow' },
        h('div', { className: 'top' }, h('strong', { className: 'nm' }, v.input.name), h('span', { className: 'badge' }, v.input.track === 'self_pay' ? '自費' : v.input.track === 'ltc' ? '長照' : '自費+長照')),
        h('div', { className: 'muted' }, [`生日 ${v.input.birth_date}`, v.input.gender === 'male' ? '男' : v.input.gender === 'female' ? '女' : null, v.input.phone, v.input.address].filter(Boolean).join(' · ')),
        v.input.precautions ? h('div', { className: 'warn-text' }, `注意事項:${v.input.precautions}`) : '',
        v.input.history_note ? h('pre', { className: 'histnote' }, v.input.history_note) : '')),
      r.valid.length === 0 ? h('p', { className: 'err' }, '沒有任何可匯入的資料,請返回檢查欄位對應。') : '',
      notesEl,
      h('p', { className: 'precautions' }, '⚠ 匯入後個案資料依法需保存十年,無法刪除,只能結案。請確認上方預覽正確再匯入;建議先到「備份與還原」下載備份。'),
      h('div', { className: 'row' }, h('button', { onclick: () => go(3) }, '‹ 返回修改對應'),
        h('button', { className: 'primary', disabled: r.valid.length === 0, onclick: () => { if (confirm(`確定匯入 ${r.valid.length} 位個案?`)) go(5); } }, `匯入 ${r.valid.length} 位個案`))));
  }

  // ── 5 匯入 ──
  if (wiz.step === 5 && wiz.result) {
    const r = wiz.result;
    const bar = h('div', { className: 'bar-meter' }, h('span'));
    const label = h('p', null, '匯入中…');
    body.push(h('div', { className: 'card' }, h('h2', null, '匯入中'), bar, label));
    wiz.imported = 0;
    wiz.importErrors = [];
    void (async () => {
      for (let i = 0; i < r.valid.length; i++) {
        const v = r.valid[i]!;
        try {
          await ctx.svc.createPatient(v.input);
          wiz.imported++;
        } catch (e) {
          wiz.importErrors.push({ rowNumber: v.rowNumber, kind: 'invalid', reason: e instanceof DomainError ? e.message : '寫入失敗', cells: wiz.rows[wiz.headerRow + v.rowNumber] ?? [] });
        }
        if (i % 5 === 0 || i === r.valid.length - 1) {
          (bar.firstElementChild as HTMLElement).style.width = `${Math.round(((i + 1) / r.valid.length) * 100)}%`;
          label.textContent = `已處理 ${i + 1} / ${r.valid.length}`;
          await new Promise((res) => setTimeout(res, 0));
        }
      }
      void ctx.doSync();
      go(6);
    })();
  }

  // ── 6 結果與錯誤清單 ──
  if (wiz.step === 6 && wiz.result) {
    const r = wiz.result;
    const all: ImportError[] = [...r.errors, ...wiz.importErrors].sort((a, b) => a.rowNumber - b.rowNumber);
    const header = wiz.rows[wiz.headerRow] ?? [];
    body.push(h('div', { className: 'card' },
      h('h2', null, '匯入完成'),
      h('p', { className: 'ok' }, `成功匯入 ${wiz.imported} 位個案。`),
      all.length ? h('p', null, `${all.length} 筆未匯入(見下方錯誤清單)。修正原因後可把下載的錯誤清單當成新的匯入檔再匯入一次。`) : h('p', { className: 'muted' }, '沒有任何錯誤。'),
      all.length ? h('table', { className: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, '資料列'), h('th', null, '原因'), h('th', null, '原始內容'))),
        h('tbody', null, ...all.slice(0, 200).map((e) => h('tr', null, h('td', null, String(e.rowNumber)), h('td', null, e.reason), h('td', { className: 'muted' }, e.cells.filter((c) => c.trim()).slice(0, 4).join(' / ')))))) : '',
      all.length > 200 ? h('p', { className: 'muted' }, `只顯示前 200 筆,完整清單請下載。`) : '',
      h('div', { className: 'row' },
        all.length ? h('button', { onclick: () => download(`匯入錯誤清單-${wiz.fileName.replace(/\.[^.]+$/, '')}.csv`, toCsv(errorRows({ ...r, errors: all }, header))) }, '下載錯誤清單(CSV)') : '',
        h('a', { className: 'btn primary', href: '#/', onclick: () => { w = null; } }, '回到個案列表'),
        h('button', { onclick: () => { w = fresh(); void viewImport(ctx); } }, '再匯入一份'))));
  }

  ctx.layout('匯入既有資料', body, wiz.step === 1 ? '#/' : undefined);
  await ctx.refreshStatus();
}

export function resetImport(): void {
  w = null;
}
