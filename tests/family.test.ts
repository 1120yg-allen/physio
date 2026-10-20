import { describe, expect, it } from 'vitest';
import { buildFamilySummary, jargonLeft, plainify, summaryToText, type FamilyInput } from '../src/shared/family';
import { arriveMessages, chartFlex, departMessages, hepMessages, reminderMessages } from '../src/shared/linemsg';
import { SEED_EXERCISES, SEED_TESTS } from '../src/shared/seed';
import { emptySoap, type SoapContent } from '../src/shared/soap';
import type { Goal } from '../src/shared/schema';

const BANNED = ['SOAP', 'NPRS', 'TUG', 'BBS', 'SPPB', 'HEP', 'Borg', 'ROM', '攣縮', '髖屈曲', '本體感覺', '步態', '代償'];

function content(over?: (c: SoapContent) => void): SoapContent {
  const c = emptySoap();
  c.subjective.chief_complaint = '右膝爬樓梯痛';
  c.subjective.nprs = { score: 3, site: ['r_knee'] };
  c.objective.interventions = [
    { category: 'manual', item_id: 'ex-mob-joint', dose: { sets: null, reps: null, resistance: null, duration: null } },
    { category: 'exercise', item_id: 'ex-sit-stand', dose: { sets: 3, reps: 10, resistance: '2kg', duration: null } },
  ];
  c.objective.measures = [{ test_id: 'test-tug', value: 14, unit: '秒', measured_at: '2026-10-18T10:00:00.000+08:00' }];
  c.objective.vitals.bp_s = 150;
  c.assessment.clinical_reasoning = '髖屈曲攣縮導致步態代償,跌倒風險升高';
  c.assessment.risk_flags = ['fall', 'cardiac'];
  c.assessment.trend = 'improving';
  c.plan.hep = [{ item_id: 'ex-bridge', dose: { sets: 3, reps: 10, resistance: null, duration: null }, video_ref: 'https://example.com/bridge.mp4' }];
  c.plan.next_focus = '加強本體感覺與步態訓練,HEP 持續';
  over?.(c);
  return c;
}

function input(over?: Partial<FamilyInput>): FamilyInput {
  const prev = emptySoap();
  prev.subjective.nprs = { score: 6, site: [] };
  return {
    patientName: '王大明',
    serviceDate: '2026-10-18',
    content: content(),
    prev,
    tests: SEED_TESTS,
    exercises: SEED_EXERCISES,
    goals: [],
    trends: new Map([['test-tug', [{ date: '2026-10-04', value: 18 }, { date: '2026-10-11', value: 16 }, { date: '2026-10-18', value: 14 }]]]),
    nextAppointment: { date: '2026-10-25', time: '14:00' },
    ...over,
  };
}

