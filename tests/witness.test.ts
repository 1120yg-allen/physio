import { describe, expect, it } from 'vitest';
import { SqliteRepo } from '../src/server/db';
import { verifyWitness, witnessPending } from '../src/server/witness';
import { newService, patientInput } from './helpers';

async function signed(n: number) {
  const repo = new SqliteRepo(':memory:');
  const svc = newService(repo);
  const p = await svc.createPatient(patientInput);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { encounter: e } = await svc.startVisit({ patient_id: p.id, service_date: `2026-10-${10 + i}`, start_time: '14:00', end_time: '14:45', service_code: null, location: null });
    await svc.saveSoapNote(e.id, { subjective: { chief_complaint: '膝痛' }, objective: {}, assessment: {}, plan: {} });
    await svc.signEncounter(e.id);
    ids.push(e.id);
  }
  return { repo, ids };
}

describe('簽章見證鏈', () => {
  it('蓋章後驗證通過,且重複蓋章不新增', async () => {
    const { repo } = await signed(2);
    expect(witnessPending(repo)).toBe(2);
    expect(witnessPending(repo)).toBe(0);
    expect(verifyWitness(repo)).toEqual({ total: 2, problems: [] });
  });
  it('直接改檔案內容會被發現;見證表不可改刪', async () => {
    const { repo, ids } = await signed(2);
    witnessPending(repo);
    repo.db.exec('DROP TRIGGER IF EXISTS trg_soap_notes_locked_update');
    repo.db.prepare('UPDATE soap_notes SET subjective = ? WHERE encounter_id = ?').run('{"chief_complaint":"被竄改"}', ids[0]!);
    expect(verifyWitness(repo).problems.join()).toContain('被改動');
    expect(() => repo.db.exec("UPDATE sign_witness SET server_time = 'x'")).toThrow();
    expect(() => repo.db.exec('DELETE FROM sign_witness')).toThrow();
  });
});
