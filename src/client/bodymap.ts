// 人形圖點選部位(快速模式)。部位 id:`l_`/`r_` 為「個案的」左/右;無前綴為身體中線。
// 正面圖畫面左側是個案的右側;背面圖畫面左側是個案的左側。
const NS = 'http://www.w3.org/2000/svg';

const PART_LABEL: Record<string, string> = {
  head: '頭', neck: '頸', chest: '胸', abdomen: '腹', upper_back: '上背', lower_back: '下背',
  shoulder: '肩', elbow: '肘', wrist: '腕/手', hip: '髖', thigh: '大腿', knee: '膝', shank: '小腿', ankle: '踝/足',
};

/** 部位 id → 中文名稱(例:l_knee → 左膝) */
export function regionLabel(id: string): string {
  const m = /^([lr])_(.+)$/.exec(id);
  if (!m) return PART_LABEL[id] ?? id;
  return `${m[1] === 'l' ? '左' : '右'}${PART_LABEL[m[2] as string] ?? m[2]}`;
}

/** 所有可選部位 id(供下拉選單) */
export function allRegions(): string[] {
  const mid = ['head', 'neck', 'chest', 'abdomen', 'upper_back', 'lower_back'];
  const side = ['shoulder', 'elbow', 'wrist', 'hip', 'thigh', 'knee', 'shank', 'ankle'];
  return [...mid, ...side.flatMap((p) => [`l_${p}`, `r_${p}`])];
}

interface Shape {
  part: string;
  /** 畫面左側(true)或右側(false);null 為中線 */
  viewerLeft: boolean | null;
  kind: 'ellipse' | 'rect';
  a: number; b: number; c: number; d: number; // ellipse: cx,cy,rx,ry;rect: x,y,w,h
}

const mid = (part: string, kind: Shape['kind'], a: number, b: number, c: number, d: number): Shape => ({ part, viewerLeft: null, kind, a, b, c, d });
// 側邊部位:以畫面左側座標定義,右側鏡射
const side = (part: string, cx: number, cy: number, rx: number, ry: number): Shape[] => [
  { part, viewerLeft: true, kind: 'ellipse', a: cx, b: cy, c: rx, d: ry },
  { part, viewerLeft: false, kind: 'ellipse', a: 200 - cx, b: cy, c: rx, d: ry },
];

const COMMON: Shape[] = [
  mid('head', 'ellipse', 100, 20, 15, 17),
  mid('neck', 'rect', 91, 38, 18, 12),
  ...side('shoulder', 68, 62, 15, 11),
  ...side('elbow', 50, 108, 10, 10),
  ...side('wrist', 40, 152, 11, 14),
  ...side('hip', 84, 140, 14, 11),
  ...side('thigh', 86, 182, 13, 24),
  ...side('knee', 86, 224, 11, 10),
  ...side('shank', 86, 258, 10, 20),
  ...side('ankle', 86, 296, 12, 9),
];
const FRONT: Shape[] = [...COMMON, mid('chest', 'rect', 78, 52, 44, 36), mid('abdomen', 'rect', 80, 90, 40, 38)];
const BACK: Shape[] = [...COMMON, mid('upper_back', 'rect', 78, 52, 44, 36), mid('lower_back', 'rect', 80, 90, 40, 38)];

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function figure(shapes: Shape[], front: boolean, selected: Set<string>, onToggle: (id: string) => void, readOnly: boolean): SVGSVGElement {
  const svg = el('svg', { viewBox: '0 0 200 312', class: 'bodymap', role: 'group', 'aria-label': front ? '人形圖(正面)' : '人形圖(背面)' });
  // 軀幹與四肢底圖(不可點)
  svg.append(el('path', { d: 'M78 52 Q100 46 122 52 L128 128 L72 128 Z', class: 'bm-body' }));
  for (const left of [true, false]) {
    const x = (v: number): number => (left ? v : 200 - v);
    svg.append(el('path', { d: `M${x(68)} 58 L${x(50)} 108 L${x(40)} 152`, class: 'bm-limb' }));
    svg.append(el('path', { d: `M${x(86)} 140 L${x(86)} 224 L${x(86)} 296`, class: 'bm-limb bm-leg' }));
  }
  const cap = el('text', { x: '100', y: '308', class: 'bm-cap', 'text-anchor': 'middle' });
  cap.textContent = front ? '正面' : '背面';
  svg.append(cap);

  for (const s of shapes) {
    const id =
      s.viewerLeft === null
        ? s.part
        : `${(front ? s.viewerLeft : !s.viewerLeft) ? 'r' : 'l'}_${s.part}`;
    const on = selected.has(id);
    const attrs: Record<string, string> = { class: `bm-region${on ? ' on' : ''}` };
    const node =
      s.kind === 'ellipse'
        ? el('ellipse', { ...attrs, cx: String(s.a), cy: String(s.b), rx: String(s.c), ry: String(s.d) })
        : el('rect', { ...attrs, x: String(s.a), y: String(s.b), width: String(s.c), height: String(s.d), rx: '8' });
    node.setAttribute('aria-label', regionLabel(id));
    if (!readOnly) {
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
      node.setAttribute('aria-pressed', String(on));
      node.addEventListener('click', () => onToggle(id));
      node.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
          e.preventDefault();
          onToggle(id);
        }
      });
    }
    const t = el('title', {});
    t.textContent = regionLabel(id);
    node.append(t);
    svg.append(node);
  }
  return svg;
}

/** 人形圖(正/背面)。selected 變動時呼叫 onChange 並自行重繪。 */
export function bodyMap(selected: string[], onChange: (sites: string[]) => void, readOnly = false): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'bodymap-wrap';
  const draw = (): void => {
    const set = new Set(selected);
    const toggle = (id: string): void => {
      if (set.has(id)) set.delete(id);
      else set.add(id);
      selected = [...set];
      onChange(selected);
      draw();
    };
    const figs = document.createElement('div');
    figs.className = 'bodymap-figs';
    figs.append(figure(FRONT, true, set, toggle, readOnly), figure(BACK, false, set, toggle, readOnly));
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const id of selected) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip on';
      b.textContent = `${regionLabel(id)} ✕`;
      b.disabled = readOnly;
      b.addEventListener('click', () => toggle(id));
      chips.append(b);
    }
    if (selected.length === 0) {
      const p = document.createElement('span');
      p.className = 'muted';
      p.textContent = readOnly ? '未標記部位' : '點選人形圖標記疼痛/治療部位';
      chips.append(p);
    }
    wrap.replaceChildren(figs, chips);
  };
  draw();
  return wrap;
}
