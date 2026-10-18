import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, SqliteRepo } from '../src/server/db';
import { TABLES } from '../src/shared/schema';
import { newService, patientInput } from './helpers';

// SPEC §2.1–2.4 規格欄位(一字不差)
const SPEC_COLUMNS: Record<string, string[]> = {
  patients: ['id', 'name', 'birth_date', 'gender', 'phone', 'address', 'emergency_contact', 'track', 'ltc_level', 'referral_doc', 'referral_required', 'precautions', 'created_at', 'updated_at', 'archived_at'],
  encounters: ['id', 'patient_id', 'track', 'service_date', 'start_time', 'end_time', 'service_code', 'location', 'status', 'signed_at', 'version', 'supersedes_id', 'no_show', 'no_show_photo', 'gps'],
  soap_notes: ['subjective', 'objective', 'assessment', 'plan'],
  ltc_records: ['care_goal_id', 'executed_content', 'completion', 'feedback', 'quota_month', 'submission_status'],
};

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('SQLite schema(0.2)', () => {
  it('SPEC §2 的資料表與欄位齊全且名稱一致', () => {
    const repo = new SqliteRepo(':memory:');
    for (const [table, cols] of Object.entries(SPEC_COLUMNS)) {
      const actual = (repo.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      for (const c of cols) expect(actual, `${table}.${c}`).toContain(c);
    }
    const tables = (repo.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ['tests', 'exercises', 'goals', 'favorites']) expect(tables).toContain(t);
    expect(TABLES.map((t) => t.name).sort()).toEqual(['encounters', 'exercises', 'favorites', 'goals', 'ltc_records', 'patients', 'soap_notes', 'tests']);
  });

  it('migration 可重跑且不重複套用', () => {
    const repo = new SqliteRepo(':memory:');
    migrate(repo.db);
    migrate(repo.db);
    const n = repo.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(Number(n.n)).toBe(2);
  });

  it('JSON、布林欄位來回轉換正確', async () => {
    const repo = new SqliteRepo(':memory:');
    const svc = newService(repo);
    const p = await svc.createPatient({
      ...patientInput,
      emergency_contact: { name: '王小美', relation: '女兒', phone: '0922333444' },
      referral_doc: { institution: '某醫院', physician: '陳醫師', issued_on: '2026-09-01', valid_until: '2027-03-01' },
    });
    expect(await repo.get('patients', p.id)).toEqual(p);
  });
});

describe('資料庫層法遵防線(C2)', () => {
  async function signedEncounter() {
    const repo = new SqliteRepo(':memory:');
    const svc = newService(repo);
    const p = await svc.createPatient(patientInput);
    const e = await svc.createEncounter({ patient_id: p.id, track: 'self_pay', service_date: '2026-10-18', start_time: '14:00', end_time: '14:45' });
    await svc.saveSoapNote(e.id, { subjective: { a: 1 }, objective: null, assessment: null, plan: null });
    const signed = await svc.signEncounter(e.id);
    return { repo, svc, p, signed };
  }

  it('已簽章服務:直接下 SQL UPDATE 也無法改欄位', async () => {
    const { repo, signed } = await signedEncounter();
    expect(() => repo.db.prepare('UPDATE encounters SET end_time = ? WHERE id = ?').run('23:59', signed.id)).toThrow('已簽章紀錄不可修改');
    expect(() => repo.db.prepare('UPDATE encounters SET signed_at = NULL WHERE id = ?').run(signed.id)).toThrow('已簽章紀錄不可修改');
    expect(() => repo.db.prepare("UPDATE encounters SET status = 'draft' WHERE id = ?").run(signed.id)).toThrow('已簽章紀錄不可修改');
  });

  it('已簽章服務:僅允許 signed → submitted', async () => {
    const { repo, signed } = await signedEncounter();
    expect(() => repo.db.prepare("UPDATE encounters SET status = 'submitted' WHERE id = ?").run(signed.id)).not.toThrow();
    expect(() => repo.db.prepare("UPDATE encounters SET status = 'signed' WHERE id = ?").run(signed.id)).toThrow();
  });

  it('簽章後直接改 SOAP 內容被擋(簽章前內容可抵達)', async () => {
    const { repo, signed } = await signedEncounter();
    expect(() =>
      repo.db.prepare("UPDATE soap_notes SET subjective = '{}', updated_at = '2099-01-01T00:00:00.000+08:00' WHERE encounter_id = ?").run(signed.id),
    ).toThrow('已簽章紀錄不可修改');
  });

  it('病歷資料(個案、服務、SOAP、長照)不可刪除', async () => {
    const { repo, signed, p } = await signedEncounter();
    expect(() => repo.db.prepare('DELETE FROM encounters WHERE id = ?').run(signed.id)).toThrow('不可刪除');
    expect(() => repo.db.prepare('DELETE FROM soap_notes').run()).toThrow('不可刪除');
    expect(() => repo.db.prepare('DELETE FROM patients WHERE id = ?').run(p.id)).toThrow('不可刪除');
    const triggers = (repo.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map((t) => t.name);
    expect(triggers).toContain('trg_ltc_records_no_delete');
  });

  it('版本鏈分叉被唯一索引擋下', async () => {
    const { repo, svc, signed } = await signedEncounter();
    const v2 = await svc.reviseEncounter(signed.id);
    const cols = Object.keys(v2);
    const vals = Object.values(v2).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : (v as string | number | null)));
    vals[0] = 'forked';
    expect(() => repo.db.prepare(`INSERT INTO encounters (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals)).toThrow();
  });
});

describe('備份與還原(0.6)', () => {
  it('備份檔可還原出完整資料,還原時舊資料庫被保留', async () => {
    const { backupNow, restoreBackup, backupIfDue, listBackups } = await import('../src/server/backup');
    dir = mkdtempSync(join(tmpdir(), 'physio-'));
    const dbPath = join(dir, 'physio.sqlite');
    const bdir = join(dir, 'backups');

    const repo = new SqliteRepo(dbPath);
    const svc = newService(repo);
    const p = await svc.createPatient(patientInput);
    const e = await svc.createEncounter({ patient_id: p.id, track: 'self_pay', service_date: '2026-10-18', start_time: '14:00', end_time: '14:45' });
    await svc.saveSoapNote(e.id, { subjective: { chief_complaint: '膝痛' }, objective: null, assessment: null, plan: null });
    await svc.signEncounter(e.id);

    const day1 = new Date('2026-10-18T02:00:00Z');
    const file = backupNow(repo, bdir, day1);
    expect(file).toContain('physio-2026-10-18.sqlite');

    // 同日不重複備份;隔日再備份
    expect(backupIfDue(repo, bdir, day1)).toBeNull();
    expect(backupIfDue(repo, bdir, new Date('2026-10-19T02:00:00Z'))).toContain('2026-10-19');
    expect(listBackups(bdir)).toHaveLength(2);

    // 備份後新增資料,再還原 → 回到備份當時狀態
    await svc.createPatient({ ...patientInput, name: '備份後才新增' });
    repo.close();
    const kept = restoreBackup(file, dbPath);
    expect(kept).not.toBeNull();

    const restored = new SqliteRepo(dbPath);
    const rsvc = newService(restored);
    expect((await rsvc.searchPatients()).map((x) => x.name)).toEqual(['王大明']);
    expect((await rsvc.getSoapNote(e.id))?.subjective).toEqual({ chief_complaint: '膝痛' });
    expect((await rsvc.getEncounter(e.id))?.status).toBe('signed');
    restored.close();

    // 被保留的舊資料庫仍含「備份後才新增」
    const old = new SqliteRepo(kept as string);
    expect((await newService(old).searchPatients()).map((x) => x.name)).toContain('備份後才新增');
    old.close();
  });

  it('損毀的備份檔會被拒絕,不動現有資料庫', async () => {
    const { restoreBackup } = await import('../src/server/backup');
    const { writeFileSync } = await import('node:fs');
    dir = mkdtempSync(join(tmpdir(), 'physio-'));
    const bad = join(dir, 'bad.sqlite');
    writeFileSync(bad, 'not a database');
    const dbPath = join(dir, 'physio.sqlite');
    new SqliteRepo(dbPath).close();
    expect(() => restoreBackup(bad, dbPath)).toThrow();
    new SqliteRepo(dbPath).close(); // 原資料庫仍可開啟
  });
});
