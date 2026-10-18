import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../src/shared/repo';
import { DataService } from '../src/shared/service';
import { DomainError } from '../src/shared/validate';
import { newIdb, newService, newSqlite, patientInput, type RepoHandle } from './helpers';

// 同一套規則在 SQLite(server)與 IndexedDB(client)上都必須成立
const factories: [string, () => Promise<RepoHandle>][] = [
  ['SQLite', async () => newSqlite()],
  ['IndexedDB', () => newIdb()],
];

describe.each(factories)('資料服務規則 — %s', (_name, make) => {
  let h: RepoHandle;
  let svc: DataService;
  let repo: Repo;

  const setup = async (): Promise<void> => {
    h = await make();
    repo = h.repo;
    svc = newService(repo);
  };
  afterEach(() => h?.close());

  const newEncounter = async (patientId: string, track: 'self_pay' | 'ltc' = 'self_pay') =>
    svc.createEncounter({ patient_id: patientId, track, service_date: '2026-10-18', start_time: '14:00', end_time: '14:00' });

  describe('個案 CRUD(0.3)', () => {
    it('新增後可查詢,禁忌症欄位完整保存', async () => {
      await setup();
      const p = await svc.createPatient(patientInput);
      const got = await svc.getPatient(p.id);
      expect(got?.name).toBe('王大明');
      expect(got?.precautions).toBe('心律不整;避免高強度阻力訓練');
      expect(got?.archived_at).toBeNull();
    });

    it('編輯會更新 updated_at,保留 created_at', async () => {
      await setup();
      const p = await svc.createPatient(patientInput);
      const u = await svc.updatePatient(p.id, { phone: '0912345678', precautions: '新增:骨質疏鬆' });
      expect(u.phone).toBe('0912345678');
      expect(u.precautions).toBe('新增:骨質疏鬆');
      expect(u.created_at).toBe(p.created_at);
      expect(Date.parse(u.updated_at)).toBeGreaterThan(Date.parse(p.updated_at));
    });

    it('結案保留資料,預設查詢不列出,可含結案查詢與重新開案', async () => {
      await setup();
      const p = await svc.createPatient(patientInput);
      await svc.archivePatient(p.id);
      expect(await svc.searchPatients()).toHaveLength(0);
      expect(await svc.searchPatients('', true)).toHaveLength(1);
      expect((await svc.reopenPatient(p.id)).archived_at).toBeNull();
    });

    it('可依姓名或電話搜尋', async () => {
      await setup();
      await svc.createPatient({ ...patientInput, phone: '0911222333' });
      await svc.createPatient({ ...patientInput, name: '李小華', phone: '0988777666' });
      expect((await svc.searchPatients('李')).map((p) => p.name)).toEqual(['李小華']);
      expect(await svc.searchPatients('0911')).toHaveLength(1);
    });

    it('長照個案必須填長照需要等級', async () => {
      await setup();
      await expect(svc.createPatient({ ...patientInput, track: 'ltc' })).rejects.toThrow('長照需要等級');
      await expect(svc.createPatient({ ...patientInput, track: 'both', ltc_level: 4 })).resolves.toBeTruthy();
    });

    it('必填欄位與列舉驗證', async () => {
      await setup();
      await expect(svc.createPatient({ ...patientInput, name: '' })).rejects.toBeInstanceOf(DomainError);
      await expect(svc.createPatient({ ...patientInput, gender: 'x' as never })).rejects.toThrow('不合法');
    });
  });

  describe('服務紀錄與簽章(0.5)', () => {
    it('可建立空白草稿 v1', async () => {
      await setup();
      const p = await svc.createPatient(patientInput);
      const e = await newEncounter(p.id);
      expect(e).toMatchObject({ status: 'draft', version: 1, supersedes_id: null, signed_at: null });
    });

    it('簽章前須通過時間檢核:結束必須晚於開始(防 14:00~14:00)', async () => {
      await setup();
      const p = await svc.createPatient(patientInput);
      const e = await newEncounter(p.id);
      await expect(svc.signEncounter(e.id)).rejects.toThrow('結束時間必須晚於開始時間');
      await svc.updateEncounter(e.id, { end_time: '14:45' });
      const s = await svc.signEncounter(e.id);
      expect(s.status).toBe('signed');
      expect(s.signed_at).not.toBeNull();
    });

    it('簽章後不可直接編輯(服務、SOAP)', async () => {
      await setup();
      const p = await svc.createPatient(patientInput);
      const e = await newEncounter(p.id);
      await svc.saveSoapNote(e.id, { subjective: { chief_complaint: '膝痛' }, objective: null, assessment: null, plan: null });
      await svc.updateEncounter(e.id, { end_time: '14:45' });
      await svc.signEncounter(e.id);
      await expect(svc.updateEncounter(e.id, { end_time: '15:00' })).rejects.toThrow('簽章鎖定');
      await expect(svc.saveSoapNote(e.id, { subjective: { chief_complaint: '改' }, objective: null, assessment: null, plan: null })).rejects.toThrow('簽章鎖定');
      await expect(svc.signEncounter(e.id)).rejects.toThrow('已簽章');
    });

    it('繞過服務層直接寫入已簽章列也會被規則拒絕', async () => {
      await setup();
      const { acceptRow } = await import('../src/shared/rules');
      const p = await svc.createPatient(patientInput);
      const e = await newEncounter(p.id);
      await svc.updateEncounter(e.id, { end_time: '14:45' });
      const signed = await svc.signEncounter(e.id);
      const r = await acceptRow(repo, 'encounters', { ...signed, end_time: '16:00', updated_at: '2030-01-01T00:00:00.000+08:00' });
      expect(r).toMatchObject({ applied: false, reject: 'locked' });
      const back = await repo.get('encounters', e.id);
      expect(back?.end_time).toBe('14:45');
    });

    it('修改已簽章紀錄 → 新版本,supersedes_id 指向前版,原版本完整保留', async () => {
      await setup();
      const p = await svc.createPatient(patientInput);
      const e1 = await newEncounter(p.id);
      await svc.saveSoapNote(e1.id, { subjective: { chief_complaint: '膝痛' }, objective: null, assessment: null, plan: null });
      await svc.updateEncounter(e1.id, { end_time: '14:45' });
      const v1 = await svc.signEncounter(e1.id);

      const v2 = await svc.reviseEncounter(v1.id);
      expect(v2).toMatchObject({ version: 2, supersedes_id: v1.id, status: 'draft', signed_at: null });
      expect(v2.id).not.toBe(v1.id);

      // 新版本帶入前版 SOAP 內容,可修改
      const copied = await svc.getSoapNote(v2.id);
      expect(copied?.subjective).toEqual({ chief_complaint: '膝痛' });
      await svc.saveSoapNote(v2.id, { subjective: { chief_complaint: '膝痛 + 腰痠' }, objective: null, assessment: null, plan: null });
      const v2s = await svc.signEncounter(v2.id);

      // 原版本與其內容、簽章時間不變
      const orig = await svc.getEncounter(v1.id);
      expect(orig).toEqual(v1);
      expect((await svc.getSoapNote(v1.id))?.subjective).toEqual({ chief_complaint: '膝痛' });
      expect(Date.parse(v2s.signed_at as string)).toBeGreaterThan(Date.parse(v1.signed_at as string));
    });

    it('版本鏈可由任一版本回溯,且版本不可分叉', async () => {
      await setup();
      const p = await svc.createPatient(patientInput);
      const e = await newEncounter(p.id);
      await svc.updateEncounter(e.id, { end_time: '14:45' });
      const v1 = await svc.signEncounter(e.id);
      const v2 = await svc.reviseEncounter(v1.id);
      await svc.signEncounter(v2.id);
      const v3 = await svc.reviseEncounter(v2.id);

      expect((await svc.versionChain(v2.id)).map((x) => x.version)).toEqual([1, 2, 3]);
      expect(v3.supersedes_id).toBe(v2.id);
      // v1 已被 v2 取代,不可再從 v1 分岔
      await expect(svc.reviseEncounter(v1.id)).rejects.toThrow('已有後續版本');
      // 草稿不需建立新版本
      await expect(svc.reviseEncounter(v3.id)).rejects.toThrow('草稿可直接修改');
    });

    it('已有後續版本時,即使直接寫入第二個後繼也被拒絕(fork)', async () => {
      await setup();
      const { acceptRow } = await import('../src/shared/rules');
      const p = await svc.createPatient(patientInput);
      const e = await newEncounter(p.id);
      await svc.updateEncounter(e.id, { end_time: '14:45' });
      const v1 = await svc.signEncounter(e.id);
      const v2 = await svc.reviseEncounter(v1.id);
      const r = await acceptRow(repo, 'encounters', { ...v2, id: 'forked-id' });
      expect(r).toMatchObject({ applied: false, reject: 'fork' });
    });

    it('版本號與取代關係必須一致', async () => {
      await setup();
      const { acceptRow } = await import('../src/shared/rules');
      const p = await svc.createPatient(patientInput);
      const e = await newEncounter(p.id);
      await svc.updateEncounter(e.id, { end_time: '14:45' });
      const v1 = await svc.signEncounter(e.id);
      const v2 = await svc.reviseEncounter(v1.id);
      expect(await acceptRow(repo, 'encounters', { ...v2, id: 'x1', supersedes_id: v1.id, version: 5 })).toMatchObject({ applied: false });
      expect(await acceptRow(repo, 'encounters', { ...v2, id: 'x2', supersedes_id: null, version: 2 })).toMatchObject({ applied: false });
    });

    it('已送出申報(submitted)只能由 signed 轉入,且不可再建立新版本', async () => {
      await setup();
      const { acceptRow } = await import('../src/shared/rules');
      const p = await svc.createPatient({ ...patientInput, track: 'ltc', ltc_level: 3 });
      const e = await newEncounter(p.id, 'ltc');
      await svc.updateEncounter(e.id, { end_time: '14:45' });
      const signed = await svc.signEncounter(e.id);
      const sub = await acceptRow(repo, 'encounters', { ...signed, status: 'submitted', updated_at: '2030-01-01T00:00:00.000+08:00' });
      expect(sub).toMatchObject({ applied: true });
      await expect(svc.reviseEncounter(e.id)).rejects.toThrow('僅在狀態 1');
      // 送出狀態同時改其他欄位 → 拒絕
      const bad = await acceptRow(repo, 'encounters', { ...signed, status: 'submitted', end_time: '23:00', updated_at: '2031-01-01T00:00:00.000+08:00' });
      expect(bad).toMatchObject({ applied: false });
    });
  });

  describe('自費/長照隔離(C3)', () => {
    it('自費個案不可建立長照服務;SOAP 只能掛自費、長照紀錄只能掛長照', async () => {
      await setup();
      const sp = await svc.createPatient(patientInput);
      await expect(newEncounter(sp.id, 'ltc')).rejects.toThrow('平行軌');

      const both = await svc.createPatient({ ...patientInput, name: '雙軌', track: 'both', ltc_level: 2 });
      const ltcEnc = await newEncounter(both.id, 'ltc');
      const spEnc = await newEncounter(both.id, 'self_pay');
      await expect(svc.saveSoapNote(ltcEnc.id, { subjective: null, objective: null, assessment: null, plan: null })).rejects.toThrow('只能掛在自費');
      await expect(svc.saveLtcRecord(spEnc.id, { care_goal_id: null, staff_id: null, executed_content: null, completion: null, feedback: null, quota_month: null })).rejects.toThrow('只能掛在長照');
    });

    it('服務軌別建立後不可更改', async () => {
      await setup();
      const { acceptRow } = await import('../src/shared/rules');
      const both = await svc.createPatient({ ...patientInput, track: 'both', ltc_level: 2 });
      const e = await newEncounter(both.id, 'self_pay');
      const r = await acceptRow(repo, 'encounters', { ...e, track: 'ltc', updated_at: '2030-01-01T00:00:00.000+08:00' });
      expect(r).toMatchObject({ applied: false, reject: 'conflict' });
    });
  });

  describe('其他', () => {
    it('同一服務只能有一筆 SOAP(1:1),重複儲存是更新', async () => {
      await setup();
      const p = await svc.createPatient(patientInput);
      const e = await newEncounter(p.id);
      const a = await svc.saveSoapNote(e.id, { subjective: { a: 1 }, objective: null, assessment: null, plan: null });
      const b = await svc.saveSoapNote(e.id, { subjective: { a: 2 }, objective: null, assessment: null, plan: null });
      expect(b.id).toBe(a.id);
      expect(await repo.list('soap_notes')).toHaveLength(1);
    });

    it('服務紀錄列表依日期新到舊,含歷史版本', async () => {
      await setup();
      const p = await svc.createPatient(patientInput);
      const a = await svc.createEncounter({ patient_id: p.id, track: 'self_pay', service_date: '2026-10-01', start_time: '09:00', end_time: '10:00' });
      await svc.createEncounter({ patient_id: p.id, track: 'self_pay', service_date: '2026-10-10', start_time: '09:00', end_time: '10:00' });
      await svc.signEncounter(a.id);
      await svc.reviseEncounter(a.id);
      const list = await svc.listEncounters(p.id);
      expect(list.map((x) => `${x.service_date}/v${x.version}`)).toEqual(['2026-10-10/v1', '2026-10-01/v2', '2026-10-01/v1']);
    });
  });
});
