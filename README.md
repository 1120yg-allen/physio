# 居家物理治療臨床管理系統

Local-first PWA:資料存在你自己的裝置(IndexedDB)與自己的機器(SQLite),不經第三方雲。
規格見 [`build-spec/`](build-spec/)(動手前先讀 `CLAUDE.md`、`SPEC.md`)。

**目前進度:P0 完成(專案骨架與資料層),等待驗收。**

## 啟動

需要 Node.js 22.13 以上。

```bash
npm install
npm run build      # 建置前端
npm start          # 啟動服務 → http://127.0.0.1:8787
```

開發模式(前端熱更新):`npm run dev` → http://127.0.0.1:5173

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `8787` | 服務埠 |
| `HOST` | `127.0.0.1` | 只聽本機。經 Tailscale 存取時設 `0.0.0.0`,**且不要對公網開放** |
| `PHYSIO_DATA_DIR` | `data` | 資料庫所在目錄(請放在加密磁碟) |
| `PHYSIO_DB` | `data/physio.sqlite` | 資料庫檔案 |
| `PHYSIO_BACKUP_DIR` | `data/backups` | 備份目錄(建議指向 NAS) |

**安裝到 iPad 主畫面:** 用 Safari 開啟網址 → 分享 → 加入主畫面。第一次需連線載入一次,之後飛航模式也能開啟與寫紀錄。
(iOS 的 PWA 需要 HTTPS 或 localhost 才能註冊離線功能;經 Tailscale 存取時可用 `tailscale serve` 取得 HTTPS。)

## 備份與還原

- 服務啟動後每日自動備份一次(台北時區),同日不重複、不覆蓋、**不自動刪除舊備份**(病歷法定保存十年)。
- 手動備份:`npm run backup`
- 還原(先停止服務):`npm run restore -- data/backups/physio-2026-10-18.sqlite`
  還原前會驗證備份檔完整性,並把現有資料庫另存為 `physio.sqlite.before-restore-<時間>`,不覆蓋。
- 單一 NAS 不能是唯一備份,請另外保留異地或離線副本。

## 測試

```bash
npm test           # 資料層、版本/簽章、離線同步、備份還原
npm run typecheck
```

## 架構重點

| 位置 | 說明 |
|---|---|
| `src/shared/schema.ts` | SPEC §2 資料表定義(單一來源,SQLite 與 IndexedDB 皆由此產生) |
| `src/shared/rules.ts` | 寫入規則:簽章後鎖定、版本鏈不分叉、自費/長照隔離。**server 與 client 共用同一份** |
| `src/shared/service.ts` | 個案 CRUD、服務紀錄、簽章、建立新版本 |
| `src/server/db.ts` | SQLite + migration;資料庫觸發器作為第二道防線(簽章後無法 UPDATE、病歷不可 DELETE) |
| `src/client/idb.ts` / `sync.ts` | 本機儲存與同步;資料與待同步佇列同一交易寫入 |

## 與規格的差異(基礎設施用,不改變規格欄位語意)

- `encounters`、`soap_notes`、`ltc_records` 與字典表額外加 `created_at` / `updated_at`(同步與版本時間戳需要)
- `soap_notes`、`ltc_records` 加 `encounter_id`(實現「1:1 對應 Encounter」)
- `favorites` 加 `kind` / `ref_id` / `sort_order`;`goals` 具體欄位依 SPEC §2.5 的描述展開
- 各表加內部欄位 `server_seq`(僅 server 端,同步游標用)
