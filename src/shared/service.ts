// 本機業務服務:個案 CRUD、服務紀錄、簽章與版本。
// 所有寫入都經 acceptRow,與 server 套用同一套規則。
// 本檔函式處理的皆為特種個資(個案健康資料),不得將參數或回傳值寫入 log。
import type { Repo } from './repo';
import { acceptRowOrThrow, assertSignable, Rejection } from './rules';
import { SEED_EXERCISES, SEED_TESTS } from './seed';
import type { FamilyInput, TrendPt } from './family';
import { addDays, appointmentsOn, dateOf, makeIso, timeOf } from './schedule';
import { trendFor } from './trend';
import { blockedIds, canCorrect, canTransition, ltcMissingFields, nextMonth, monthOf, precheck, type LtcContext, type LtcItem, type PrecheckIssue } from './ltc';
import type { TableRows } from './schema';
import type { Appointment, Encounter, EncounterTrack, Exercise, Favorite, Goal, LineMessage, LineMessageKind, LtcRecord, Location, Patient, SoapNote, TestDef } from './schema';
import { emptySoap, parseSoap, pickPreviousEncounter, prefillFromPrevious, serializeSoap, soapMissing, type SoapContent } from './soap';
import { nowTaipei, todayTaipei, toTaipeiIso } from './time';
import { DomainError } from './validate';

export interface ServiceDeps {
  repo: Repo;
  /** 產生 uuid;預設 crypto.randomUUID */
  newId?: () => string;
  /** 取得現在時間(ISO 8601 + 時區);預設台北時間 */
  now?: () => string;
  /** 簽章時是否檢查內容完整性(自費:主訴 + 至少一項 O 內容)。預設 true */
  enforceContent?: boolean;
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

type LtcTable = 'ltc_contracts' | 'ltc_staff' | 'ltc_plans' | 'ltc_quotas' | 'ltc_suspensions';

export class DataService {
  private readonly repo: Repo;
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly enforceContent: boolean;

