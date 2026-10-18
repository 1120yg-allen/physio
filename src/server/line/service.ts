// LINE 整合的執行管理:設定載入、外送佇列、提醒排程、綁定碼與 webhook。
// 狀態與錯誤只含統計與通用說明,不含個案資料。
import { nowTaipei } from '../../shared/time';
import type { SqliteRepo } from '../db';
import { HttpLineApi, type LineApi } from './api';
import { drainOutbox, type DrainResult } from './outbox';
import { enqueueReminders } from './reminders';
import { LineStore, type LineLinkPublic, type LinkRole } from './store';
import { handleWebhook } from './webhook';
import { DomainError } from '../../shared/validate';

export interface LineOptions {
  clinicName: string;
  contact: string | null;
  reminderHour: number;
}

export interface LineStatus {
  enabled: boolean;
  reason?: string;
  clinic_name: string;
  reminder_hour: number;
  running: boolean;
  last_drain: DrainResult | null;
  last_error: string | null;
}

export class LineService {
  readonly store: LineStore;
  private running = false;
  private lastDrain: DrainResult | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly repo: SqliteRepo,
    private readonly api: LineApi | null,
    private readonly channelSecret: string | null,
    private readonly opts: LineOptions,
    private readonly disabledReason?: string,
    private readonly now: () => string = nowTaipei,
  ) {
    this.store = new LineStore(repo);
  }

  get enabled(): boolean {
    return this.api !== null && this.channelSecret !== null;
  }

  status(): LineStatus {
    return {
      enabled: this.enabled,
      ...(this.enabled || !this.disabledReason ? {} : { reason: this.disabledReason }),
      clinic_name: this.opts.clinicName,
      reminder_hour: this.opts.reminderHour,
      running: this.running,
      last_drain: this.lastDrain,
      last_error: this.lastError,
    };
  }

  /** 處理外送佇列(不重疊執行) */
  async drain(): Promise<LineStatus> {
    if (!this.api || this.running) return this.status();
    this.running = true;
    try {
      this.lastDrain = await drainOutbox({ repo: this.repo, store: this.store, api: this.api, now: this.now });
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : '未知錯誤';
    } finally {
      this.running = false;
    }
    return this.status();
  }

  /** 排入應發送的提醒,然後處理佇列 */
  async tick(): Promise<void> {
    if (!this.enabled) return;
    try {
      await enqueueReminders({ repo: this.repo, store: this.store, now: this.now, clinicName: this.opts.clinicName, contact: this.opts.contact, hour: this.opts.reminderHour });
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : '未知錯誤';
    }
    await this.drain();
  }

  start(intervalMs = 10 * 60_000): () => void {
    if (!this.enabled) return () => undefined;
    void this.tick();
    const t = setInterval(() => void this.tick(), intervalMs);
    t.unref();
    return () => clearInterval(t);
  }

  async createBindCode(patientId: string, role: LinkRole): Promise<{ code: string; expires_at: string }> {
    if (!(await this.repo.get('patients', patientId))) throw new DomainError('not_found', '找不到個案');
    return this.store.createBindCode(patientId, role, this.now());
  }

  links(patientId: string): LineLinkPublic[] {
    return this.store.listLinks(patientId);
  }

  unlink(id: string): boolean {
    return this.store.revokeLink(id, this.now());
  }

  /** webhook 入口(由獨立埠呼叫) */
  async webhook(raw: Buffer, signature: string | undefined): Promise<{ status: number }> {
    if (!this.api || !this.channelSecret) return { status: 503 };
    return handleWebhook(
      { repo: this.repo, store: this.store, api: this.api, channelSecret: this.channelSecret, clinicName: this.opts.clinicName, now: this.now, onBound: () => void this.tick() },
      raw,
      signature,
    );
  }
}

/** 提醒時刻(0–23 的整數);未設定或不合法時預設 18。注意 0 是合法值(午夜起即可發送)。 */
export function parseHour(v: string | undefined): number {
  if (v === undefined || v.trim() === '') return 18;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 18;
}

export function createLineService(repo: SqliteRepo, env: NodeJS.ProcessEnv = process.env): LineService {
  const opts: LineOptions = {
    clinicName: env.LINE_CLINIC_NAME ?? '居家物理治療',
    contact: env.LINE_CONTACT ?? null,
    reminderHour: parseHour(env.LINE_REMINDER_HOUR),
  };
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  const secret = env.LINE_CHANNEL_SECRET;
  if (!token || !secret) return new LineService(repo, null, null, opts, '尚未設定 LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET(見 README「LINE」)');
  return new LineService(repo, new HttpLineApi(token, fetch, env.LINE_API_BASE ?? 'https://api.line.me'), secret, opts);
}
