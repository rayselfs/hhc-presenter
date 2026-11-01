# Camera lyrics recognition and subtitle styling implementation plan

日期：2026-11-01。狀態：使用者已確認需求與樣式方向，產品實作尚未開始。

主要交付與驗收平台為 Windows；macOS 為次要平台，browser 維持相同行為。Mac 本機測試不作為 Windows 已驗證的證據。

## Purpose and scope

既有攝影機頁已將來源畫面送回導播機，供導播機去背與疊字幕。本次新增功能是在該頁辨識投影片歌詞，保留來源每行的文字及行數，換成字幕樣式後移至畫面中間下方。導播機繼續負責去背及與現場攝影機合成。

現場既有操作是 SE-2200 去除投影片黑底，操作人在攝影機頁將擷取視窗往下移並縮小，形成字幕位置。本功能沿用該連線與分工，將人工移位／縮小的目的改以可調字幕字級與底部距離完成，額外解決圖片背景及多行文字的擷取問題。

不可改變的契約：來源兩行就輸出兩行，來源三行就輸出三行；每行文字、順序與換行位置維持，不重新斷句、合併、分頁或限制兩行。可以改字型、字級、行距與整組位置，不代表重新編排每行內容。

必須同時處理兩個主要情境：

1. 投影片出現第三行時，直接套原畫面的固定裁切／位置可能被遮擋。需辨識全部三行，以較小字幕字級整組移到下方，仍然維持三行。
2. 主日投影片使用圖片背景，無法以單純黑底去背取出歌詞。需要辨識文字，再用黑底重新繪製。

黑底白字仍需支援，但新增黑色去背不構成本次交付。圖片背景辨識與來源行結構保留都是必要驗收。沿用既有單一來源，不新增第二路現場攝影機合成。

## Operator workflow

1. 在攝影機頁沿用既有來源選擇，取得投影片視窗、螢幕或擷取卡的畫面。
2. 啟用「歌詞字幕」，框選完整歌詞區域。來源可以含一、二、三行以上，不得只擷取預設兩行而漏掉第三行。
3. 操作端呈現來源裁切預覽、辨識文字及黑底輸出預覽。必要時可手動修正文字；修正後進入 manual 狀態，明確恢復自動辨識才繼續覆寫。
4. 設定字型、字級、行距與距離底部，白字固定。沿用 SE-2200 去黑底路徑，不增加陰影／描邊控制。確認輸出預覽保留來源行結構且沒有超出安全範圍。
5. 明確按既有投影按鈕，輸出黑底標準歌詞畫面，交給導播機去背及合成。頁面進入、選來源或調設定不自行取得 projection owner。
6. 「隱藏字幕」送純黑畫面，保留目前辨識及來源預覽，方便恢復。
7. 關閉辨識功能後回到既有原畫面輸出，不改寫原本來源的構圖設定。

介面統一提供這個功能的開關，不要求操作人理解去背／OCR 的技術分類。

## Output and styles

- 輸出沿用 1920×1080 邏輯畫布、純黑背景；只送歌詞，不含來源圖片、視窗裝飾或控制框。
- 基本控制為字型、字級、行距與距離底部，不提供文字選色，固定白色。每行水平置中，整組以底部為錨點；兩行變三行時向上增加，最後一行的底部距離保持不變。
- 初始樣式為程式已有的 Noto Sans TC、字重 600、1080 邏輯畫布上 64px、行高 1.25 倍、底部安全距離 5%（54px），左右各留 5%。這是本產品可調預設，不是電視台通用規格；需在實際節目輸出及觀看尺寸驗收。
- 優先用程式已包含的繁中字型。操作端與投影端必須載入相同字體，不能因 font fallback 產生不同換行。
- 字級用邏輯畫布像素，行距用倍數，底部距離及寬度用畫布比例。預覽等比例縮放，不能依容器各算一套排版。
- 用明確的逐行文字陣列繪製，每行禁止自動換行。改字型、字級或行距不改每行字數；不做語意斷行、兩行上限、分頁、橫向壓字或拉伸。
- 長行或多行在所選字級超出安全區時，顯示超界範圍及調整提示，讓操作人改字級／行距／底部距離；不自動改行數、截字、省略號或偷偷縮字。無法安全顯示的新結果不發布，依逾時策略清空並提示。
- 底部距離以整組可見文字邊界計算，不以最後一行 baseline 代替，避免文字被切掉。
- 本次輸出固定純黑底、白字，不繪製黑色陰影／描邊，也不提供無法在既有去黑底路徑可靠生效的控制。可讀性以足夠字級、適中字重、行距及安全位置處理。
- 保留文字渲染的正常反鋸齒，不加模糊、發光或厚白邊補償；不為保留陰影把黑底改近黑。最終細字邊緣由 SE-2200 實機校準 key level 驗證，不能以本機預覽代替。

