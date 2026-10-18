// Google 行事曆同步的執行管理:設定載入、防止重疊執行、定時與手動觸發、狀態回報。
// 狀態與錯誤訊息只含統計與通用說明,不含個案資料。
import { randomUUID } from 'node:crypto';
import { nowTaipei } from '../../shared/time';
import type { SqliteRepo } from '../db';
import { accessTokenProvider, clientFromEnv, gcalFiles, readConfig, readRefreshToken } from './auth';
import { GoogleCalendarApi } from './google';
import type { PrivacyLevel } from './privacy';
import { runGcalSync, type GcalResult } from './sync';
import type { CalendarApi } from './types';

export interface GcalStatus {
  enabled: boolean;
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

  constructor(
    private readonly repo: SqliteRepo,
    private readonly api: CalendarApi | null,
    private readonly privacy: PrivacyLevel,
    private readonly disabledReason?: string,
  ) {}

  status(): GcalStatus {
    return {
      enabled: this.api !== null,
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

  /** 定時同步(預設每 5 分鐘)。啟動時先跑一次。 */
  start(intervalMs = 5 * 60_000): () => void {
    if (!this.api) return () => undefined;
    void this.run();
    const t = setInterval(() => void this.run(), intervalMs);
    t.unref();
    return () => clearInterval(t);
  }
}

/** 依環境變數與資料目錄內的設定檔建立服務;條件不足時回傳停用狀態與設定提示。 */
export function createGcalService(repo: SqliteRepo, dataDir: string, env: NodeJS.ProcessEnv = process.env): GcalService {
  const privacy: PrivacyLevel = env.GCAL_PRIVACY === 'full' ? 'full' : 'minimal';
  const creds = clientFromEnv(env);
  if (!creds) return new GcalService(repo, null, privacy, '尚未設定 GCAL_CLIENT_ID / GCAL_CLIENT_SECRET(見 README「Google 行事曆」)');
  const files = gcalFiles(dataDir);
  const refresh = readRefreshToken(files);
  const cfg = readConfig(files);
  if (!refresh || !cfg) return new GcalService(repo, null, privacy, '尚未授權,請執行 npm run gcal:auth');
  return new GcalService(repo, new GoogleCalendarApi(cfg.calendar_id, accessTokenProvider(creds, refresh)), privacy);
}
