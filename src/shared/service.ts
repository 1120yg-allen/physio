// 本機業務服務:個案 CRUD、服務紀錄、簽章與版本。
// 所有寫入都經 acceptRow,與 server 套用同一套規則。
// 本檔函式處理的皆為特種個資(個案健康資料),不得將參數或回傳值寫入 log。
import type { Repo } from './repo';
import { acceptRowOrThrow, assertSignable, Rejection } from './rules';
import type { Encounter, EncounterTrack, LtcRecord, Location, Patient, SoapNote } from './schema';
import { nowTaipei, toTaipeiIso } from './time';
import { DomainError } from './validate';

export interface ServiceDeps {
  repo: Repo;
  /** 產生 uuid;預設 crypto.randomUUID */
  newId?: () => string;
  /** 取得現在時間(ISO 8601 + 時區);預設台北時間 */
  now?: () => string;
}

export type NewPatientInput = Pick<Patient, 'name' | 'birth_date' | 'track' | 'referral_required'> &
  Partial<Omit<Patient, 'id' | 'created_at' | 'updated_at' | 'archived_at'>>;

export type PatientPatch = Partial<Omit<Patient, 'id' | 'created_at' | 'updated_at' | 'archived_at'>>;

export interface NewEncounterInput {
  patient_id: string;
  track: EncounterTrack;
  service_date: string;
  start_time: string;
  end_time: string;
  service_code?: string | null;
  location?: Location | null;
}

export type EncounterPatch = Partial<
  Pick<Encounter, 'service_date' | 'start_time' | 'end_time' | 'service_code' | 'location' | 'no_show' | 'no_show_photo' | 'gps'>
>;

export class DataService {
  private readonly repo: Repo;
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(deps: ServiceDeps) {
    this.repo = deps.repo;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? nowTaipei;
  }

  // ───────────── 個案 ─────────────

  /** 新增個案(含禁忌症 precautions 等特種個資) */
  async createPatient(input: NewPatientInput): Promise<Patient> {
    const t = this.now();
    const row: Patient = {
      id: this.newId(),
      name: input.name,
      birth_date: input.birth_date,
      gender: input.gender ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      emergency_contact: input.emergency_contact ?? null,
      track: input.track,
      ltc_level: input.ltc_level ?? null,
      referral_doc: input.referral_doc ?? null,
      referral_required: input.referral_required,
      precautions: input.precautions ?? null,
      created_at: t,
      updated_at: t,
      archived_at: null,
    };
    await acceptRowOrThrow(this.repo, 'patients', row);
    return row;
  }

  async updatePatient(id: string, patch: PatientPatch): Promise<Patient> {
    const cur = await this.mustGetPatient(id);
    const row: Patient = { ...cur, ...patch, updated_at: this.laterThan(cur.updated_at) };
    await acceptRowOrThrow(this.repo, 'patients', row);
    return row;
  }

  /** 結案:設定 archived_at,資料保留(法定保存十年,不刪除)。 */
  async archivePatient(id: string): Promise<Patient> {
    const cur = await this.mustGetPatient(id);
    if (cur.archived_at) return cur;
    const t = this.laterThan(cur.updated_at);
    const row: Patient = { ...cur, archived_at: t, updated_at: t };
    await acceptRowOrThrow(this.repo, 'patients', row);
    return row;
  }

  async reopenPatient(id: string): Promise<Patient> {
    const cur = await this.mustGetPatient(id);
    const row: Patient = { ...cur, archived_at: null, updated_at: this.laterThan(cur.updated_at) };
    await acceptRowOrThrow(this.repo, 'patients', row);
    return row;
  }

  getPatient(id: string): Promise<Patient | null> {
    return this.repo.get('patients', id);
  }

