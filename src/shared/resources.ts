// 運動資源網站:附在居家運動訊息與家屬摘要的最後,引導病人自行查找動作示範。
// 清單可在「動作庫」頁編輯(存在各裝置的瀏覽器);網址由治療師指定,系統不評斷其內容。

export interface Resource {
  name: string;
  url: string;
}

export const DEFAULT_RESOURCES: readonly Resource[] = [
  { name: 'Vimeo 示範影片專區', url: 'https://vimeo.com/showcase/11304854' },
  { name: 'Physiotherapy Exercises(繁體中文)', url: 'https://chinesetrad.physiotherapyexercises.com' },
  { name: 'AUSactive', url: 'https://ausactive.org.au' },
  { name: 'Exercises.com.au', url: 'https://www.exercises.com.au' },
];

/** 只接受 http(s) 網址 */
export const isHttpUrl = (s: string): boolean => /^https?:\/\/[^\s]+$/i.test(s.trim());

/** 文字 → 清單。每行「名稱 | 網址」或只有網址;不合法的行回傳在 invalid。 */
export function parseResources(text: string): { resources: Resource[]; invalid: string[] } {
  const resources: Resource[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [a, b] = line.includes('|') ? (line.split('|').map((x) => x.trim()) as [string, string]) : ['', line];
    const url = (b ?? '').trim();
    if (!isHttpUrl(url)) {
      invalid.push(line);
      continue;
    }
    resources.push({ name: a || url.replace(/^https?:\/\//i, '').replace(/\/$/, ''), url });
  }
  return { resources, invalid };
}

export const resourcesToText = (rs: readonly Resource[]): string => rs.map((r) => `${r.name} | ${r.url}`).join('\n');

/** 訊息用的文字行。以治療師的指示為準,避免病人自行找到的動作與劑量和處方不同。 */
export function resourceLines(rs: readonly Resource[]): string[] {
  if (rs.length === 0) return [];
  return [
    '想看更多動作示範,可到下列網站搜尋動作名稱(僅供參考,請以治療師示範與指示的動作和次數為準):',
    ...rs.map((r) => `・${r.name}:${r.url}`),
  ];
}
