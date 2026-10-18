import { describe, expect, it } from 'vitest';
// @ts-expect-error:純 JS 腳本,無型別宣告
import { nodeOk } from '../scripts/start.mjs';

describe('啟動腳本', () => {
  it('Node 版本檢查:22.13 以上才通過', () => {
    expect(nodeOk('22.13.0')).toBe(true);
    expect(nodeOk('22.22.0')).toBe(true);
    expect(nodeOk('24.0.0')).toBe(true);
    expect(nodeOk('22.12.9')).toBe(false);
    expect(nodeOk('20.18.0')).toBe(false);
    expect(nodeOk('18.0.0')).toBe(false);
  });
});
