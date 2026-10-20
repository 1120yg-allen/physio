// LINE 訊息組裝:到達/完成通知、HEP 推送、數值長條圖(Flex)。純函式,不含網路呼叫。
import { plainDose, plainExerciseName, plainify, type FamilyChart } from './family';
import { resourceLines, type Resource } from './resources';
import type { Exercise } from './schema';
import type { HepItem } from './soap';

export type LineMessageObj = Record<string, unknown>;

export const text = (t: string): LineMessageObj => ({ type: 'text', text: t });

export function arriveMessages(clinicName: string): LineMessageObj[] {
  return [text(`【${clinicName}】治療師已到達,服務即將開始。`)];
}

export function departMessages(clinicName: string): LineMessageObj[] {
  return [text(`【${clinicName}】今天的服務已完成,治療摘要稍後送達。`)];
}

/** 服務前一日提醒(不含任何健康資訊) */
export function reminderMessages(clinicName: string, dateLabel: string, time: string, contact: string | null): LineMessageObj[] {
  const tail = contact ? `如需更改時間,請聯絡:${contact}` : '如需更改時間,請直接回覆或來電聯絡';
  return [text(`【${clinicName}】提醒您:${dateLabel} ${time} 治療師將到府服務。\n${tail}`)];
}

/** HEP 推送:每項運動附白話說明與示範影片連結(影片網址由治療師在動作庫維護) */
export function hepMessages(clinicName: string, items: HepItem[], exercises: Exercise[], resources: readonly Resource[] = []): LineMessageObj[] {
  const lines = items.map((h, idx) => {
    const ex = exercises.find((e) => e.id === h.item_id);
    const dose = plainDose(h.dose);
    const url = h.video_ref ?? ex?.video_ref ?? null;
    return [`${idx + 1}. ${plainExerciseName(ex, h.item_id)}`, dose ? `   ${dose}` : null, url ? `   ▶ 示範影片:${url}` : null].filter(Boolean).join('\n');
  });
  const extra = resourceLines(resources);
  return [text([`【${clinicName}】居家運動`, '', ...lines, '', '練習時如果疼痛變厲害、頭暈或不舒服,請先停下來並聯絡我們。', ...(extra.length ? ['', ...extra] : [])].join('\n'))];
}

const BAR_COLOR = '#0e7490';
const TRACK_COLOR = '#e3eef2';

/** 數值長條圖(LINE Flex bubble):用方塊寬度表示數值大小,不需要公網圖片 */
export function chartFlex(chart: FamilyChart): LineMessageObj {
  const max = Math.max(...chart.points.map((p) => p.value), 1);
  const first = chart.points[0]!.value;
  const last = chart.points[chart.points.length - 1]!.value;
  const better = chart.higherBetter === null ? null : chart.higherBetter ? last > first : last < first;
  const arrow = last === first ? '→' : last > first ? '↑' : '↓';
  const rows = chart.points.map((p) => ({
    type: 'box', layout: 'horizontal', spacing: 'md', alignItems: 'center', margin: 'sm',
    contents: [
      { type: 'text', text: p.label, size: 'sm', color: '#5b6b73', flex: 2 },
      { type: 'box', layout: 'vertical', flex: 6, backgroundColor: TRACK_COLOR, cornerRadius: 'sm', height: '14px',
        contents: [{ type: 'box', layout: 'vertical', width: `${Math.max(4, Math.round((p.value / max) * 100))}%`, height: '14px', backgroundColor: BAR_COLOR, cornerRadius: 'sm', contents: [] }] },
      { type: 'text', text: String(Math.round(p.value * 100) / 100), size: 'sm', weight: 'bold', align: 'end', flex: 2 },
    ],
  }));
  return {
    type: 'flex',
    altText: `${chart.title}:${chart.points.map((p) => `${p.label} ${p.value}`).join('、')}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: plainify(chart.title), weight: 'bold', size: 'md', wrap: true },
          { type: 'text', text: `${arrow} ${Math.round(first * 100) / 100} → ${Math.round(last * 100) / 100}${better === null || last === first ? '' : better ? '(進步)' : ''}`, size: 'sm', color: '#5b6b73', margin: 'xs' },
          ...rows,
        ],
      },
    },
  };
}
