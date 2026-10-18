// 極簡 DOM 建構工具:一律以 textContent 寫入文字,避免個案資料被當成 HTML 解析(XSS)。
type Child = Node | string | null | false | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<Omit<HTMLElementTagNameMap[K], 'children' | 'style'>> | null,
  ...kids: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) Object.assign(el, props);
  for (const k of kids.flat()) {
    if (k === null || k === false || k === undefined) continue;
    el.append(typeof k === 'string' ? document.createTextNode(k) : k);
  }
  return el;
}
