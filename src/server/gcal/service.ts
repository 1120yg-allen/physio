// Google 行事曆同步的執行管理:設定載入、防止重疊執行、定時與手動觸發、狀態回報。
// 狀態與錯誤訊息只含統計與通用說明,不含個案資料。
import { randomUUID } from 'node:crypto';
import { nowTaipei } from '../../shared/time';
import type { SqliteRepo } from '../db';
import { accessTokenProvider, buildAuthUrl, clearAuthorization, createDedicatedCalendar, exchangeCode, gcalFiles, newPkce, readConfig, readRefreshToken, resolveClient, saveClientFile, saveConfig, saveRefreshToken, type GcalFiles, type Pkce } from './auth';
import { GoogleCalendarApi, type FetchFn } from './google';
import type { PrivacyLevel } from './privacy';
import { runGcalSync, type GcalResult } from './sync';
import { DomainError } from '../../shared/validate';
import type { CalendarApi } from './types';

/** 畫面上設定與連結 Google 所需的環境(檔案位置、環境變數、可注入的 fetch) */
export interface GcalSetup {
  files: GcalFiles;
  env: NodeJS.ProcessEnv;
  fetchFn?: FetchFn;
}

export interface GcalStatus {
  enabled: boolean;
  /** 是否支援在畫面上設定/連結(有資料目錄) */
  setup_available: boolean;
  /** 已有 OAuth 用戶端 ID/密鑰(環境變數或畫面儲存) */
  client_configured: boolean;
  /** 已完成 Google 授權並有專用行事曆 */
  authorized: boolean;
  /** 未啟用時的原因(給使用者看的設定提示) */
  reason?: string;
  privacy: PrivacyLevel;
  running: boolean;
  last_run_at: string | null;
  last_ok: boolean | null;
  last_error: string | null;
  last_result: GcalResult | null;
}

export class GcalService {
  private running = false;
  private last: { at: string; ok: boolean; error: string | null; result: GcalResult | null } | null = null;
  private pending = new Map<string, { pkce: Pkce; redirect: string; at: number }>();

  constructor(
    private readonly repo: SqliteRepo,
    private api: CalendarApi | null,
    private readonly privacy: PrivacyLevel,
    private disabledReason?: string,
    private readonly setup?: GcalSetup,
  ) {}

  status(): GcalStatus {
    const creds = this.setup ? resolveClient(this.setup.files, this.setup.env) : null;
    const authorized = this.setup ? readRefreshToken(this.setup.files) !== null && readConfig(this.setup.files) !== null : this.api !== null;
    return {
      enabled: this.api !== null,
      setup_available: this.setup !== undefined,
      client_configured: creds !== null,
      authorized,
      ...(this.api === null && this.disabledReason ? { reason: this.disabledReason } : {}),
      privacy: this.privacy,
      running: this.running,
      last_run_at: this.last?.at ?? null,
      last_ok: this.last?.ok ?? null,
      last_error: this.last?.error ?? null,
      last_result: this.last?.result ?? null,
    };
  }

  /** 執行一次同步。已在執行中則直接回傳目前狀態(不重疊)。 */
  async run(): Promise<GcalStatus> {
    if (!this.api || this.running) return this.status();
    this.running = true;
    try {
      const result = await runGcalSync({ repo: this.repo, api: this.api, privacy: this.privacy, now: nowTaipei, newId: randomUUID });
      this.last = { at: nowTaipei(), ok: true, error: null, result };
    } catch (e) {
      // 只記錄錯誤類型/狀態碼;訊息來自我們自己的 GoogleApiError,不含回應本文
      this.last = { at: nowTaipei(), ok: false, error: e instanceof Error ? e.message : '未知錯誤', result: null };
    } finally {
      this.running = false;
    }
    return this.status();
  }

  // ───────────── 在畫面上設定與連結 Google ─────────────

  private requireSetup(): GcalSetup {
    if (!this.setup) throw new DomainError('bad_request', '此環境不支援在畫面上設定 Google 行事曆');
    return this.setup;
  }

  /** 重新讀取設定檔並建立 API(設定、連結、中斷後呼叫) */
  reload(): void {
    const { api, reason } = buildApi(this.requireSetup());
    this.api = api;
    this.disabledReason = reason;
  }