## Broadcast styling and Datavideo SE-2200

使用者已確認導播機為 Datavideo SE-2200，現場已使用它去除投影片黑底。本次以延續既有單訊號去黑底流程為前提；具體接線、DSK 選項與韌體尚未現場檢查。

- 專業字幕工具把字體、描邊、陰影與對齊獨立設定；例如 [Adobe Premiere 的字幕樣式文件](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/create-styles-for-captions.html) 提供這些控制。這支持採用統一樣式，但不構成特定字級、描邊寬度或最多兩行的通用廣播規定。
- [EBU R 095](https://tech.ebu.ch/publications/r095/) 的 graphics safe area 在四邊各留 5%，可作為初始安全框。現場台標、直播平台控制與其他圖文仍可能要求更高底距；所有三行內容都要在安全框內。
- [Datavideo 官方 SE-2200 規格](https://www.datavideo.com/global/product/SE-2200/export) 列出 Luma／Linear Key（Key／Fill），未列 Chromakey 支援。不要把綠底色鍵當作這台的既有解法；實際支援及接法需對照設備。
- Luma self-key 由同一張影像的亮度決定透明度；黑色描邊與黑底無法靠同一黑底訊號區分。因此白字能留下，黑邊與黑陰影會被去掉或削弱。這是根據 [Blackmagic 對 Luma／Linear Key 的定義](https://www.blackmagicdesign.com/ca/products/atemconstellation8k/features) 作出的訊號限制推論，不是 SE-2200 現場測試結果。
- 要可靠保留黑邊，需將文字外觀與透明遮罩分離，例如相容的 Fill＋Key／CG 路徑；遮罩必須含描邊及陰影覆蓋範圍。這需要確認現有輸出設備、同步、訊號格式及 SE-2200 的實際介面，不假設加 CSS、普通 HDMI 透明背景或再開一個視窗就能完成。
- 官方 SE-2200 規格列出 1080i／720p 等格式。1920×1080 是程式邏輯畫布，不代表可直接送 1080p60；實機驗收需記錄電腦／轉換器輸出與導播格式。若現場使用交錯掃描，另查細筆畫及陰影是否閃爍。

本次採用的處理決定：沿用現有黑底白字連線，完成行結構保留與字幕樣式，不加入陰影／描邊或 Fill＋Key 輸出。保留黑色效果的路徑僅作為技術分析，不是本次待選項或交付要求。

現場驗收先在 SE-2200 的 preview 檢查，再確認 program：黑底必須完全移除、白字沒有明顯缺筆／鋸齒／光暈，並對照現有投影片去背效果。檢查 HDMI RGB／YUV 與 full／limited range 是否匹配，避免用過度提高 key level 補償黑位不符而侵蝕字邊；不在 App 隨意加入第二次色階轉換。畫面測試包含明亮與深色攝影機背景，若白字對比仍不足，記錄為既有 key 路徑限制，不以無效黑描邊宣稱已改善。

## Recognition pipeline

```text
Existing selected camera/window/screen source
  → full lyrics ROI, including a possible third line
  → text detection and recognition
  → reading order and conservative normalization
  → optional explicit PPT catalog correction
  → stable-result gate
  → source-line-preserving styling and safe-area validation
  → shared black-background lyrics renderer
  → existing projection output → switcher keying/composition
```

- 沿用單一來源 capture。OCR 讀取既有 camera transform 裁切前的來源，避免第三行在辨識前就被裁掉。
- ROI 使用原始有效影像的 0–1 座標，讓操作人確認已包含第三行並排除標題列、logo、頁碼；不硬編碼頂部 25% 或固定兩行。
- 不能沿用「固定兩行、略過 detection」前提。需取得多個文字區塊，按視覺行分群再由左到右／上到下排序，避免同一行碎片錯排。引擎 observation 數量不等於來源行數。
- 資料契約保留逐行內容及其來源 bounding boxes；穩定判斷比較逐行結果，不能先去掉所有換行後只比整句。不得自動刪標點、改字、合併行或用語意模型重新斷句。
- 黑底與圖片底都納入辨識。保留彩色／灰階資訊，前處理由對照測試決定；黑字、白字、局部低對比均需測試，不把全域二值化當通用去背景。
- 一次只辨識最新 ROI，繁忙時覆蓋等待幀，不堆積舊工作。每個結果綁來源 revision 與 frame sequence；換來源、停用或換 owner 後的結果丟棄。
- 辨識放在 worker／專用服務，避免阻塞 React 操作。初始約每秒五次，依實測調整；亮度／邊緣變動不作唯一觸發條件。
- 結果經連續觀測穩定後才發布；confidence 只作診斷，不當成正確率，也不能只因 confidence=1 就放行。
- 空白、已確認來源失效或辨識持續不穩時，上一句最長保留一秒再清為黑底；這是待實測的起始策略，不得永久凍結舊詞。
- 靜態歌詞本來可長時間不換字，不能只以像素沒變或沒有新句子判斷失效。
- 手動隱藏優先於 OCR；manual 修正不能被背景辨識覆寫，來源切換則清除舊修正。

### OCR engine gate

現有 macOS Vision PoC 是參考基線，尚未完成 Electron、Windows 或 browser 引擎交付。

- 實作起始選定具完整繁中字集、可接受離線授權及部署體積的引擎，測試 detection 與 recognition 的完整成本。
- 優先驗證 Electron／browser 共用模型。若採各平台原生引擎，需提供一致結果契約並分別驗收，不得靜默停用其他平台。
- 已測約 10.9MB PP-OCRv4 中文模型缺少本批必要繁中字，不作預設候選。
- 圖片底與三行完整辨識未過 gate 前不能宣稱完成；若沒有模型達標，記錄阻礙及支援條件，不降格成交付已存在的黑底去背。

### Optional PPT assistance

PPT 可提供原文修正 OCR，但不是使用條件，也不能只支援事先載入的歌曲。

- 只有操作人明確選擇本場歌曲／PPT 時才使用該集合比對，保留原始辨識結果供核對。比對修字也必須保留目前來源行界；不能用字典中的另一種換行覆蓋來源結構，無法可靠逐行對應時不自動套用。
- 近似句子可能是 OCR 錯字，也可能是真正改詞；須測只差一字的陌生內容，避免無提示套回舊詞。
- 直接讀 PPT 原文仍需要可靠的目前頁碼。既有 Media 播放動作會取得 media owner，不能直接用作 camera 字幕控制。
- 沒有 PPT 時，也要能透過 OCR 與人工修正完成主要流程；有 PPT 也不能取代圖片背景辨識驗收。

## Integration and state

- 沿用 `CameraWorkspacePage`、`CameraSessionProvider`、既有 capture、camera owner 及 IPC／BroadcastChannel，不新增獨立字幕頁或通用圖層系統。
- 關閉功能沿用 raw video／WebRTC。啟用後由主視窗擷取與辨識，傳送已接受文字、樣式與狀態，由共用文字元件在操作端及投影端繪製。
- OCR 輸出是文字資料，不需重新編成 video stream。投影端不開來源、不重跑辨識。
- 在 camera projection contract 增加明確 output variant，區分 raw source 與 lyrics。切回 raw 才恢復原 transform／peer，不改寫既有構圖。
- 同時更新 Electron IPC 與 browser adapter validator：限制逐行陣列大小、文字長度、合法字型、字級／行距數值及版面界限。安全上限用來拒絕畸形輸入，不把三行正常內容裁成兩行。用文字節點渲染，不接受來源 HTML。
- 結果綁來源 revision、輸出 revision 與 projection generation；過期結果／replay 不能蓋回新來源或其他 owner。投影重開先輸出黑底，再取得目前有效 snapshot，不重播已逾時的舊詞。
- 將 source capture、OCR readiness 與 projection readiness 分開。停掉 raw video peer 不能提前釋放 OCR 來源，也不能把辨識狀態誤判為斷線。
- stream、worker、引擎及 callback 留在 provider/service；Zustand 保存樣式、ROI、辨識／已接受文字、manual/auto 與可序列化狀態。
- 樣式可用現有 storage adapter 持久化，遵循 partialize 與 schema version／migration；來源 ID、permission、enabled、辨識歌詞及 runtime 不持久化。
- 延續目前 navigation／owner lifetime、Timer 例外及 blackout。頁面進入不自動啟動辨識或取得 owner；實作前覆核離頁／停投規則並測兩種 variant。
- StrictMode、切來源、停用及最後 consumer 離開時釋放 OCR 工作及不再需要的資源；失效不自動換裝置。
- 模型／worker 如需 CSP 調整，只增加必要來源並實測 browser。原生能力維持 preload 邊界與 sandbox；不傳歌詞或影像至雲端。

## File map

| Responsibility                                | Files                                                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Camera controls and previews                  | `src/renderer/src/pages/CameraWorkspacePage.tsx`, new `components/Control/Camera/LyricsRecognitionControls.tsx`                                                            |
| Capture and OCR lifetime                      | `src/renderer/src/contexts/CameraSessionContext.tsx`, new `src/renderer/src/lib/lyrics-recognition.ts`, selected engine/worker                                             |
| State and style persistence                   | new `src/renderer/src/stores/camera-lyrics.ts`                                                                                                                             |
| Source line preservation and safe-area checks | new `src/renderer/src/lib/lyrics-layout.ts`                                                                                                                                |
| Shared black-background output                | new `src/renderer/src/components/Common/LyricsOutput.tsx`                                                                                                                  |
| Projection output variant                     | `src/shared/camera.ts`, `src/shared/projection-messages.ts`, `components/Projection/CameraProjection.tsx`                                                                  |
| Delivery, validation and replay               | `lib/projection-adapter.ts`, `lib/projection-session-coordinator.ts`, `lib/projection-render-state.ts`, `src/main/ipc/validate.ts`, camera publishers and snapshot callers |
| Engine deployment if needed                   | selected native IPC/preload bridge or browser worker/model loading, build/package configuration and CSP                                                                    |
| Labels                                        | existing `locales/en.json`, `locales/zh-TW.json`, `locales/zh-CN.json`                                                                                                     |
| Tests                                         | recognition/layout/store tests, camera workspace/context, IPC/projection replay, browser/packaged E2E                                                                      |

## Implementation sequence

### 1 Prove the actual recognition requirements

在最新 `origin/main` 建立隔離 worktree 與 feature branch。此次計劃修訂只改文件，保留目前 checkout 其他變更。

- [ ] 建立 ground truth fixtures：黑底兩行、黑底三行、圖片底兩行、圖片底三行，涵蓋深淺圖、黑白字、不同字型及來源尺寸。
- [ ] 沿用現有擷取，驗證 Electron／browser 的完整 ROI，第三行沒有先被來源 transform 裁掉。
- [ ] 選定完整繁中 OCR 路徑，對三行完整辨識與圖片底文字做實機 gate，保留 raw／accepted 結果。
- [ ] 分開報告整頁內容正確、首次輸出正確、結束正確、漏字、錯字、未輸出與誤配；不只算曾經正確或單字平均。
- [ ] 測閱讀順序、換句、淡入、空白、來源失效、重複句及只差一字的陌生歌詞。
- [ ] Gate 失敗先改善引擎／來源條件或記錄 blocker，不把兩個主要情境移出必要範圍。

### 2 Implement line preservation and styles

- [ ] 共用 renderer，提供字型、字級、行距、底部距離，固定白字黑底，不加入陰影／描邊控制。
- [ ] 測一／二／三行原樣保留、同一行多個 OCR 碎片、標點／空白、中英混排與超長行；改樣式後每行內容及行數完全一致，不自動換行。
- [ ] 測兩行變三行仍固定底邊、字體載入、反鋸齒字邊及安全區；超界要提示，不截斷、不改行數或偷偷改字級。
- [ ] 測手動隱藏、修正與恢復自動；空白輸出純黑，預覽與投影逐行一致。

### 3 Integrate camera and projection

- [ ] 同步修改 output variant 的 type、validator、publisher、reducer/coordinator snapshot 與 replay；先搜尋所有 camera-state caller。
- [ ] 啟用時同步文字，停用時回復原來源構圖與 peer，不新增雙來源攝影機合成。
- [ ] UI 測來源預覽、三行 ROI、辨識狀態、樣式控制、人工修正、失效及切回原功能。
- [ ] 測 owner switching、Timer 例外、blackout、投影重開、過期 snapshot／OCR completion、離頁及 StrictMode cleanup。

### 4 Acceptance and delivery

- [ ] 執行 `npm run lint`、`npm run typecheck`、`npx vitest run`、`npm run build`、`npm run build:web` 及相關 browser／packaged E2E；檢查 CSP/console。
- [ ] macOS Electron、Windows Electron、HTTPS/localhost browser 分別驗收；原生 macOS PoC 不代替其他平台。
- [ ] 兩個主要情境 fixtures 都逐行完整保留歌詞，來源三行輸出仍為三行，沒有額外自動換行或遮擋；圖片背景不帶入輸出。fixture 通過不外推成任意歌曲 99%。
- [ ] 至少 30 次換句量測來源改變至完整正確字幕 median/P95，失敗另列。初始工程目標 P95 不超過一秒，依現場接受度收斂，不承諾低於 100ms。
- [ ] 空白、來源已確認失效或辨識不穩，依既定一秒期限清成黑底。實測來源關閉／最小化是否留下最後一幀；無法可靠判斷的來源記錄限制。
- [ ] 至少 30 分鐘持續測 CPU/GPU/記憶體及任務堆積，重複換來源／模式與開關投影後資源能回收。
- [ ] 真正接回 SE-2200，記錄實際訊號格式、色階、DSK 模式與接線；在 preview／program 驗收白字 keying、字邊、字型／行距、底距、來源三行保留及圖片背景。對照原先投影片去黑底效果，確認背景沒有殘留、文字沒有被 key level 侵蝕，不只看 App 預覽。
- [ ] 保留既有直接送原畫面到導播機的操作及回歸測試。
- [ ] PR/CI 通過後 merge、release、部署依當時授權；安裝版權限／引擎載入及導播機 smoke 分開記錄。未完成驗收保留 task worktree。

## Evidence and remaining gates

Apple Vision 加 PPT 比對的 45 段即時測試中，已知歌詞結束正確 27/33，深色影片白字 17/17、亮色影片黑字 10/16；成功段首次正確中位數 337ms、P95 594ms，五段從未成功，另有一段顯示後清空。七段不同歌曲被拒絕，但只差一字的陌生歌詞誤配。原生 PowerPoint 已確認比對可補回 OCR 漏字。

這支持繼續驗證辨識與排版，但尚未證明多行完整辨識、圖片背景廣泛穩定性、跨平台部署或導播機輸出驗收。先前黑底去背靜態檢查不作為本功能主要成功證據。

本機證據根目錄是本次對話驗證產物目錄，主要檔案為 `lyric-live-catalog/output/validation-report.txt`、`live-validation-results.json`、`native-powerpoint-results.json` 及 `ppocr-v4-results.json`。實作時只納入可公開最小 fixtures 與必要報告，不提交歌詞全集、攝影機影像或個人路徑。

本次不新增黑底去背、雙來源現場攝影機合成、通用圖層系統、雲端 OCR、NDI 或錄影輸出。
