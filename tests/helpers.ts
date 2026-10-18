import { IDBFactory } from 'fake-indexeddb';
import { IdbRepo, openPhysioDb } from '../src/client/idb';
import { SqliteRepo } from '../src/server/db';
import type { Repo } from '../src/shared/repo';
import { DataService } from '../src/shared/service';
import { toTaipeiIso } from '../src/shared/time';

/** 每次呼叫前進 1 秒的假時鐘,讓時間戳可預測且嚴格遞增 */
export function fakeClock(start = '2026-10-18T09:00:00+08:00'): () => string {
  let t = Date.parse(start);
  return () => toTaipeiIso(new Date((t += 1000)));
}

export function seqIds(): () => string {
  let n = 0;
  return () => `id-${String(++n).padStart(4, '0')}`;
}

export interface RepoHandle {
  name: string;
  repo: Repo;
  close(): void;
}

export function newSqlite(): RepoHandle {
  const repo = new SqliteRepo(':memory:');
  return { name: 'sqlite', repo, close: () => repo.close() };
}

export async function newIdb(): Promise<RepoHandle & { repo: IdbRepo; db: IDBDatabase }> {
  const db = await openPhysioDb(`t-${Math.random()}`, new IDBFactory());
  const repo = new IdbRepo(db);
  return { name: 'indexeddb', repo, db, close: () => db.close() };
}

export function newService(repo: Repo): DataService {
  return new DataService({ repo, newId: seqIds(), now: fakeClock() });
}

export const patientInput = {
  name: '王大明',
  birth_date: '1950-03-02',
  track: 'self_pay' as const,
  referral_required: true,
  precautions: '心律不整;避免高強度阻力訓練',
};
