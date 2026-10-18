# 居家物理治療臨床管理系統

Local-first PWA:資料存在你自己的裝置(IndexedDB)與自己的機器(SQLite),不經第三方雲。
規格見 [`build-spec/`](build-spec/)(動手前先讀 `CLAUDE.md`、`SPEC.md`)。

**目前進度:P0–P2、P4 完成。P1 待驗收;P2 的 Google 同步、P4 的 LINE 待你用真實帳號驗證。P3(長照核銷)依 Q4 決定是否做。**

## 啟動

需要 Node.js 22.13 以上(到 [nodejs.org](https://nodejs.org) 安裝 LTS 版本)。

```bash
git clone https://github.com/1120yg-allen/physio
cd physio
npm install      # 只需第一次
npm start        # 第一次會自動建置前端,然後啟動
```

看到「啟動後請用瀏覽器開啟:http://127.0.0.1:8787」就用**同一台電腦**的瀏覽器開啟該網址。關閉請在終端機按 Ctrl+C。

> **網頁打不開?** 依序檢查:
> 1. 終端機有沒有出現錯誤?(「需要 Node.js 22.13 以上」→ 升級 Node;「尚未安裝相依套件」→ 先 `npm install`)
> 2. 網址要用 `http://127.0.0.1:8787`(不是 https)。服務只聽本機,**從其他裝置(iPad、手機)連不到**,要連請見下方 `HOST` 與 Tailscale 說明。
> 3. 8787 埠被佔用 → `PORT=8800 npm start` 換一個埠。
> 4. 看到「系統已啟動,但還沒有網頁畫面」→ 執行 `npm run build` 後重新整理。
> 5. 網頁在 Claude 雲端工作階段裡跑時,你自己電腦的瀏覽器**無法**連到它(那是雲端容器內的 localhost);請在自己的電腦上執行。

開發模式(前端熱更新):`npm run dev` → http://127.0.0.1:5173

### 用 GitHub Pages 開啟「純本機版」(不需要安裝任何東西)

網址:`https://<你的帳號>.github.io/physio/`。這是**只有網頁、沒有伺服器**的版本:

| | 純本機版(GitHub Pages) | 完整版(`npm start`) |
|---|---|---|
| 個案、SOAP、排程、趨勢圖 | ✅ | ✅ |
| 離線使用、安裝到 iPad 主畫面(HTTPS) | ✅ | 需 Tailscale HTTPS |
| 資料存放 | **只在這個瀏覽器** | 你電腦的 SQLite + 每日備份 |
| 多裝置同步 | ❌ | ✅ |
| LINE、Google 行事曆 | ❌ | ✅ |

⚠ 純本機版的資料**只存在瀏覽器**:清除瀏覽資料、換瀏覽器或換裝置就看不到,而且沒有自動備份。請定期到「備份與還原」**下載備份檔**(內含全部個案資料,請妥善保管,不要放到公開處)。正式使用建議用完整版。

設定方式(二選一,都已支援):
- **Settings → Pages → Branch: `main`、資料夾 `/docs`**(建議,網址最短)。
- 或維持發布「根目錄」:根目錄的 `index.html` 會自動導向 `./docs/`。

更新純本機版:`npm run build:pages`,把 `docs/` 一起提交並推送。

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

**Google 行事曆雙向同步**(預設關閉;資料只在你的電腦與你的 Google 帳號之間流動)。**全部在畫面上操作,不用打指令:**

1. 在**執行伺服器的那台電腦**上,用瀏覽器開 `http://127.0.0.1:8787` → 上方「排程」分頁 → 「Google 行事曆」卡片。
2. 第一次需要 Google 的「用戶端 ID」與「密鑰」(卡片裡有逐步說明,約 5 分鐘):到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案 → 啟用 Google Calendar API →「OAuth 同意畫面」(外部、測試中,把你自己的 Gmail 加為測試使用者)→「憑證」建立 **OAuth 用戶端 ID,類型選「電腦版應用程式」**。把 ID 與密鑰貼到卡片並按「儲存」。
3. 按 **「🔗 連結 Google 帳號」** → 前往 Google 登入並同意 → 自動導回並建立專用行事曆「居家物治排程」,隨即開始同步。
4. 之後每 5 分鐘自動同步,裝置送來行程變更時也會立即同步;卡片上有「立即同步 Google」與「中斷連結」。iPhone 把該 Google 帳號加入行事曆,即可在 Apple 行事曆看到。

> Google 授權只能在**跑伺服器的那台電腦**上完成(回呼網址是 `127.0.0.1`)。從 iPad、手機或 Tailscale 網址開啟時按鈕會提醒你換到本機。
> 用戶端 ID/密鑰存在資料目錄的 `gcal-client.json`(權限 600);也可改用環境變數 `GCAL_CLIENT_ID` / `GCAL_CLIENT_SECRET`(優先)。終端機版仍可用:`npm run gcal:auth`。

同步規則:
- 只同步專用行事曆,**讀不到你其他行事曆**(授權範圍僅 `calendar.app.created`)。授權檔 `gcal-token.json` 在資料目錄內,權限 600。
- **隱私預設為最小**:Google 上只出現「王○○・自費」與時段,**不含地址與備註**。要送完整姓名/地址/備註,設 `GCAL_PRIVACY=full`——這會讓個資存放在 Google 雲端,請自行評估(CLAUDE.md C1)。
- 不重複:事件 id 由行程 id 決定;改期、取消、恢復都更新同一筆事件。
- 衝突(兩邊都改過):以較晚的修改為準。
- 在 Google 上新增的事件會變成「未指定個案」的行程,指定個案後才能開服務紀錄。全天事件略過。
- 在 Google 上刪除已開啟服務紀錄的行程:本機行程保留並顯示警示。

## P4 LINE 整合

功能:
- **預約提醒**:服務前一日 18:00 起自動推送一則(可用 `LINE_REMINDER_HOUR` 調整);**不含任何健康資訊、地址或備註**。改期會再提醒一次;已取消、未綁定、一小時內開始的不發。
- **到達/完成通知**:服務紀錄頁按「通知家屬:我到了/服務完成」。離線時先排入佇列,連線同步後送出;**逾 30 分鐘未送達即不再送出**(過時的「我到了」沒有意義)。每個服務各只能送一則。
- **家屬版摘要**:簽章後自動產生白話摘要,傳送前可直接修改。**規則式轉譯,未使用任何 AI(C1)**:術語換白話、數值附長條圖(LINE Flex,不需公網圖片)、一律以「接下來怎麼做」收尾;不含臨床推理、風險標記、生命徵象、常模比較。
- **居家運動推送**:簽章後按「推送居家運動」,附白話動作名稱、劑量與示範影片連結(到「動作庫」分頁貼上影片網址,例如 YouTube 不公開連結)。

**綁定流程(家屬同意機制)**:個案頁按「產生家屬綁定碼」→ 家屬加入官方帳號好友 → 傳送「綁定 123456」。綁定碼 6 位數、48 小時有效、單次使用;同一 LINE 使用者連續輸錯 5 次鎖定 1 小時。家屬回覆「停止」、封鎖或取消好友即解除綁定。綁定成功的回覆只顯示遮罩姓名(王○○)。LINE user id 只存在 server,不會下發到裝置。

設定步驟:
1. 到 [LINE Developers](https://developers.line.biz/) 建立 Messaging API 頻道,取得 **Channel secret** 與 **Channel access token(長期)**;在官方帳號後台關閉「自動回應訊息」與「加入好友的歡迎訊息」(由系統處理),並啟用 Webhook。
2. 啟動時帶入環境變數:
   ```bash
   export LINE_CHANNEL_ACCESS_TOKEN=...   LINE_CHANNEL_SECRET=...
   export LINE_CLINIC_NAME=你的診所名稱   LINE_CONTACT="0912-345-678"   # 提醒訊息用
   npm start
   ```
3. **Webhook 需要公網 HTTPS 網址,但病歷系統不可對外。** 因此 webhook 跑在**獨立的埠(預設 8788)**,只處理 `POST /line/webhook`(其他路徑一律 404),且每個請求都驗證 LINE 簽章。只把這個埠對外,主系統(8787)維持只在本機/Tailscale 內。例如用 Tailscale Funnel(請以官方文件為準,我沒有在真實環境驗證此指令):
   ```bash
   tailscale serve --bg --https=443 8787        # 主系統:只在你的 tailnet 內
   tailscale funnel --bg --https=8443 8788      # 只把 webhook 埠公開
   ```
   然後把 `https://你的機器.你的tailnet.ts.net:8443/line/webhook` 填到 LINE Developers 的 Webhook URL 並按「驗證」。
4. 確認權杖可用:`LINE_CHANNEL_ACCESS_TOKEN=... npm run line:test -- <LINE userId> "測試"`。

注意:
- **LINE 是第三方服務**,傳送的訊息(含摘要與居家運動)會經過 LINE 的伺服器。綁定即同意,但請你自行評估個資風險,並在告知書中說明。
- 推送有每月則數上限(依你的官方帳號方案,以 LINE 後台顯示為準);超過時訊息會標示失敗與原因。
- 失敗的訊息可在「傳送紀錄」按「重新傳送」;已送出的不可重送。

## 與規格的差異(基礎設施用,不改變規格欄位語意)

- `encounters`、`soap_notes`、`ltc_records` 與字典表額外加 `created_at` / `updated_at`(同步與版本時間戳需要)
- `soap_notes`、`ltc_records` 加 `encounter_id`(實現「1:1 對應 Encounter」)
- 新增 `line_messages` 表(LINE 外送佇列,裝置離線排入、server 送出並回寫狀態);綁定/綁定碼/已送記錄為 server 專用表,不下發裝置
- 新增 `appointments` 表(排程;SPEC §5 需要但 §2 未定義);Google 對應資料另存 server 端 `gcal_map`,不隨同步下發
- `exercises` 加 `category`(介入類別:徒手/運動/功能性/衛教)
- SPEC §2.3 的 `npre` 視為 `nprs` 之筆誤
- 常用清單以固定 id + `sort_order < 0` 表示移出(同步協定不支援刪除)
- `favorites` 加 `kind` / `ref_id` / `sort_order`;`goals` 具體欄位依 SPEC §2.5 的描述展開
- 各表加內部欄位 `server_seq`(僅 server 端,同步游標用)