describe('家屬版白話摘要(4.4)', () => {
  it('不含專業術語,也不含臨床推理、風險標記、生命徵象', () => {
    const text = summaryToText(buildFamilySummary(input()), '居家物理治療');
    for (const w of BANNED) expect(text, w).not.toContain(w);
    expect(text).not.toContain('跌倒風險');
    expect(text).not.toContain('150');
    expect(text).not.toContain('心臟');
    expect(jargonLeft(text)).toEqual([]);
  });

  it('內容:做了什麼、進步在哪(疼痛/測驗/整體)、回家要做', () => {
    const s = buildFamilySummary(input());
    expect(s.did).toEqual(['關節放鬆活動', '坐下站起練習(做 3 回,每回 10 下,負重/阻力:2kg)']);
    expect(s.progress).toContain('疼痛程度從上次的 6 分降到 3 分,有減輕');
    expect(s.progress).toContain('起立走路測試:從 16 變成 14 秒,進步了');
    expect(s.progress).toContain('整體恢復狀況持續進步');
    expect(s.home).toEqual(['躺著抬屁股練習:做 3 回,每回 10 下']);
  });

  it('永遠以「接下來怎麼做」收尾,且有內容', () => {
    const t = summaryToText(buildFamilySummary(input()), '診所');
    const last = t.split('\n\n').pop()!;
    expect(last.startsWith('接下來怎麼做')).toBe(true);
    expect(last).toContain('下次預計 10/25(週日) 14:00 到府');
    expect(last).toContain('下次治療重點:加強身體位置感與走路姿勢訓練,居家運動 持續');
    // 什麼都沒填時仍有收尾
    const bare = buildFamilySummary(input({ content: emptySoap(), prev: null, nextAppointment: null, trends: new Map() }));
    expect(bare.next.length).toBeGreaterThan(0);
    expect(summaryToText(bare, '診所').split('\n\n').pop()).toContain('接下來怎麼做');
  });

  it('退步時語氣溫和、不下判斷;持平與首次測量有各自說法', () => {
    const worse = buildFamilySummary(input({ trends: new Map([['test-tug', [{ date: '2026-10-11', value: 12 }, { date: '2026-10-18', value: 14 }]]]) }));
    expect(worse.progress.find((p) => p.startsWith('起立走路測試'))).toContain('比上次略退,我們會持續觀察');
    const same = buildFamilySummary(input({ trends: new Map([['test-tug', [{ date: '2026-10-11', value: 14 }, { date: '2026-10-18', value: 14 }]]]) }));
    expect(same.progress.find((p) => p.startsWith('起立走路測試'))).toContain('和上次一樣');
    const first = buildFamilySummary(input({ trends: new Map([['test-tug', [{ date: '2026-10-18', value: 14 }]]]), prev: null }));
    expect(first.progress.find((p) => p.startsWith('起立走路測試'))).toBe('起立走路測試:今天測得 14 秒');
    expect(first.progress).toContain('今天的疼痛程度是 3 分(0 分最不痛、10 分最痛)');
  });

  it('數值越高越好的測驗(30 秒坐站)進步判斷方向正確;認知測驗不放入', () => {
    const c = content((x) => { x.objective.measures = [{ test_id: 'test-30scs', value: 12, unit: '次', measured_at: 't' }, { test_id: 'test-mmse', value: 20, unit: '分', measured_at: 't' }]; });
    const s = buildFamilySummary(input({ content: c, trends: new Map([['test-30scs', [{ date: '2026-10-11', value: 9 }, { date: '2026-10-18', value: 12 }]]]) }));
    expect(s.progress.find((p) => p.startsWith('30 秒坐站測試'))).toContain('進步了');
    expect(summaryToText(s, '診所')).not.toContain('20 分');
    expect(s.progress.join('')).not.toContain('MMSE');
  });

  it('目標進度與圖表資料', () => {
    const goal: Goal = { id: 'g1', patient_id: 'p', description: 'TUG 降到 10 秒', baseline_value: 18, target_value: 10, deadline: null, test_id: 'test-tug', created_at: 't', updated_at: 't' };
    const c = content((x) => { x.assessment.goal_progress = [{ goal_id: 'g1', baseline: 18, current: 14, target: 10, pct: 50 }]; });
    const s = buildFamilySummary(input({ content: c, goals: [goal] }));
    expect(s.progress).toContain('目標「起立走路測試 降到 10 秒」已完成約 50%');
    expect(s.chart?.points.map((p) => p.value)).toEqual([18, 16, 14]);
    expect(s.chart?.title).toBe('起立走路測試(秒)');
  });

  it('術語替換與殘留術語偵測', () => {
    expect(plainify('髖屈曲攣縮,HEP 與 TUG')).toBe('髖部緊繃影響站直,居家運動 與 起立走路測試');
    expect(jargonLeft('請做 DLS 與 PNF 練習')).toEqual(['DLS', 'PNF']);
  });
});

describe('LINE 訊息組裝', () => {
  it('到達、完成、提醒文字;提醒不含健康資訊', () => {
    expect(arriveMessages('診所')[0]).toEqual({ type: 'text', text: '【診所】治療師已到達,服務即將開始。' });
    expect(departMessages('診所')[0]!.text).toContain('摘要稍後送達');
    const r = reminderMessages('診所', '明天(週二)', '14:00', '0912-345-678')[0]!.text as string;
    expect(r).toContain('14:00');
    expect(r).toContain('0912-345-678');
  });

  it('HEP 推送:白話名稱、劑量、示範影片連結(動作庫或處方上的)', () => {
    const ex = SEED_EXERCISES.map((e) => (e.id === 'ex-slr' ? { ...e, video_ref: 'https://example.com/slr' } : e));
    const m = hepMessages('診所', [
      { item_id: 'ex-bridge', dose: { sets: 3, reps: 10, resistance: null, duration: null }, video_ref: 'https://example.com/bridge.mp4' },
      { item_id: 'ex-slr', dose: { sets: 2, reps: 8, resistance: null, duration: null }, video_ref: null },
      { item_id: 'ex-clam', dose: { sets: null, reps: null, resistance: null, duration: null }, video_ref: null },
    ], ex);
    const t = m[0]!.text as string;
    expect(t).toContain('1. 躺著抬屁股練習');
    expect(t).toContain('▶ 示範影片:https://example.com/bridge.mp4');
    expect(t).toContain('https://example.com/slr');
    expect(t).toContain('3. 側躺開腿練習');
    expect(t.split('3. 側躺開腿練習')[1]).not.toContain('示範影片');
    expect(t).toContain('請先停下來並聯絡我們');
  });

  it('長條圖 Flex:長度依數值比例、含替代文字、結構合法', () => {
    const f = chartFlex({ title: '起立走路測試(秒)', unit: '秒', higherBetter: false, points: [{ label: '10/04', value: 18 }, { label: '10/11', value: 16 }, { label: '10/18', value: 9 }] });
    expect(f.type).toBe('flex');
    expect(f.altText).toContain('10/18 9');
    const body = (f.contents as { body: { contents: Record<string, unknown>[] } }).body.contents;
    const rows = body.slice(2) as { contents: { contents?: { width?: string }[] }[] }[];
    const widths = rows.map((r) => r.contents[1]!.contents![0]!.width);
    expect(widths).toEqual(['100%', '89%', '50%']);
    expect(JSON.stringify(f)).toContain('進步');
  });
});

