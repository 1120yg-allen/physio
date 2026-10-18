# 居家物理治療臨床管理系統

Local-first PWA:資料存在你自己的裝置(IndexedDB)與自己的機器(SQLite),不經第三方雲。
規格見 [`build-spec/`](build-spec/)(動手前先讀 `CLAUDE.md`、`SPEC.md`)。

**目前進度:P0(資料層)、P1(自費 SOAP)、P2(排程與行事曆)完成;P1 待驗收,P2 的 Google 同步待你用真實帳號驗證。**

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

## P1 使用說明

- 個案頁 → **▶ 開始自費回診**:第一次為完整模式;之後自動進快速模式,並帶入上次的介入清單、觀察與居家運動處方(不帶舊的測驗值、主訴、NPRS)。
- 快速模式只顯示 S/O/A/P 的核心欄位;完整模式顯示 `SPEC §2.3` 全部欄位。兩者共用同一份資料,可隨時切換。
- 語音輸入:點 iPad 鍵盤上的麥克風(iOS 裝置端聽寫,不經雲端)。
- 常用清單:介入/測驗列上的 ☆ 加入後,會置頂成按鈕。
- 簽章條件:有主訴、O 段至少一項(介入/測驗/觀察)、結束時間晚於開始時間。時間卡片有「30/45/60 分鐘」一鍵設定。
- 90 秒實測:從按下「開始自費回診」到簽章的秒數會記在本機(只存秒數,不含個案資料),個案列表頁顯示最近 10 次快速模式平均。
- 測驗庫的常模/切點為文獻參考值,**尚未經臨床審閱**,請核對 `src/shared/seed.ts` 內的來源;系統只列出數字,不做異常判定。

## P2 排程與 Google 行事曆

**排程**(頂端「排程」分頁):日/週檢視,每筆行程顯示時段、個案、地址、軌別與紀錄狀態。
- 「▶ 開始服務」:一鍵開啟該次服務紀錄,個案、軌別、日期、起訖時間自動帶入;自費走快速模式(帶入上次治療)。重複按只會開啟既有紀錄,不會重複建立。
- 已開啟紀錄的行程不可取消(病歷依法保存)。取消的行程以「已取消」保留,不刪除。
- 同日有 2 個以上行程時,顯示**地址排序提示**(縣市 → 區 → 路 → 門牌)。僅供參考,不是路線規劃。
- 時間重疊的行程會標示警示。

**Google 行事曆雙向同步**(預設關閉,需一次性設定;資料只在你的電腦與你的 Google 帳號之間流動):

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案 → 啟用「Google Calendar API」→「OAuth 同意畫面」(外部、測試中,把你自己的 Gmail 加為測試使用者)→「憑證」建立 **OAuth 用戶端 ID,類型選「電腦版應用程式」**。
2. 設定環境變數後授權(會開出網址,用瀏覽器同意;並自動建立專用行事曆「居家物治排程」):
   ```bash
   export GCAL_CLIENT_ID=你的用戶端ID
   export GCAL_CLIENT_SECRET=你的用戶端密鑰
   npm run gcal:auth
   npm start        # 之後每次啟動都要帶上述兩個環境變數
   ```
3. 啟動後每 5 分鐘自動同步,裝置送來行程變更時也會立即同步;排程頁可按「立即同步 Google」。iPhone 把該 Google 帳號加入行事曆,即可在 Apple 行事曆看到。

同步規則:
- 只同步專用行事曆,**讀不到你其他行事曆**(授權範圍僅 `calendar.app.created`)。授權檔 `gcal-token.json` 在資料目錄內,權限 600。
- **隱私預設為最小**:Google 上只出現「王○○・自費」與時段,**不含地址與備註**。要送完整姓名/地址/備註,設 `GCAL_PRIVACY=full`——這會讓個資存放在 Google 雲端,請自行評估(CLAUDE.md C1)。
- 不重複:事件 id 由行程 id 決定;改期、取消、恢復都更新同一筆事件。
- 衝突(兩邊都改過):以較晚的修改為準。
- 在 Google 上新增的事件會變成「未指定個案」的行程,指定個案後才能開服務紀錄。全天事件略過。
- 在 Google 上刪除已開啟服務紀錄的行程:本機行程保留並顯示警示。

## 與規格的差異(基礎設施用,不改變規格欄位語意)

- `encounters`、`soap_notes`、`ltc_records` 與字典表額外加 `created_at` / `updated_at`(同步與版本時間戳需要)
- `soap_notes`、`ltc_records` 加 `encounter_id`(實現「1:1 對應 Encounter」)
- 新增 `appointments` 表(排程;SPEC §5 需要但 §2 未定義);Google 對應資料另存 server 端 `gcal_map`,不隨同步下發
- `exercises` 加 `category`(介入類別:徒手/運動/功能性/衛教)
- SPEC §2.3 的 `npre` 視為 `nprs` 之筆誤
- 常用清單以固定 id + `sort_order < 0` 表示移出(同步協定不支援刪除)
- `favorites` 加 `kind` / `ref_id` / `sort_order`;`goals` 具體欄位依 SPEC §2.5 的描述展開
- 各表加內部欄位 `server_seq`(僅 server 端,同步游標用)
