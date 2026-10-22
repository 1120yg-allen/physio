// 簽章見證鏈:以「伺服器自己的時鐘」為已簽章紀錄蓋時間,並把每筆串成雜湊鏈(含前一筆),
// 事後若有人直接改檔案內容或抽掉某筆,npm run verify 即可發現。
// 限制:這證明「內容最晚在 server_time 已存在、之後未變動」,不是第三方公證,也不是電子簽章法意義的憑證簽章。
import { createHash } from 'node:crypto';
import type { SqliteRepo } from './db';

export interface WitnessRow {
  encounter_id: string;
  seq: number;
  server_time: string;
  content_hash: string;
  prev_hash: string;
  chain_hash: string;
}

const GENESIS = '0'.repeat(64);
// 簽章後仍會合法變動的欄位,不納入內容雜湊
const VOLATILE = new Set(['status', 'updated_at', 'server_seq', 'submission_status']);

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function canon(r: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!r) return null;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(r).sort()) if (!VOLATILE.has(k)) out[k] = r[k];
  return out;
}

export function contentHash(repo: SqliteRepo, encounterId: string): string {
  const q = (t: string): Record<string, unknown> | undefined =>
    repo.db.prepare(`SELECT * FROM ${t} WHERE ${t === 'encounters' ? 'id' : 'encounter_id'} = ?`).get(encounterId) as Record<string, unknown> | undefined;
  return sha(JSON.stringify([canon(q('encounters')), canon(q('soap_notes')), canon(q('ltc_records'))]));
}

/** 為尚未見證的已簽章紀錄蓋章(依簽章時間排序、串入雜湊鏈)。回傳新增筆數。 */
export function witnessPending(repo: SqliteRepo, now: () => string = () => new Date().toISOString()): number {
  const ids = repo.db
    .prepare(`SELECT id FROM encounters WHERE signed_at IS NOT NULL AND id NOT IN (SELECT encounter_id FROM sign_witness) ORDER BY julianday(signed_at), version`)
    .all() as { id: string }[];
  let n = 0;
  for (const { id } of ids) {
    const last = repo.db.prepare('SELECT seq, chain_hash FROM sign_witness ORDER BY seq DESC LIMIT 1').get() as { seq: number; chain_hash: string } | undefined;
    const prev = last?.chain_hash ?? GENESIS;
    const ch = contentHash(repo, id);
    const t = now();
    repo.db
      .prepare('INSERT INTO sign_witness (encounter_id, seq, server_time, content_hash, prev_hash, chain_hash) VALUES (?,?,?,?,?,?)')
      .run(id, (last?.seq ?? 0) + 1, t, ch, prev, sha(`${prev}|${id}|${t}|${ch}`));
    n++;
  }
  return n;
}

export function listWitness(repo: SqliteRepo): WitnessRow[] {
  return repo.db.prepare('SELECT * FROM sign_witness ORDER BY seq').all() as unknown as WitnessRow[];
}

export interface VerifyReport {
  total: number;
  problems: string[];
}

/** 重算整條鏈與每筆內容雜湊;problems 為空代表完整。訊息不含個案資料,只列紀錄編號。 */
export function verifyWitness(repo: SqliteRepo): VerifyReport {
  const problems: string[] = [];
  const rows = listWitness(repo);
  let prev = GENESIS;
  rows.forEach((w, i) => {
    if (w.seq !== i + 1) problems.push(`第 ${i + 1} 筆見證序號不連續(缺漏或被抽掉)`);
    if (w.prev_hash !== prev || w.chain_hash !== sha(`${w.prev_hash}|${w.encounter_id}|${w.server_time}|${w.content_hash}`)) problems.push(`見證鏈在第 ${w.seq} 筆斷裂(${w.encounter_id})`);
    prev = w.chain_hash;
    const exists = repo.db.prepare('SELECT 1 FROM encounters WHERE id = ?').get(w.encounter_id);
    if (!exists) problems.push(`紀錄 ${w.encounter_id} 已不存在`);
    else if (contentHash(repo, w.encounter_id) !== w.content_hash) problems.push(`紀錄 ${w.encounter_id} 簽章後內容被改動`);
  });
  const unw = repo.db.prepare('SELECT COUNT(*) c FROM encounters WHERE signed_at IS NOT NULL AND id NOT IN (SELECT encounter_id FROM sign_witness)').get() as { c: number };
  if (unw.c > 0) problems.push(`${unw.c} 筆已簽章紀錄尚未見證(待同步)`);
  return { total: rows.length, problems };
}