import { DEFAULT_RESOURCES, isHttpUrl, parseResources, resourceLines, resourcesToText } from '../src/shared/resources';

describe('運動資源網站', () => {
  it('預設清單含指定的四個網站,且都是 https', () => {
    expect(DEFAULT_RESOURCES.map((r) => r.url)).toEqual([
      'https://vimeo.com/showcase/11304854',
      'https://chinesetrad.physiotherapyexercises.com',
      'https://ausactive.org.au',
      'https://www.exercises.com.au',
    ]);
    for (const r of DEFAULT_RESOURCES) expect(isHttpUrl(r.url)).toBe(true);
  });

  it('解析:名稱|網址、只有網址、空白行;非 http(s) 或含空白的行列為不合法', () => {
    const { resources, invalid } = parseResources('我的站 | https://a.example.com/x\nhttps://b.example.com/\n\n  \njavascript:alert(1)\nftp://x.y\n壞 | https://c d.com');
    expect(resources).toEqual([{ name: '我的站', url: 'https://a.example.com/x' }, { name: 'b.example.com', url: 'https://b.example.com/' }]);
    expect(invalid).toEqual(['javascript:alert(1)', 'ftp://x.y', '壞 | https://c d.com']);
    expect(parseResources(resourcesToText(DEFAULT_RESOURCES)).resources).toEqual([...DEFAULT_RESOURCES]); // 往返無損
  });

  it('訊息文字:有網站才附,並註明以治療師指示為準', () => {
    expect(resourceLines([])).toEqual([]);
    const lines = resourceLines(DEFAULT_RESOURCES);
    expect(lines[0]).toContain('請以治療師示範與指示的動作和次數為準');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('・Vimeo 示範影片專區:https://vimeo.com/showcase/11304854');
  });

  it('居家運動推送:附上網站清單;未提供則不附', () => {
    const items = [{ item_id: 'ex-bridge', dose: { sets: 3, reps: 10, resistance: null, duration: null }, video_ref: null }];
    const withRes = hepMessages('診所', items, SEED_EXERCISES, DEFAULT_RESOURCES)[0]!.text as string;
    for (const r of DEFAULT_RESOURCES) expect(withRes).toContain(r.url);
    expect(withRes.indexOf('請先停下來並聯絡我們')).toBeLessThan(withRes.indexOf('https://vimeo.com'));
    expect(hepMessages('診所', items, SEED_EXERCISES)[0]!.text as string).not.toContain('vimeo');
  });

  it('家屬摘要:有居家運動處方時附網站,且摘要仍以「接下來怎麼做」段落收尾;沒有處方不附', () => {
    const withHep = summaryToText(buildFamilySummary(input({ resources: [...DEFAULT_RESOURCES] })), '診所');
    const last = withHep.split('\n\n').pop()!;
    expect(last.startsWith('接下來怎麼做')).toBe(true);
    for (const r of DEFAULT_RESOURCES) expect(last).toContain(r.url);
    expect(last).toContain('請以治療師示範與指示的動作和次數為準');
    const noHep = emptySoap();
    noHep.subjective.chief_complaint = 'x';
    const none = summaryToText(buildFamilySummary(input({ content: noHep, resources: [...DEFAULT_RESOURCES] })), '診所');
    expect(none).not.toContain('vimeo.com');
    expect(summaryToText(buildFamilySummary(input()), '診所')).not.toContain('vimeo.com'); // 未提供 → 不附
    expect(jargonLeft(withHep)).not.toContain('Vimeo'); // 網站名稱不算專業術語警示
  });
});
