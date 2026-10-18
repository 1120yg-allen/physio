import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { exportAll, importAll } from '../src/client/backup';
import { IdbRepo, openPhysioDb } from '../src/client/idb';
import { DataService } from '../src/shared/service';
import { emptySoap } from '../src/shared/soap';
import { fakeClock, patientInput, seqIds } from './helpers';

const out = mkdtempSync(join(tmpdir(), 'physio-build-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('建置輸出可放在子路徑(GitHub Pages /physio/)', () => {
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', out, '--emptyOutDir'], { env: { ...process.env, VITE_STATIC: '1' }, encoding: 'utf8' });

  it('建置成功', () => {
    expect(build.status, build.stderr).toBe(0);
  });

  it('index.html:不含任何絕對路徑資源,也沒有開發用導向片語', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).not.toMatch(/(?:src|href)="\/(?!\/)/); // 不得有以 / 開頭的資源路徑(子路徑下會找不到)
    expect(html).not.toContain('/src/client');
    expect(html).not.toContain('location.replace');
    expect(html).toMatch(/src="\.\/assets\/index-[^"]+\.js"/);
    expect(html).toContain('./manifest.webmanifest');
  });

  it('manifest 與 Service Worker 使用相對路徑;輸出含所有圖示', () => {
    const m = JSON.parse(readFileSync(join(out, 'manifest.webmanifest'), 'utf8')) as { start_url: string; scope: string; icons: { src: string }[] };
    expect(m.start_url).toBe('./');
    expect(m.scope).toBe('./');
    for (const i of m.icons) expect(i.src.startsWith('/')).toBe(false);
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    expect(sw).toContain('self.registration.scope');
    expect(sw).not.toMatch(/addAll\(\[\s*'\//);
    expect(readdirSync(out)).toEqual(expect.arrayContaining(['index.html', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'apple-touch-icon.png', 'assets']));
  });

  it('純本機版旗標已編入(顯示提示、不呼叫伺服器)', () => {
    const js = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('');
    expect(js).toContain('純本機版');
  });
});

describe('匯出/匯入備份', () => {
  async function dev() {
    const db = await openPhysioDb(`b-${Math.random()}`, new IDBFactory());
    const repo = new IdbRepo(db);
    const svc = new DataService({ repo, newId: seqIds(), now: fakeClock('2026-10-18T09:00:00+08:00') });
    return { repo, svc, db };
  }

  it('匯出後匯入到全新的資料庫,資料完整(含已簽章紀錄與版本鏈)', async () => {
    const a = await dev();
    await a.svc.seedDictionaries();
    const p = await a.svc.createPatient({ ...patientInput, address: '台北市' });
    const v = await a.svc.startVisit({ patient_id: p.id, service_date: '2026-10-18', start_time: '10:00', end_time: '10:45' });
    const c = emptySoap();
    c.subjective.chief_complaint = '膝痛';
    c.objective.interventions = [{ category: 'exercise', item_id: 'ex-bridge', dose: { sets: 3, reps: 10, resistance: null, duration: null } }];
    await a.svc.saveSoapContent(v.encounter.id, c);
    const signed = await a.svc.signEncounter(v.encounter.id);
    const v2 = await a.svc.reviseEncounter(signed.id);

    const file = JSON.parse(JSON.stringify(await exportAll(a.repo))) as unknown;
    const b = await dev();
    const r = await importAll(b.repo, file);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toBe(r.total);
    expect(await b.svc.getEncounter(signed.id)).toEqual(signed);
    expect((await b.svc.getSoapContent(signed.id)).subjective.chief_complaint).toBe('膝痛');
    expect((await b.svc.versionChain(v2.id)).map((x) => x.version)).toEqual([1, 2]);
    expect((await b.svc.getPatient(p.id))?.address).toBe('台北市');
    // 重複匯入是冪等的
    const again = await importAll(b.repo, file);
    expect(again.rejected).toEqual([]);
  });

  it('匯入不會覆寫已簽章鎖定的紀錄(竄改過的備份被拒絕)', async () => {
    const a = await dev();
    const p = await a.svc.createPatient(patientInput);
    const e = await a.svc.createEncounter({ patient_id: p.id, track: 'self_pay', service_date: '2026-10-18', start_time: '10:00', end_time: '10:45' });
    await a.svc.saveSoapContent(e.id, { ...emptySoap(), subjective: { ...emptySoap().subjective, chief_complaint: 'x' } } as never).catch(() => undefined);
    const signed = await new DataService({ repo: a.repo, newId: seqIds(), now: fakeClock('2026-10-18T10:00:00+08:00'), enforceContent: false }).signEncounter(e.id);
    const file = JSON.parse(JSON.stringify(await exportAll(a.repo))) as { tables: { encounters: { id: string; end_time: string; updated_at: string }[] } };
    file.tables.encounters = file.tables.encounters.map((x) => (x.id === signed.id ? { ...x, end_time: '23:59', updated_at: '2099-01-01T00:00:00.000+08:00' } : x));
    const r = await importAll(a.repo, file);
    expect(r.rejected.some((x) => x.reject === 'locked')).toBe(true);
    expect((await a.svc.getEncounter(signed.id))?.end_time).toBe('10:45');
  });

  it('不是備份檔會被拒絕', async () => {
    const a = await dev();
    await expect(importAll(a.repo, { hello: 1 })).rejects.toThrow('不是本系統匯出的備份檔');
    await expect(importAll(a.repo, null)).rejects.toThrow('不是本系統匯出的備份檔');
  });
});
