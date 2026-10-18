// 測驗數值趨勢圖(單一序列折線):2px 線、≥8px 資料點(2px 底色描邊)、
// 無圖例(標題即序列名)、懸停/聚焦顯示數值、附表格檢視。
import type { TestDef } from '../shared/schema';
import type { TrendPoint } from '../shared/trend';
import { h } from './dom';

const NS = 'http://www.w3.org/2000/svg';
const W = 640;
const H = 240;
const M = { l: 44, r: 28, t: 18, b: 34 };

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

function niceRange(min: number, max: number): { lo: number; hi: number; ticks: number[] } {
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.1, 1);
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? raw;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { lo, hi, ticks };
}

const fmt = (v: number): string => String(Math.round(v * 100) / 100);

export function trendChart(test: TestDef, points: TrendPoint[], cutoff?: { value: number; label: string }): HTMLElement {
  const vals = points.map((p) => p.value).concat(cutoff ? [cutoff.value] : []);
  const { lo, hi, ticks } = niceRange(Math.min(...vals), Math.max(...vals));
  const t0 = Date.parse(points[0]?.date ?? '');
  const t1 = Date.parse(points[points.length - 1]?.date ?? '');
  // 依日期等比例排列;全部在同一天(例如治療前後重測)時改為等距,避免資料點疊在一起
  const sameDay = t1 === t0;
  const x = (p: TrendPoint): number => {
    const w = W - M.l - M.r;
    if (points.length === 1) return M.l + w / 2;
    if (sameDay) return M.l + 20 + (points.indexOf(p) / (points.length - 1)) * (w - 40);
    return M.l + ((Date.parse(p.date) - t0) / (t1 - t0)) * w;
  };
  const y = (v: number): number => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'trend-svg', role: 'img', 'aria-label': `${test.name}趨勢,共 ${points.length} 筆` });
  for (const tk of ticks) {
    svg.append(s('line', { x1: M.l, x2: W - M.r, y1: y(tk), y2: y(tk), class: 'tc-grid' }));
    svg.append(s('text', { x: M.l - 8, y: y(tk) + 4, class: 'tc-axis', 'text-anchor': 'end' }, fmt(tk)));
  }
  if (cutoff) {
    svg.append(s('line', { x1: M.l, x2: W - M.r, y1: y(cutoff.value), y2: y(cutoff.value), class: 'tc-ref' }));
    svg.append(s('text', { x: W - M.r, y: y(cutoff.value) - 5, class: 'tc-axis', 'text-anchor': 'end' }, `${cutoff.label} ${cutoff.value}`));
  }
  // X 軸日期:首、尾(與中間,點數少時全部);相同日期的標籤只畫一次
  const labelIdx = points.length <= 5 ? points.map((_, i) => i) : [0, Math.floor(points.length / 2), points.length - 1];
  const seen = new Set<string>();
  for (const i of labelIdx) {
    const p = points[i] as TrendPoint;
    if (seen.has(p.date)) continue;
    seen.add(p.date);
    const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
    svg.append(s('text', { x: x(p), y: H - 10, class: 'tc-axis', 'text-anchor': points.length === 1 ? 'middle' : anchor }, p.date.slice(5)));
  }
  if (points.length > 1) {
    svg.append(s('polyline', { points: points.map((p) => `${x(p)},${y(p.value)}`).join(' '), class: 'tc-line' }));
  }

  const tip = h('div', { className: 'tc-tip', hidden: true, role: 'status' });
  const wrap = h('div', { className: 'trend' });
  const show = (p: TrendPoint): void => {
    tip.hidden = false;
    tip.textContent = `${p.date}:${fmt(p.value)} ${test.unit}`;
    const rect = svg.getBoundingClientRect();
    tip.style.left = `${(x(p) / W) * rect.width}px`;
    tip.style.top = `${(y(p.value) / H) * rect.height - 8}px`;
  };
  points.forEach((p, i) => {
    const g = s('g', { class: 'tc-pt', tabindex: 0, role: 'img', 'aria-label': `${p.date} ${fmt(p.value)} ${test.unit}` });
    g.append(s('circle', { cx: x(p), cy: y(p.value), r: 18, class: 'tc-hit' })); // 加大感應範圍
    g.append(s('circle', { cx: x(p), cy: y(p.value), r: 5, class: 'tc-dot' }));
    g.addEventListener('pointerenter', () => show(p));
    g.addEventListener('focus', () => show(p));
    g.addEventListener('pointerleave', () => (tip.hidden = true));
    g.addEventListener('blur', () => (tip.hidden = true));
    svg.append(g);
    if (i === points.length - 1) {
      svg.append(s('text', { x: x(p), y: y(p.value) - 12, class: 'tc-last', 'text-anchor': points.length > 1 ? 'end' : 'middle' }, `${fmt(p.value)} ${test.unit}`));
    }
  });

  const first = points[0] as TrendPoint;
  const last = points[points.length - 1] as TrendPoint;
  const delta = last.value - first.value;
  wrap.append(
    h('div', { className: 'trend-head' },
      h('strong', null, `${test.name}(${test.unit})`),
      points.length > 1 ? h('span', { className: 'muted' }, `${fmt(first.value)} → ${fmt(last.value)}(${delta > 0 ? '+' : ''}${fmt(delta)})`) : h('span', { className: 'muted' }, '僅 1 筆'),
    ),
    h('div', { className: 'trend-plot' }, svg, tip),
    h('details', { className: 'trend-table' },
      h('summary', null, '表格檢視'),
      h('table', null,
        h('thead', null, h('tr', null, h('th', null, '日期'), h('th', null, `數值(${test.unit})`))),
        h('tbody', null, points.map((p) => h('tr', null, h('td', null, p.date), h('td', null, fmt(p.value))))),
      ),
    ),
  );
  return wrap;
}