  constructor(deps: ServiceDeps) {
    this.enforceContent = deps.enforceContent ?? true;
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
      history_note: input.history_note ?? null,
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
    content: Pick<LtcRecord, 'care_goal_id' | 'staff_id' | 'executed_content' | 'completion' | 'feedback' | 'quota_month'>,
  ): Promise<LtcRecord> {
    const enc = await this.mustGetEncounter(encounterId);
    this.assertEditable(enc);
    const cur = await this.repo.getByEncounter('ltc_records', encounterId);
    const t = this.now();
    const row: LtcRecord = {
      id: cur?.id ?? this.newId(),
      encounter_id: encounterId,
      ...content,
      staff_id: content.staff_id,
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
    if (this.enforceContent && cur.track === 'ltc') {
      const miss = ltcMissingFields(cur, await this.repo.getByEncounter('ltc_records', cur.id));
      if (miss.length > 0) throw new DomainError('incomplete', `簽章前請先填寫:${miss.join('、')}`);
    }
    if (this.enforceContent && cur.track === 'self_pay') {
      const missing = soapMissing(parseSoap(await this.repo.getByEncounter('soap_notes', cur.id)));
      if (missing.length > 0) throw new DomainError('incomplete', `簽章前請先填寫:${missing.join('、')}`);
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
      const lr = prev.track === 'ltc' ? await this.repo.getByEncounter('ltc_records', prev.id) : null;
      if (!lr || !canCorrect(lr.submission_status)) {
        throw new DomainError('conflict', '已送出申報的紀錄僅在狀態 1(待通知收件)可修正;狀態 2 之後須洽縣市承辦退件');
      }
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
      await acceptRowOrThrow(this.repo, 'ltc_records', { ...ltc, id: this.newId(), encounter_id: next.id, submission_status: 0, created_at: t, updated_at: t });
    }
    return next;
  }

  /** 某個案的所有服務紀錄(含歷史版本),依服務日期、版本排序。 */
  async listEncounters(patientId: string): Promise<Encounter[]> {
    const list = await this.repo.listEncountersByPatient(patientId);
    return list.sort((a, b) => b.service_date.localeCompare(a.service_date) || b.start_time.localeCompare(a.start_time) || b.version - a.version || b.created_at.localeCompare(a.created_at));
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

  // ───────────── 自費回診(快速模式) ─────────────

  /**
   * 開始一次自費回診:建立草稿並帶入上次治療的介入/觀察/HEP(複製上次治療)。
   * 沒有上次紀錄時為空白 SOAP。
   */
  async startVisit(input: Omit<NewEncounterInput, 'track'>): Promise<{ encounter: Encounter; soap: SoapNote; prefilled: boolean }> {
    const encounter = await this.createEncounter({ ...input, track: 'self_pay' });
    const prev = pickPreviousEncounter(await this.repo.listEncountersByPatient(input.patient_id), encounter.id);
    const prevNote = prev ? await this.repo.getByEncounter('soap_notes', prev.id) : null;
    const content = prevNote ? prefillFromPrevious(parseSoap(prevNote)) : emptySoap();
    const soap = await this.saveSoapNote(encounter.id, serializeSoap(content));
    return { encounter, soap, prefilled: prevNote !== null };
  }

  /** 儲存結構化 SOAP 內容 */
  saveSoapContent(encounterId: string, content: SoapContent): Promise<SoapNote> {
    return this.saveSoapNote(encounterId, serializeSoap(content));
  }

  /** 讀取結構化 SOAP 內容(無紀錄時回傳空白結構) */
  async getSoapContent(encounterId: string): Promise<SoapContent> {
    return parseSoap(await this.repo.getByEncounter('soap_notes', encounterId));
  }

  /** 該個案「上一次」自費紀錄的 SOAP 內容(供顯示上次數值對照) */
  async previousSoapContent(patientId: string, excludeEncounterId: string): Promise<{ encounter: Encounter; content: SoapContent } | null> {
    const prev = pickPreviousEncounter(await this.repo.listEncountersByPatient(patientId), excludeEncounterId);
    if (!prev) return null;
    return { encounter: prev, content: await this.getSoapContent(prev.id) };
  }

  // ───────────── 排程 ─────────────

  /** 新增行程。到宅地址預設帶入個案地址。 */
  async createAppointment(input: {
    patient_id: string;
    track: EncounterTrack;
    date: string;
    start: string;
    end: string;
    location_text?: string | null;
    note?: string | null;
  }): Promise<Appointment> {
    const patient = await this.mustGetPatient(input.patient_id);
    const t = this.now();
    const row: Appointment = {
      id: this.newId(),
      patient_id: input.patient_id,
      title: null,
      track: input.track,
      start_at: makeIso(input.date, input.start),
      end_at: makeIso(input.date, input.end),
      location_text: input.location_text === undefined ? patient.address : input.location_text,
      status: 'scheduled',
      encounter_id: null,
      note: input.note ?? null,
      created_at: t,
      updated_at: t,
    };
    await acceptRowOrThrow(this.repo, 'appointments', row);
    return row;
  }

  /** 修改行程(改期、改地點、指定個案…)。已連結服務紀錄的行程不可改個案。 */
  async updateAppointment(
    id: string,
    patch: { patient_id?: string | null; track?: EncounterTrack; date?: string; start?: string; end?: string; location_text?: string | null; note?: string | null },
  ): Promise<Appointment> {
    const cur = await this.mustGetAppointment(id);
    if (patch.patient_id !== undefined && patch.patient_id !== cur.patient_id && cur.encounter_id !== null) {
      throw new DomainError('conflict', '行程已開啟服務紀錄,不可更換個案');
    }
    const date = patch.date ?? dateOf(cur.start_at);
    const row: Appointment = {
      ...cur,
      patient_id: patch.patient_id === undefined ? cur.patient_id : patch.patient_id,
      track: patch.track ?? cur.track,
      start_at: makeIso(date, patch.start ?? timeOf(cur.start_at)),
      end_at: makeIso(date, patch.end ?? timeOf(cur.end_at)),
      location_text: patch.location_text === undefined ? cur.location_text : patch.location_text,
      note: patch.note === undefined ? cur.note : patch.note,
      updated_at: this.laterThan(cur.updated_at),
    };
    await acceptRowOrThrow(this.repo, 'appointments', row);
    return row;
  }

  async cancelAppointment(id: string): Promise<Appointment> {
    return this.setAppointmentStatus(id, 'cancelled');
  }

  async restoreAppointment(id: string): Promise<Appointment> {
    return this.setAppointmentStatus(id, 'scheduled');
  }

  private async setAppointmentStatus(id: string, status: Appointment['status']): Promise<Appointment> {
    const cur = await this.mustGetAppointment(id);
    if (cur.status === status) return cur;
    if (status === 'cancelled' && cur.encounter_id !== null) {
      throw new DomainError('conflict', '行程已開啟服務紀錄,不可取消(病歷依法保存)');
    }
    const row: Appointment = { ...cur, status, updated_at: this.laterThan(cur.updated_at) };
    await acceptRowOrThrow(this.repo, 'appointments', row);
    return row;
  }

  /** 日期區間(含)內的行程,含已取消者(由呼叫端決定是否顯示) */
  async listAppointments(fromDate: string, toDate: string): Promise<Appointment[]> {
    return (await this.repo.list('appointments'))
      .filter((a) => {
        const d = dateOf(a.start_at);
        return d >= fromDate && d <= toDate;
      })
      .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  }

  getAppointment(id: string): Promise<Appointment | null> {
    return this.repo.get('appointments', id);
  }

  /**
   * 從行程一鍵開啟服務紀錄:個案、軌別、日期、起訖時間自動帶入;自費走快速模式(帶入上次治療)。
   * 已開啟過則直接回傳既有紀錄,不會重複建立。
   */
  async startFromAppointment(id: string): Promise<{ encounter: Encounter; created: boolean; prefilled: boolean }> {
    const a = await this.mustGetAppointment(id);
    if (a.status === 'cancelled') throw new DomainError('conflict', '行程已取消');
    if (a.patient_id === null) throw new DomainError('conflict', '請先為此行程指定個案');
    if (a.encounter_id !== null) {
      const existing = await this.mustGetEncounter(a.encounter_id);
      return { encounter: existing, created: false, prefilled: false };
    }
    const base = { patient_id: a.patient_id, service_date: dateOf(a.start_at), start_time: timeOf(a.start_at), end_time: timeOf(a.end_at) };
    let encounter: Encounter;
    let prefilled = false;
    if (a.track === 'self_pay') {
      ({ encounter, prefilled } = await this.startVisit(base));
    } else {
      encounter = await this.createEncounter({ ...base, track: 'ltc', location: 'home' });
    }
    await acceptRowOrThrow(this.repo, 'appointments', { ...a, encounter_id: encounter.id, updated_at: this.laterThan(a.updated_at) });
    return { encounter, created: true, prefilled };
  }

  /** 某日行程(依時間排序,不含已取消) */
  async appointmentsOnDate(date: string): Promise<Appointment[]> {
    return appointmentsOn(await this.listAppointments(date, date), date);
  }

  // ───────────── LINE 外送 ─────────────

  /**
   * 排入一則 LINE 外送(離線也可排入,同步到 server 後由 server 送出)。
   * 到達/完成通知同一服務各只能有一則(失敗或略過者可重送)。
   */
  async queueLine(input: {
    patient_id: string;
    encounter_id?: string | null;
    appointment_id?: string | null;
    kind: LineMessageKind;
    items: Record<string, unknown>[];
    /** 幾分鐘內有效;逾時 server 不再送出 */
    expiresInMin?: number;
  }): Promise<LineMessage> {
    if (input.encounter_id && (input.kind === 'arrive' || input.kind === 'depart')) {
      const dup = (await this.listLineMessages(input.encounter_id)).find((m) => m.kind === input.kind && (m.status === 'queued' || m.status === 'sent'));
      if (dup) throw new DomainError('duplicate', input.kind === 'arrive' ? '已送出過「到達」通知' : '已送出過「完成」通知');
    }
    const t = this.now();
    const row: LineMessage = {
      id: this.newId(),
      patient_id: input.patient_id,
      encounter_id: input.encounter_id ?? null,
      appointment_id: input.appointment_id ?? null,
      kind: input.kind,
      payload: { items: input.items },
      expires_at: input.expiresInMin ? toTaipeiIso(new Date(Date.parse(t) + input.expiresInMin * 60_000)) : null,
      status: 'queued',
      status_detail: null,
      attempts: 0,
      sent_at: null,
      created_at: t,
      updated_at: t,
    };
    await acceptRowOrThrow(this.repo, 'line_messages', row);
    return row;
  }

  async listLineMessages(encounterId: string): Promise<LineMessage[]> {
    return (await this.repo.list('line_messages')).filter((m) => m.encounter_id === encounterId).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** 失敗/略過的訊息改回待送(已送出者不可重送) */
  async requeueLine(id: string): Promise<LineMessage> {
    const cur = await this.repo.get('line_messages', id);
    if (!cur) throw new DomainError('not_found', '找不到訊息');
    if (cur.status === 'sent') throw new DomainError('locked', '訊息已送出,不可重送');
    const row: LineMessage = { ...cur, status: 'queued', status_detail: null, attempts: 0, updated_at: this.laterThan(cur.updated_at) };
    await acceptRowOrThrow(this.repo, 'line_messages', row);
    return row;
  }

  /** 與某服務連結的行程(供通知關聯) */
  async appointmentForEncounter(encounterId: string): Promise<Appointment | null> {
    return (await this.repo.list('appointments')).find((a) => a.encounter_id === encounterId) ?? null;
  }

  /** 修改動作庫項目(例如維護示範影片網址) */
  async updateExercise(id: string, patch: Partial<Pick<Exercise, 'name' | 'video_ref' | 'region'>>): Promise<Exercise> {
    const cur = await this.repo.get('exercises', id);
    if (!cur) throw new DomainError('not_found', '找不到動作');
    const row: Exercise = { ...cur, ...patch, updated_at: this.laterThan(cur.updated_at) };
    await acceptRowOrThrow(this.repo, 'exercises', row);
    return row;
  }

  /**
   * 組出家屬版摘要所需資料:上次(日期早於本次者)SOAP、各測驗至本次為止的趨勢、目標、下次預約。
   */
  async familySummaryInput(encounterId: string): Promise<FamilyInput> {
    const enc = await this.mustGetEncounter(encounterId);
    const patient = await this.mustGetPatient(enc.patient_id);
    const content = await this.getSoapContent(encounterId);

    const all = await this.repo.listEncountersByPatient(enc.patient_id);
    const superseded = new Set(all.map((e) => e.supersedes_id).filter((x): x is string => x !== null));
    // 「上一次」:日期、開始時間較早者;同一時間點時以建立先後為準
    const key = (e: Encounter): string => `${e.service_date}T${e.start_time}|${e.created_at}`;
    const earlier = all
      .filter((e) => e.track === 'self_pay' && e.id !== enc.id && !superseded.has(e.id) && key(e) < key(enc))
      .sort((a, b) => key(b).localeCompare(key(a)));
    const prev = earlier[0] ? await this.getSoapContent(earlier[0].id) : null;

    const trends = new Map<string, TrendPt[]>();
    for (const m of content.objective.measures) {
      const pts = (await trendFor(this.repo, enc.patient_id, m.test_id)).filter((p) => p.date <= enc.service_date);
      trends.set(m.test_id, pts.slice(-5).map((p) => ({ date: p.date, value: p.value })));
    }

    const upcoming = (await this.listAppointments(enc.service_date, addDays(enc.service_date, 90)))
      .filter((a) => a.patient_id === enc.patient_id && a.status === 'scheduled' && a.encounter_id !== enc.id && Date.parse(a.start_at) > Date.parse(`${enc.service_date}T${enc.end_time}:00+08:00`))
      .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))[0];

    return {
      patientName: patient.name,
      serviceDate: enc.service_date,
      content,
      prev,
      tests: await this.listTests(),
      exercises: await this.listExercises(),
      goals: await this.listGoals(enc.patient_id),
      trends,
      nextAppointment: upcoming ? { date: dateOf(upcoming.start_at), time: timeOf(upcoming.start_at) } : null,
    };
  }

  // ───────────── 長照核銷 ─────────────

  /** 新增長照設定資料(特約、人員、計畫、額度、暫停);規則檢查與簽章資料相同,在 acceptRow 內 */
  async createLtc<K extends LtcTable>(table: K, data: Omit<TableRows[K], 'id' | 'created_at' | 'updated_at'>): Promise<TableRows[K]> {
    const t = this.now();
    const row = { ...data, id: this.newId(), created_at: t, updated_at: t } as unknown as TableRows[K];
    await acceptRowOrThrow(this.repo, table, row);
    return row;
  }

  async updateLtc<K extends LtcTable>(table: K, id: string, patch: Partial<Omit<TableRows[K], 'id' | 'created_at' | 'updated_at'>>): Promise<TableRows[K]> {
    const cur = await this.repo.get(table, id);
    if (!cur) throw new DomainError('not_found', '找不到資料');
    const row = { ...cur, ...patch, updated_at: this.laterThan((cur as { updated_at: string }).updated_at) } as unknown as TableRows[K];
    await acceptRowOrThrow(this.repo, table, row);
    return row;
  }

  listLtc<K extends LtcTable>(table: K): Promise<TableRows[K][]> {
    return this.repo.list(table);
  }

  /** 標記中途結案/移居(之後須在照管系統完成 FA400) */
  closePlan(planId: string, status: 'closed_early' | 'moved', closedAt: string): Promise<TableRows['ltc_plans']> {
    return this.updateLtc('ltc_plans', planId, { status, closed_at: closedAt });
  }

  /** 記錄已在照管系統完成 FA400 提前結案設定 */
  markFa400Done(planId: string, date: string): Promise<TableRows['ltc_plans']> {
    return this.updateLtc('ltc_plans', planId, { fa400_done_at: date });
  }

  /** 全部長照服務(各版本鏈只取最新版)與其申報紀錄 */
  async ltcItems(): Promise<LtcItem[]> {
    const all = await this.repo.list('encounters');
    const superseded = new Set(all.map((e) => e.supersedes_id).filter((x): x is string => x !== null));
    const items: LtcItem[] = [];
    for (const e of all) {
      if (e.track !== 'ltc' || superseded.has(e.id)) continue;
      items.push({ encounter: e, record: await this.repo.getByEncounter('ltc_records', e.id) });
    }
    return items.sort((a, b) => a.encounter.service_date.localeCompare(b.encounter.service_date) || a.encounter.start_time.localeCompare(b.encounter.start_time));
  }

  async ltcContext(): Promise<LtcContext> {
    return {
      contracts: await this.repo.list('ltc_contracts'),
      staff: await this.repo.list('ltc_staff'),
      plans: await this.repo.list('ltc_plans'),
      quotas: await this.repo.list('ltc_quotas'),
      suspensions: await this.repo.list('ltc_suspensions'),
      patients: await this.repo.list('patients'),
    };
  }

  /**
   * 核銷預檢:候選 = 已簽章、尚未送出的長照紀錄(最新版);已送出者計入額度與重複判斷。
   * encounterIds 有值時只檢查指定紀錄。
   */
  async runPrecheck(opts: { today?: string; encounterIds?: string[] } = {}): Promise<{ issues: PrecheckIssue[]; candidates: LtcItem[] }> {
    const items = await this.ltcItems();
    const ids = opts.encounterIds ? new Set(opts.encounterIds) : null;
    const all = items.filter((i) => i.encounter.status === 'signed');
    const submitted = items.filter((i) => i.encounter.status === 'submitted');
    // 額度與重複判斷一律以「全部待上傳紀錄」一起計算(依服務日期先後分配額度),再只回報被選取的那幾筆;
    // 否則單獨檢查第 3 筆時會漏算前兩筆而誤判通過
    const issues = precheck({ today: opts.today ?? todayTaipei(), candidates: all, submitted, context: await this.ltcContext() });
    return ids ? { issues: issues.filter((i) => i.encounter_id === null || ids.has(i.encounter_id)), candidates: all.filter((i) => ids.has(i.encounter.id)) } : { issues, candidates: all };
  }

  /**
   * 標記為「已上傳 FA100」:預檢有任何錯誤即拒絕(上傳後才發現錯誤,一筆就燒掉半天)。
   * 成功後服務狀態轉為 submitted,申報狀態從 0(待審核)開始追蹤。
   */
  async markSubmitted(encounterIds: string[], today?: string): Promise<Encounter[]> {
    const { issues, candidates } = await this.runPrecheck({ today, encounterIds });
    if (candidates.length !== encounterIds.length) throw new DomainError('conflict', '只有已簽章、尚未送出的長照紀錄可以上傳');
    const blocked = blockedIds(issues);
    if (blocked.size > 0) throw new DomainError('precheck_failed', `預檢未通過:${blocked.size} 筆有錯誤,請先修正再上傳`);
    const out: Encounter[] = [];
    for (const c of candidates) {
      const row: Encounter = { ...c.encounter, status: 'submitted', updated_at: this.laterThan(c.encounter.updated_at) };
      await acceptRowOrThrow(this.repo, 'encounters', row);
      out.push(row);
    }
    return out;
  }

  /** 記錄照管系統的申報狀態(0→…→6 只能前進一格;退件 2–5 → 1) */
  async advanceSubmission(encounterId: string, to: number): Promise<LtcRecord> {
    const enc = await this.mustGetEncounter(encounterId);
    const rec = await this.repo.getByEncounter('ltc_records', encounterId);
    if (!rec) throw new DomainError('not_found', '找不到長照申報紀錄');
    if (enc.status !== 'submitted') throw new DomainError('conflict', '請先送出申報,才能記錄申報狀態');
    if (!canTransition(rec.submission_status, to)) throw new DomainError('invalid', '申報狀態只能前進一格;退件(狀態 2–5)才可回到 1');
    const row: LtcRecord = { ...rec, submission_status: to, updated_at: this.laterThan(rec.updated_at) };
    await acceptRowOrThrow(this.repo, 'ltc_records', row);
    return row;
  }

  /** 預設申報年月:服務年月的次月 */
  defaultQuotaMonth(serviceDate: string): string {
    return nextMonth(monthOf(serviceDate));
  }

  // ───────────── 字典表、目標、常用清單 ─────────────

  /** 植入預設測驗庫與動作庫;已存在的項目(含使用者修改過的)不覆蓋。 */
  async seedDictionaries(): Promise<void> {
    for (const t of SEED_TESTS) if (!(await this.repo.get('tests', t.id))) await acceptRowOrThrow(this.repo, 'tests', t);
    for (const e of SEED_EXERCISES) if (!(await this.repo.get('exercises', e.id))) await acceptRowOrThrow(this.repo, 'exercises', e);
  }

  listTests(): Promise<TestDef[]> {
    return this.repo.list('tests').then((r) => r.sort((a, b) => a.code.localeCompare(b.code)));
  }

  listExercises(): Promise<Exercise[]> {
    return this.repo.list('exercises').then((r) => r.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')));
  }

  async createGoal(input: Pick<Goal, 'patient_id' | 'description'> & Partial<Pick<Goal, 'baseline_value' | 'target_value' | 'deadline' | 'test_id'>>): Promise<Goal> {
    const t = this.now();
    const row: Goal = {
      id: this.newId(),
      patient_id: input.patient_id,
      description: input.description,
      baseline_value: input.baseline_value ?? null,
      target_value: input.target_value ?? null,
      deadline: input.deadline ?? null,
      test_id: input.test_id ?? null,
      created_at: t,
      updated_at: t,
    };
    await acceptRowOrThrow(this.repo, 'goals', row);
    return row;
  }

  listGoals(patientId: string): Promise<Goal[]> {
    return this.repo.list('goals').then((r) => r.filter((g) => g.patient_id === patientId).sort((a, b) => a.created_at.localeCompare(b.created_at)));
  }

  /**
   * 加入/移出個人常用清單。同步協定不支援刪除,因此以固定 id + sort_order < 0 表示「已移出」,
   * 多台裝置對同一項目的操作以最後寫入為準。
   */
  async setFavorite(kind: Favorite['kind'], refId: string, on: boolean): Promise<void> {
    const id = `fav-${kind}-${refId}`;
    const cur = await this.repo.get('favorites', id);
    const t = this.now();
    if (!cur && !on) return;
    const active = (await this.listFavorites(kind)).length;
    const row: Favorite = {
      id,
      kind,
      ref_id: refId,
      sort_order: on ? (cur && cur.sort_order >= 0 ? cur.sort_order : active) : -1,
      created_at: cur?.created_at ?? t,
      updated_at: cur ? this.laterThan(cur.updated_at) : t,
    };
    await acceptRowOrThrow(this.repo, 'favorites', row);
  }

  /** 個人常用清單(依排序),僅含啟用中的項目 */
  async listFavorites(kind: Favorite['kind']): Promise<Favorite[]> {
    return (await this.repo.list('favorites')).filter((f) => f.kind === kind && f.sort_order >= 0).sort((a, b) => a.sort_order - b.sort_order);
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

  private async mustGetAppointment(id: string): Promise<Appointment> {
    const a = await this.repo.get('appointments', id);
    if (!a) throw new DomainError('not_found', '找不到行程');
    return a;
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