  /** 查詢個案;query 比對姓名/電話(子字串),includeArchived=false 時排除結案。 */
  async searchPatients(query = '', includeArchived = false): Promise<Patient[]> {
    const q = query.trim().toLowerCase();
    const all = await this.repo.list('patients');
    return all
      .filter((p) => includeArchived || p.archived_at === null)
      .filter((p) => q === '' || p.name.toLowerCase().includes(q) || (p.phone ?? '').includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  }

  // ───────────── 服務紀錄 ─────────────

  /** 建立空白服務紀錄(草稿 v1)。 */
  async createEncounter(input: NewEncounterInput): Promise<Encounter> {
    const t = this.now();
    const row: Encounter = {
      id: this.newId(),
      patient_id: input.patient_id,
      track: input.track,
      service_date: input.service_date,
      start_time: input.start_time,
      end_time: input.end_time,
      service_code: input.service_code ?? null,
      location: input.location ?? null,
      status: 'draft',
      signed_at: null,
      version: 1,
      supersedes_id: null,
      no_show: null,
      no_show_photo: null,
      gps: null,
      created_at: t,
      updated_at: t,
    };
    await acceptRowOrThrow(this.repo, 'encounters', row);
    return row;
  }

  /** 修改草稿。已簽章者拒絕(須走 reviseEncounter)。 */
  async updateEncounter(id: string, patch: EncounterPatch): Promise<Encounter> {
    const cur = await this.mustGetEncounter(id);
    if (cur.signed_at !== null) throw new DomainError('locked', '紀錄已簽章鎖定,修改請建立新版本');
    const row: Encounter = { ...cur, ...patch, updated_at: this.laterThan(cur.updated_at) };
    await acceptRowOrThrow(this.repo, 'encounters', row);
    return row;
  }

  /** 儲存自費 SOAP(1:1,有則更新)。已簽章拒絕。 */
  async saveSoapNote(encounterId: string, content: Pick<SoapNote, 'subjective' | 'objective' | 'assessment' | 'plan'>): Promise<SoapNote> {
    const enc = await this.mustGetEncounter(encounterId);
    this.assertEditable(enc);
    const cur = await this.repo.getByEncounter('soap_notes', encounterId);
    const t = this.now();
    const row: SoapNote = {
      id: cur?.id ?? this.newId(),
      encounter_id: encounterId,
      subjective: content.subjective,
      objective: content.objective,
      assessment: content.assessment,
      plan: content.plan,
      created_at: cur?.created_at ?? t,
      updated_at: cur ? this.laterThan(cur.updated_at) : t,
    };
    await acceptRowOrThrow(this.repo, 'soap_notes', row);
    return row;
  }

  /** 儲存長照申報紀錄(1:1,有則更新)。已簽章拒絕。 */
  async saveLtcRecord(
    encounterId: string,
    content: Pick<LtcRecord, 'care_goal_id' | 'executed_content' | 'completion' | 'feedback' | 'quota_month'>,
  ): Promise<LtcRecord> {
    const enc = await this.mustGetEncounter(encounterId);
    this.assertEditable(enc);
    const cur = await this.repo.getByEncounter('ltc_records', encounterId);
    const t = this.now();
    const row: LtcRecord = {
      id: cur?.id ?? this.newId(),
      encounter_id: encounterId,
      ...content,
      submission_status: cur?.submission_status ?? 0,
      created_at: cur?.created_at ?? t,
      updated_at: cur ? this.laterThan(cur.updated_at) : t,
    };
    await acceptRowOrThrow(this.repo, 'ltc_records', row);
    return row;
  }

  /**
   * 簽章:設定 signed_at、狀態轉為 signed,此後鎖定不可覆寫(C2)。
   * 簽章前提:結束時間須晚於開始時間。
   */
  async signEncounter(id: string): Promise<Encounter> {
    const cur = await this.mustGetEncounter(id);
    if (cur.signed_at !== null) throw new DomainError('locked', '此紀錄已簽章');
    try {
      assertSignable(cur);
    } catch (e) {
      if (e instanceof Rejection) throw new DomainError(e.reject, e.message);
      throw e;
    }
    const t = this.laterThan(cur.updated_at);
    const row: Encounter = { ...cur, status: 'signed', signed_at: t, updated_at: t };
    await acceptRowOrThrow(this.repo, 'encounters', row);
    return row;
  }

  /**
   * 修改已簽章紀錄:不覆寫原版本,建立新版本草稿(version + 1、supersedes_id 指向前版),
   * 並複製前版的 SOAP/長照內容供編輯。原版本與其時間戳完整保留(C2 版本軌跡)。
   */
  async reviseEncounter(id: string): Promise<Encounter> {
    const prev = await this.mustGetEncounter(id);
    if (prev.signed_at === null) throw new DomainError('conflict', '草稿可直接修改,不需建立新版本');
    if (prev.status === 'submitted') {
      throw new DomainError('conflict', '已送出申報的紀錄須依申報流程處理,不可直接建立新版本');
    }
    if (await this.repo.getSuperseder(prev.id)) {
      throw new DomainError('fork', '此版本已有後續版本,請修改最新版本');
    }
    const t = this.now();
    const next: Encounter = {
      ...prev,
      id: this.newId(),
      status: 'draft',
      signed_at: null,
      version: prev.version + 1,
      supersedes_id: prev.id,
      created_at: t,
      updated_at: t,
    };
    await acceptRowOrThrow(this.repo, 'encounters', next);

    const soap = await this.repo.getByEncounter('soap_notes', prev.id);
    if (soap) {
      await acceptRowOrThrow(this.repo, 'soap_notes', { ...soap, id: this.newId(), encounter_id: next.id, created_at: t, updated_at: t });
    }
    const ltc = await this.repo.getByEncounter('ltc_records', prev.id);
    if (ltc) {
      await acceptRowOrThrow(this.repo, 'ltc_records', { ...ltc, id: this.newId(), encounter_id: next.id, created_at: t, updated_at: t });
    }
    return next;
  }

  /** 某個案的所有服務紀錄(含歷史版本),依服務日期、版本排序。 */
  async listEncounters(patientId: string): Promise<Encounter[]> {
    const list = await this.repo.listEncountersByPatient(patientId);
    return list.sort((a, b) => b.service_date.localeCompare(a.service_date) || b.start_time.localeCompare(a.start_time) || b.version - a.version);
  }

  /** 版本鏈:從任一版本出發,回傳由 v1 到最新版的完整串列。 */
  async versionChain(id: string): Promise<Encounter[]> {
    let cur = await this.mustGetEncounter(id);
    while (cur.supersedes_id) {
      const prev = await this.repo.get('encounters', cur.supersedes_id);
      if (!prev) break;
      cur = prev;
    }
    const chain: Encounter[] = [cur];
    for (let next = await this.repo.getSuperseder(cur.id); next; next = await this.repo.getSuperseder(next.id)) {
      chain.push(next);
    }
    return chain;
  }

  getEncounter(id: string): Promise<Encounter | null> {
    return this.repo.get('encounters', id);
  }

  getSoapNote(encounterId: string): Promise<SoapNote | null> {
    return this.repo.getByEncounter('soap_notes', encounterId);
  }

  getLtcRecord(encounterId: string): Promise<LtcRecord | null> {
    return this.repo.getByEncounter('ltc_records', encounterId);
  }

  // ───────────── 內部 ─────────────

  private assertEditable(enc: Encounter): void {
    if (enc.signed_at !== null) throw new DomainError('locked', '紀錄已簽章鎖定,修改請建立新版本');
  }

  /** 產生嚴格晚於 prev 的時間戳,避免同毫秒寫入被當成舊資料。 */
  private laterThan(prev: string): string {
    const t = this.now();
    if (Date.parse(t) > Date.parse(prev)) return t;
    return toTaipeiIso(new Date(Date.parse(prev) + 1));
  }

  private async mustGetPatient(id: string): Promise<Patient> {
    const p = await this.repo.get('patients', id);
    if (!p) throw new DomainError('not_found', '找不到個案');
    return p;
  }

  private async mustGetEncounter(id: string): Promise<Encounter> {
    const e = await this.repo.get('encounters', id);
    if (!e) throw new DomainError('not_found', '找不到服務紀錄');
    return e;
  }
}