  /** 儲存 OAuth 用戶端 ID/密鑰(存在資料目錄,權限 600) */
  saveClient(clientId: string, clientSecret: string): void {
    const setup = this.requireSetup();
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!id || !secret) throw new DomainError('bad_request', '請填寫用戶端 ID 與用戶端密鑰');
    if (/\s/.test(id) || /\s/.test(secret)) throw new DomainError('bad_request', '用戶端 ID 或密鑰含有空白,請重新複製貼上');
    if (!id.endsWith('.apps.googleusercontent.com')) throw new DomainError('bad_request', '用戶端 ID 格式不對(應以 .apps.googleusercontent.com 結尾)');
    saveClientFile(setup.files, { clientId: id, clientSecret: secret });
    this.reload();
  }

  /**
   * 開始連結:回傳要導向的 Google 授權網址。
   * 回呼網址必須是本機(127.0.0.1 / localhost),因此必須在跑伺服器的那台電腦上操作。
   */
  connectStart(host: string | undefined): string {
    const setup = this.requireSetup();
    const creds = resolveClient(setup.files, setup.env);
    if (!creds) throw new DomainError('bad_request', '請先儲存 Google 用戶端 ID 與密鑰');
    const hostname = (host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
      throw new DomainError('bad_request', '請在執行伺服器的那台電腦上、用 http://127.0.0.1:埠號 開啟本系統再連結 Google(從其他裝置無法完成授權)');
    }
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.at > 10 * 60_000) this.pending.delete(k);
    if (this.pending.size >= 5) this.pending.clear();
    const pkce = newPkce();
    const redirect = `http://${host}/api/gcal/callback`;
    this.pending.set(pkce.state, { pkce, redirect, at: now });
    return buildAuthUrl(creds, redirect, pkce);
  }

  /** Google 導回後完成連結:換取授權、建立專用行事曆、立即開始同步 */
  async connectFinish(code: string, state: string): Promise<void> {
    const setup = this.requireSetup();
    const p = this.pending.get(state);
    if (!p || Date.now() - p.at > 10 * 60_000) throw new DomainError('bad_request', '連結已逾時或不正確,請回到系統重新按「連結 Google 帳號」');
    this.pending.delete(state);
    const creds = resolveClient(setup.files, setup.env);
    if (!creds) throw new DomainError('bad_request', '找不到 Google 用戶端設定');
    const refresh = await exchangeCode(creds, code, p.pkce.verifier, p.redirect, setup.fetchFn);
    saveRefreshToken(setup.files, refresh);
    if (!readConfig(setup.files)) {
      const id = await createDedicatedCalendar(accessTokenProvider(creds, refresh, setup.fetchFn), '居家物治排程', setup.fetchFn);
      saveConfig(setup.files, { calendar_id: id });
    }
    this.reload();
    void this.run();
  }

  /** 中斷連結:刪除授權(Google 上的專用行事曆與事件保留,可在 Google 行事曆自行刪除) */
  disconnect(): void {
    clearAuthorization(this.requireSetup().files);
    this.reload();
    this.last = null;
  }

  /** 定時同步(預設每 5 分鐘)。啟動時先跑一次。 */
  start(intervalMs = 5 * 60_000): () => void {
    void this.run();
    // 即使目前未啟用也保留計時器:之後在畫面上完成連結即可自動開始同步
    const t = setInterval(() => void this.run(), intervalMs);
    t.unref();
    return () => clearInterval(t);
  }
}

/** 依設定檔建立 API;條件不足時回傳停用原因 */
function buildApi(setup: GcalSetup): { api: CalendarApi | null; reason?: string } {
  const creds = resolveClient(setup.files, setup.env);
  if (!creds) return { api: null, reason: '尚未設定 Google 用戶端 ID 與密鑰' };
  const refresh = readRefreshToken(setup.files);
  const cfg = readConfig(setup.files);
  if (!refresh || !cfg) return { api: null, reason: '尚未連結 Google 帳號' };
  return { api: new GoogleCalendarApi(cfg.calendar_id, accessTokenProvider(creds, refresh, setup.fetchFn), setup.fetchFn) };
}

/** 依環境變數與資料目錄內的設定檔建立服務;條件不足時為停用狀態,可之後在畫面上設定並連結。 */
export function createGcalService(repo: SqliteRepo, dataDir: string, env: NodeJS.ProcessEnv = process.env, fetchFn?: FetchFn): GcalService {
  const privacy: PrivacyLevel = env.GCAL_PRIVACY === 'full' ? 'full' : 'minimal';
  const setup: GcalSetup = { files: gcalFiles(dataDir), env, fetchFn };
  const { api, reason } = buildApi(setup);
  return new GcalService(repo, api, privacy, reason, setup);
}
