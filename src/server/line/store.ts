// LINE 綁定資料(僅存 server):綁定碼、LINE 使用者與個案的對應、已送出紀錄。
// LINE user id 屬識別資料,不隨同步下發到裝置。
import { randomInt, randomUUID } from 'node:crypto';
import type { SqliteRepo } from '../db';

export type LinkRole = 'family' | 'patient';

export interface LineLink {
  id: string;
  patient_id: string;
  line_user_id: string;
  role: LinkRole;
  status: 'active' | 'revoked';
  bound_at: string;
  revoked_at: string | null;
}

/** 提供給 UI 的版本:不含 LINE user id */
export type LineLinkPublic = Omit<LineLink, 'line_user_id'>;

export type ConsumeResult =
  | { ok: true; patientId: string; role: LinkRole }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'locked' };

const CODE_TTL_MS = 48 * 3600_000;
const MAX_FAILS = 5;
const LOCK_MS = 3600_000;

export class LineStore {
  private fails = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly repo: SqliteRepo,
    private readonly nowMs: () => number = Date.now,
  ) {}

  private get db() {
    return this.repo.db;
  }

  /** 產生 6 位數綁定碼(48 小時內有效、單次使用) */
  createBindCode(patientId: string, role: LinkRole, nowIso: string): { code: string; expires_at: string } {
    const expires = new Date(this.nowMs() + CODE_TTL_MS);
    for (let i = 0; i < 20; i++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const exists = this.db.prepare('SELECT 1 FROM line_bind_codes WHERE code = ? AND used_at IS NULL AND expires_at > ?').get(code, nowIso);
      if (exists) continue;
      this.db.prepare('INSERT OR REPLACE INTO line_bind_codes (code, patient_id, role, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)').run(code, patientId, role, expires.toISOString());
      return { code, expires_at: expires.toISOString() };
    }
    throw new Error('無法產生綁定碼');
  }

  /** 以綁定碼綁定。連續輸錯 5 次鎖定該 LINE 使用者 1 小時(防暴力猜碼)。 */
  consumeCode(code: string, lineUserId: string, nowIso: string): ConsumeResult {
    const f = this.fails.get(lineUserId);
    if (f && f.until > this.nowMs()) return { ok: false, reason: 'locked' };
    const row = this.db.prepare('SELECT * FROM line_bind_codes WHERE code = ?').get(code) as { patient_id: string; role: LinkRole; expires_at: string; used_at: string | null } | undefined;
    const fail = (reason: 'invalid' | 'expired' | 'used'): ConsumeResult => {
      const c = (f && f.until > this.nowMs() ? 0 : (f?.count ?? 0)) + 1;
      this.fails.set(lineUserId, { count: c, until: c >= MAX_FAILS ? this.nowMs() + LOCK_MS : 0 });
      return { ok: false, reason };
    };
    if (!row) return fail('invalid');
    if (row.used_at) return fail('used');
    if (Date.parse(row.expires_at) < this.nowMs()) return fail('expired');

    this.db.prepare('UPDATE line_bind_codes SET used_at = ? WHERE code = ?').run(nowIso, code);
    this.fails.delete(lineUserId);
    const existing = this.db.prepare('SELECT id FROM line_links WHERE patient_id = ? AND line_user_id = ?').get(row.patient_id, lineUserId) as { id: string } | undefined;
    if (existing) {
      this.db.prepare("UPDATE line_links SET status = 'active', role = ?, bound_at = ?, revoked_at = NULL WHERE id = ?").run(row.role, nowIso, existing.id);
    } else {
      this.db.prepare("INSERT INTO line_links (id, patient_id, line_user_id, role, status, bound_at) VALUES (?, ?, ?, ?, 'active', ?)").run(randomUUID(), row.patient_id, lineUserId, row.role, nowIso);
    }
    return { ok: true, patientId: row.patient_id, role: row.role };
  }

  /** 某個案目前有效的收件者(LINE user id) */
  activeRecipients(patientId: string): string[] {
    return (this.db.prepare("SELECT line_user_id FROM line_links WHERE patient_id = ? AND status = 'active'").all(patientId) as { line_user_id: string }[]).map((r) => r.line_user_id);
  }

  listLinks(patientId: string): LineLinkPublic[] {
    return (this.db.prepare('SELECT id, patient_id, role, status, bound_at, revoked_at FROM line_links WHERE patient_id = ? ORDER BY bound_at').all(patientId) as unknown as LineLinkPublic[]);
  }

  /** 治療師端解除單一綁定 */
  revokeLink(id: string, nowIso: string): boolean {
    const r = this.db.prepare("UPDATE line_links SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'").run(nowIso, id);
    return Number(r.changes) > 0;
  }

  /** 使用者自己取消(回覆「停止」、封鎖、取消好友):解除該 LINE 使用者的所有綁定 */
  revokeUser(lineUserId: string, nowIso: string): number {
    const r = this.db.prepare("UPDATE line_links SET status = 'revoked', revoked_at = ? WHERE line_user_id = ? AND status = 'active'").run(nowIso, lineUserId);
    return Number(r.changes);
  }

  // ── 冪等紀錄 ──

  /** 嘗試記下 key;已存在回傳 false(代表先前做過) */
  claimKey(key: string, nowIso: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO line_sent_keys (key, sent_at) VALUES (?, ?)').run(key, nowIso);
    return Number(r.changes) > 0;
  }

  hasKey(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM line_sent_keys WHERE key = ?').get(key) !== undefined;
  }
}
