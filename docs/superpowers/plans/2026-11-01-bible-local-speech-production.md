# Bible local speech production readiness plan

日期：2026-11-01。狀態：2026-11-02 已完成 Mac 合成語料的語言別比較，詳見 [中文／英文選型報告](../../reports/2026-11-02-speech-language-selection.md)。原型推薦為同一 whisper.cpp 引擎下，中文使用具長句保護的 Turbo，英文使用 Small 加固定簡短提示。這是比較結果，不是正式選型通過；兩語言 reference 仍未達 98%，Windows／真人現場與完整端到端延遲、發行驗證尚缺。

最新使用者決定：英文 Small 加 v3 引用格式已屬階段性可接受，不再為追求英文最後幾個百分點阻擋中文工作。英文設定固定，只跑必要回歸；當前優化資源集中中文。這項接受不代表真人、Windows、端到端延遲或完整 production 驗收已完成。

## 1. Confirmed scope and decision gates

需求足以開始實作前驗證，不需要使用者先指定模型、下載路徑或設定檔。以下區分產品決定與尚待實測的工程決定，不能把後者寫成已完成。

- Electron 是主要使用環境，語音辨識在本機執行，移除 Azure Speech。依「只用本地模型」一併移除既有 GCP Speech 路徑。
- 使用者只選主要辨識語言：`中文`／`English`，預設中文。中文辨識文字以繁體呈現；這不等於把聖經譯本原文轉寫成另一版本。
- 主要辨識語言、介面語言與聖經譯本獨立。主要語言 selector 固定為 `中文`／`English`，預設中文；選定語言決定解碼提示與語言別推薦語音包。中文口令／朗讀與英文口令／朗讀各自驗收，不使用混合平均分數選預設方案。
- 2026-11-02 使用者確認：通常不會中英混說。混說降為次要相容性測試，命中率低或拒答不阻擋中文／英文主要功能；遇到不確定輸入仍拒答，混說造成錯誤定位的安全回歸不得忽略。
- Website 使用瀏覽器辨識能力。本計畫按「本地」採嚴格解讀：只啟用可確認的 on-device recognition，不自動回退雲端。指定語言或 API 不支援時提供清楚原因、手動搜尋與桌面版入口。這是有明確提示的能力差異，不宣稱所有瀏覽器都有桌面版能力。
- 自動辨識可以更新候選與定位操作畫面；正式投影仍須使用者明確操作，不搶 projection owner。
- 不加入其他語言、雲端 fallback、LLM 生成經文、自動投影或使用者自訂模型目錄。
- 本文件不授權合併、發版、部署、收集現場錄音或使用付費服務。

尚待工程驗證：主要引擎、各語言推薦模型版本、最低支援設備、中文與英文各自的準確率、可用 browser 語言包、冷啟動與延遲、模型散布授權。混說結果另列且不作命中率 gate。Phase 0 必須產生記錄；主要語言或安全 gate 失敗則停止相關交付，不默默降低標準。

## 2. Current evidence and reuse boundaries

2026-11-01 唯讀審查與針對性驗證：

| 現況                                                                                  | 位置                                                                                                       | 改造要求                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| UI 需要選目錄；`modelDir` 非空即視為可啟用                                            | `components/Control/UserMenu/BibleSettingsPanel.tsx`、`components/Control/Bible/SpeechRecognitionCard.tsx` | 改成應用管理安裝與真實 runtime ready                 |
| MediaRecorder 每兩秒獨立解碼，錯誤被忽略，沒有明確 sample rate 契約                   | `lib/speech-adapter/providers/whisper-speech-adapter.ts`                                                   | PCM capture、resampling、可見錯誤與 backpressure     |
| Worker ready 未參與 start；載入／推論可重疊                                           | `workers/whisper.worker.ts`                                                                                | 單一 preparation、序列推論、有界緩衝、crash recovery |
| 已有單檔暫存 rename 與大小檢查，但非空同名檔就重用，模型共用資料夾，下載指向浮動 main | `src/main/ipc/app.ts`                                                                                      | 固定版本、hash、模型隔離、整包驗證後切換             |
| 只有章節 parser，未串接經文內容搜尋                                                   | `components/Control/Bible/SpeechRecognitionCard.tsx`                                                       | reference 與 quotation 兩條 retrieval 路徑           |
| browser 語言讀取 `sp.azure.language`                                                  | `lib/speech-adapter/index.ts`                                                                              | 拆出獨立 `recognitionLanguage` 與 migration          |

表內 renderer 路徑相對 `src/renderer/src/`。直接執行 parser 已確認：`2 John 1:5` 丟失 `2`；`詩篇一百零一篇一節` 錯解為第一章；`約翰福音三章 sixteen` 回退第一節。這些輸入必須成為 regression tests。

現有 5 檔／130 tests 通過（parser、book matcher、Whisper lifetime、speech session、main app IPC），但音訊與 Worker 大量使用 mocks，不能代替真實模型、實際錄音與安裝包測試。

沿用 `useSpeechSession` 的取消／過期結果保護、`BibleSearchEngine`／search Worker、Bible store／資料快取及既有投影動作。不要重寫全部 session 管理或建立泛用多 provider framework。

## 3. Customer workflow

### First use and model preparation

1. 選「中文」或「English」，顯示本機處理與需要下載的實際容量。
2. 按「安裝語音功能」。先檢查平台、磁碟空間與 runtime 支援；由程式依主要語言選定推薦語音包，使用者不需要知道模型名稱或指定路徑。
3. 顯示下載位元組／進度、驗證中、首次準備中；支援取消與重試。總大小未知時顯示不定進度，不顯示假的 100%。
4. 檔案、runtime 載入與內建自我檢查都成功才標示「已就緒」。安裝成功與本次 runtime ready 是不同狀態。
5. 使用者授權麥克風，選輸入裝置，看到音量並說一句測試口令，確認辨識文字和候選。
6. 之後只需按「開始聆聽」。切換主要語言由程式管理資源，不需要再選模型；若另一語言所需語音包尚未安裝，回到相同準備流程，已驗證的相同資源直接重用，不把下載中顯示成已就緒。

若硬體不足，不承諾更換隱藏模型即可修好；提供明確限制與手動搜尋。使用者已允許保留辨識強度 selector；只有實測支持取捨時提供「標準／加強辨識」等白話選項，與主要語言 selector 分開，不要求認識模型品牌。各語言可使用同一引擎的不同語音包，一次只載入及執行一個模型，不同時跑兩個模型補答案。

### Listening and navigation

- 顯示麥克風來源、音量、目前辨識文字，以及 `準備中／聆聽中／暫停／需要處理`。狀態不能只依使用者按過開始判定。
- partial text 即時顯示；候選穩定後才更新定位。候選去重，最多顯示前三筆主要建議與有上限歷史，不在使用者點選時突然重排。
- 啟用聆聽時清楚顯示自動定位狀態。高可信結果自動定位 Bible 操作預覽；有歧義只顯示候選。
- 手動選經文、編輯搜尋或切換譯本即暫停自動跟隨，提供「恢復跟隨」與返回上一處。背景辨識不得覆蓋手動決定。
- 離開 Bible 頁預設停止聆聽並釋放麥克風；回來由使用者重啟，可重用仍保留的模型。避免隱藏錄音與不明確的跨頁 lifetime。
- 同一結果只定位一次；去重需同時考慮 passage、session 與 utterance，不能永久禁止稍後再次提及同一節。
- 接受候選與送出投影分開，沿用既有顯式投影按鈕／快捷鍵與 navigation guards。
- 區分 speech candidate preview 與 committed presentation passage。已有 Bible 投影時，「下一節／上一節／下一章／上一章」延續最後一次明確投影的 passage，不受語音預覽影響；只有明確投影新候選才改變 live 基準。未投影時沿用既有手動選擇行為。手動翻節先暫停跟隨，再執行動作；UI 清楚區分「候選預覽」與「目前投影」，不可只把 speech 結果寫進 `navigateTo` 就視為完成。
- 權限拒絕、裝置拔除、模型失敗、推論落後、睡眠／喚醒都有可理解的訊息。喚醒或裝置失效後不偷偷重新開啟麥克風。

## 4. Engine and audio architecture

Phase 0 用同一份語料比較 sherpa-onnx 中英串流模型與 whisper.cpp 多語模型；現有 Transformers.js 作基準。實測後原型採同一 whisper.cpp 引擎的語言別語音包：中文為 Turbo Q5_0、中文 hint、無 prompt、依音訊長度選 context；英文為 Small、英文 hint、固定簡短 Bible prompt。英文 Turbo 的口令定位較差，暫不因模型較大就稱為英文加強方案。不在雙平台與品質 gate 通過前鎖定正式預設；一次只跑一個 ASR，不逐句呼叫 LLM。

採原生引擎時用應用管理的獨立背景程序，透過既有 preload／typed IPC 邊界控制。renderer 不取得任意路徑或命令執行權，不開 localhost HTTP server，不放寬 BrowserWindow sandbox。若現有 Worker 路徑在兩平台達到相同門檻且維護成本更低，可在 Phase 0 記錄證據後保留，不為架構偏好強制原生化。

```text
Selected microphone
  -> mono PCM with explicit sample rate and resampling
  -> bounded audio buffer + VAD with pre-roll/end padding
  -> one loaded recognizer / sequential inference
  -> transcript with session, language and utterance revision
  -> reference parser OR local quotation retrieval
  -> stable candidate gate
  -> operator preview navigation
  -> explicit existing projection action
```

- 使用 AudioWorklet 或經驗證的 native capture，輸入格式以所選模型契約為準；不能把任意 AudioContext sample rate 的 Float32Array 當成正確格式。
- 聲音與辨識資料不因 IPC 無限制複製／排隊；單一模型初始化 promise、單一 inference flight。PCM 有界，但不能像影像一樣直接覆蓋中間音訊造成破句；落後超標時丟棄整個過期 utterance、重設辨識上下文並明示落後，不播放式追趕舊經文。
- VAD 保留句首／句尾，測試安靜、短停頓、音樂與現場回音；預設降噪／回音消除須對混音台輸入實測，不一律強制開啟。
- 分段不得沿用舊有每兩秒清空音訊的方式。600 ms 停頓不代表完整指令；前置／後置否定與書卷、章節間停頓必須保留。先辨識的中間結果只能是暫存候選，續講後須失效，不能直接觸發導航。
- 音量門檻或 VAD 不能因較快就採用；需逐筆比對完整音訊，任何正確定位損失或新增錯誤候選都退回。只裁數位零值與跳過全零音訊列為保守實驗；這不是可用於現場背景噪音的完整 VAD。
- 端到端時間需拆分收音／重採樣、句尾等待、排隊、ASR、定位、IPC 與畫面更新。可研究先辨識、等語意穩定再發出候選，但根據已知音訊邊界與 ASR 耗時計算的排程預算不等於實測端到端驗收。
- result 必須綁定 session、模型／語言 revision、utterance revision；停用、換語言、換裝置、runtime 重建後忽略舊結果。搜尋結果另綁譯本／索引 revision。
- 中文模式用中文 hint，英文模式用英文 hint 作為分開校準的基線；prompt／模型設定只根據該主要語言的定位品質、負例與延遲選擇，不為混說命中率犧牲主要語言。混說相容性另列，不保證完整保留另一語言。
- Turbo 短 context 加速必須涵蓋完整輸入：短句可用縮短 context，長句在首次推論前使用完整 context；不可裁掉後段音訊換取三秒。切換主要語言／語音包時沿用 session revision 與過期結果保護。
- 保留 `lib/speech-adapter/bible-phrases.ts` 的領域詞彙，在 Phase 0 對引擎實際支援的 hotword／prompt 做小型 A/B，量測罕見書卷、中英混說及無引用音訊 false positives。只有淨改善才預設啟用，不新增使用者設定，也不把標準答案或目前經文灌入 prompt 污染驗收。
- 停止後立即釋放麥克風與音訊 buffer；模型可暫留，起始 idle eviction 5 分鐘，記憶體不足立即釋放，最終值依測量調整。
- runtime crash 轉明確 error，允許一次有界重建；不得無限 retry 或重新啟用已停止 session。初始化／停止／IPC request 皆有 timeout。
- 本機聆聽不沿用雲端費用導向的一小時強制截止；以顯式停止、離頁停止、休眠停止、有界資源與可見狀態管理，仍保留使用者主動設定的停止偏好。

## 5. Installation, persistence and migration

- Main process 管理 app-data 下固定模型根目錄；renderer 只傳受允許的 model ID。每個版本有獨立目錄與 pinned manifest，記錄檔案大小、SHA-256、來源 revision、引擎相容版本與授權資訊。
- runtime binary 隨應用安裝包發送；模型下載只接受資料檔，不下載執行任意安裝 script。manifest 的可信根來自應用，不接受任意遠端 manifest 取代信任。
- 現有 `electron-builder.yml` 的 mac identity/hardenedRuntime/notarize 關閉，`build-release.yml` 明確產生 unsigned package，不能假設已具簽章。Phase 0 由發行維護者記錄兩平台簽章／mac notarization 所需條件與責任；一般使用者無額外系統繞過的 production 安裝體驗，以可驗證的應用及內含 runtime 簽章為發行 gate。沒有憑證／授權時仍可完成本地功能與測試，但保留 unsigned 試用限制，不宣稱完整 production 發行完成，也不自行購買憑證或變更發行權限。Phase 4 驗證實際包內 native binary、簽章及平台啟動政策；hash 檢查不等於 OS code signing。
- 下載有 timeout、取消、有限 retry 與重導向來源限制。以 staging 下載，檢查空間含暫存／舊版共存需求；檔案全數驗證後才 atomic activate。
- 同一模型只允許一個 install job。進度含 job ID，UI 重掛載可查當前狀態；取消後過期 callback 不能啟用模型。
- 中斷後可重用已驗證完整檔案；部分檔案重新下載即可，第一版不強求 byte-range resume。損毀檔重抓，不把「非空」視為有效。
- 更新失敗保留已驗證舊版；切換時先停止 session，不替換正在使用的檔案。成功啟用新版本後清理非使用中舊檔，提供語音包修復／移除與磁碟用量。
- 狀態分離：安裝 `absent/downloading/verifying/installed/error`；runtime `unloaded/loading/ready/listening/error`。installed 可以持久化，但啟動須重查；ready 不持久化。
- 偏好使用既有 `hhcPersistStorage`、`createPersistName`、partialize 與 version/migrate。新語言欄位只允許中文／英文；未知值回到中文。舊語言設定依有效值遷移，不能因刪 Azure 欄位而遺失英文選擇。
- 刪除 Azure/GCP adapter、SDK、設定 UI、speech key IPC 與專用 key 檔；清理失敗可重試且不得記錄 key。升級後不再使用舊 key，其他登入／帳號資料保持不動。
- 同時清理網站既有 `hhc-speech-key-azure`／`hhc-speech-key-gcp` localStorage keys；只對這兩個已知 key 做一次可重試 migration，不清空整個 storage，也不把 key 讀出用於紀錄。相關入口在 `lib/speech-key-storage.ts`。
- 舊自選模型路徑不再使用，不刪除或搬動使用者目錄。舊偏好遷移成需準備狀態，明確說明需要一次安裝，不冒充已就緒。
- 音訊不落盤；辨識文字採有界記憶體保留，停止後清理音訊。診斷只記版本、耗時、狀態與錯誤碼；文字匯出須顯式操作，不送遙測或雲端。

## 6. Scripture recognition and retrieval

### Explicit references

- 優先修復各主要語言的 numbered English books、中文數字含零、英文數字、書卷別名、章／節／篇與明確範圍；中英混說列為次要相容性，命中率不阻擋主要語言交付。
- 區分「說完一章」與「節號尚未完成」。只說一章可定位章預覽，但不能把未辨識的節當作第一節並宣稱命中。
- 相對口令如「接下來十七節」只在同一 active session、最近一次明確接受的書卷／章上下文有效；起始有效期 30 秒，手動導航、停用、切語言或譯本即失效。
- 書卷 fuzzy score 不等於正確率；候選不唯一時不得直接取第一個。書卷／章／節／範圍必須在選定譯本資料內有效。
- 「不是三章，是四章」等自我修正、跨 chunk 的「十」「六」與重複結果列入測試；partial 不發出正式導航。

### Quotations

- 重用現有本機 Bible search Worker，以已下載且已完成索引的譯本搜尋。UI 顯示譯本／索引未就緒與準備動作，不能靜默沒有結果。
- 初版搜尋選定譯本，不自動下載所有版本；中文口令可以定位英文譯本，但中文朗讀對英文譯本不宣稱具跨語言語意搜尋能力。語言／譯本不匹配時提示選擇相符譯本。
- 搜尋前正規化繁簡、標點與數字，保留原文供顯示；結果必須引用資料庫的 canonical verse ID 與原始譯本文字。
- 索引與 query 必須共用同一 normalization。既有 cache 只依譯本更新時間重用，須把 retrieval schema／normalizer 版本加入 cache identity，變更後重建，包含 `lib/bible-db.ts` 的快取契約與 upgrade tests。不能只改 query 或沿用舊 encoder 產生的快取；重建中顯示準備狀態。
- 以 utterance 累積足夠詞句、匹配相鄰經文窗口並排序；常見短語、重複段落、意譯不勉強選一節。無命中是正常狀態。
- 現有 `BibleSearchEngine.search` 只回傳 verse IDs，定位為候選召回。保留既有手動搜尋 API，在有上限的候選及其相鄰經文上做文字匹配重排，產生可校準分數與第一／二名差距；不能把搜尋結果順序當 confidence。分開量測標準文字→retrieval 與音訊→ASR→retrieval，避免把所有錯誤歸因模型。
- 先量測文字檢索召回率；若意譯仍不足，記錄限制與獨立優化候選，不能以低信心自動定位掩蓋缺口。Embedding 僅在實證缺口足夠大時再提出，不列入初版必備。
- 候選穩定門檻用獨立 validation set 校準，綜合完整性、第一／二名差距、時間一致性與明確 reference，不採通用 ASR confidence 百分比。

## 7. Browser behavior

- feature-detect `SpeechRecognition` 與 on-device capability，檢查目前選定語言的 language-pack availability；只有確認本機可用才啟動。下載語言包透過瀏覽器支援 API 與必要的 user gesture。
- 不以 navigator.onLine 作本機開始的必要條件；尚未下載語言包則說明首次需連線。API、語言或 policy 不支援時關閉語音開始入口但保留手動搜尋。
- browser session unexpected end 需顯示停止；是否可有限重啟由實際瀏覽器測試決定，權限拒絕與使用者停止不得自動重啟。
- 清楚列出經驗證的瀏覽器版本、作業系統與中文／英文能力，不能只檢查 constructor 存在。檢查 CSP、Permissions Policy、console 與斷網實測。
- 同一 parser／retrieval／preview／projection 規則同時適用 Electron 與 website。若中文 on-device 不可用，據實發布限制，不改成未告知的遠端辨識。

## 8. Phases and file ownership

| Phase                     | 工作與主要位置                                                                                                                          | Exit gate                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 0. Evidence               | 獨立 worktree 建立 consented/synthetic audio corpus、benchmark runner；核對模型／runtime／轉換工具授權與打包方式                        | 兩平台記錄 CPU/RAM/OS、模型大小/hash、cold/warm latency、準確率；選定唯一主路徑及最低設備，無達標者不得進入正式選型 |
| 1. Foundations            | `src/shared/` speech contracts、`src/main/` model/runtime service、typed IPC/preload、renderer adapter／audio capture                   | 真實 PCM 能持續辨識；cancel/start/stop/crash/backlog/ready tests，錯誤可見且無殘留麥克風                            |
| 2. Provision and settings | `src/main/ipc/app.ts` 模型責任移至專用服務；`stores/settings.ts`、UserMenu Bible settings、`useSpeechSession`、locales                  | 乾淨安裝、離線重啟、修復／取消／重試與偏好 migration；刪除 Azure/GCP/key/SDK，browser 語言獨立                      |
| 3. Retrieval and UX       | `verse-parser.ts`、`bible-book-matcher.ts`、`bible-search.ts`／Worker、`SpeechRecognitionCard.tsx`、Bible store/page、shortcut registry | reference 和 quotation fixtures；候選穩定、manual takeover、preview 與 projection 分離                              |
| 4. Release qualification  | `e2e/`、package/build config、native runtime assets、CI、operator help                                                                  | 所有品質門檻與下列 acceptance 通過；可回復應用版本且不刪使用者資料                                                  |

每階段以小 PR 交付，新增引擎不要提前成為使用者預設。舊雲端 provider 從使用者入口退場時，新本機準備流程與 migration 必須一起可用。模型升級以版本化資源管理，不需要每次啟用連線檢查更新。

必要修改面包含：provider factory/interfaces、主程序 registration、preload、shared IPC types、settings migration、speech key storage、兩處 Bible settings UI 如仍有引用、翻譯、dependency lockfile、CSP、packaging、單元與 E2E fixtures。實作時先以 rg 確認所有呼叫者；不能只刪 UI 或只刪 SDK。

2026-11-02 Small 優化 follow-up 已完成，見 [實測比較](../../reports/2026-11-02-whisper-small-optimization.md)。英文簡短提示加解析修正有明顯收益；中文全域提高書名門檻造成正確定位退步，不採用。離線速度通過三秒，但新增 ordinal 書卷誤判與否定語意負例仍失敗，不視為自動跳轉驗收完成。

2026-11-02 v2 已補序數／否定／完整引用格式，並比較中文文字加發音重排，詳見 [v2 報告](../../reports/2026-11-02-whisper-small-chinese-v2.md)。回歸與新合成資料未新增錯誤候選，中文朗讀有收益；當時新混說資料全部拒答。依後續使用者決定，混說命中率不再阻擋交付，但主要語言正確率與其他 production gate 仍未通過。這些修正目前僅在實驗路徑，不代表應用功能已更新。

2026-11-02 [Turbo 中文驗證](../../reports/2026-11-02-turbo-chinese-validation.md)：長句保護版提高純中文定位率；後續 [英文獨立實測](../../reports/2026-11-02-speech-language-selection.md) 選擇 Small 為英文原型推薦。兩語言各自報告，混說不併入中文分母；兩語言比較均未觀察到新增錯誤候選，但不能推論現場誤跳為零。

2026-11-02 [引用拒答改善](../../reports/2026-11-02-reference-format-v3.md)：保留書名文字、受限結構修正、相同引用去重與英文引用格式；中文舊口令 154→161/226，新增挑戰 50→51/66；英文舊口令 164→168/172，新增挑戰 18→39/40。858 筆回歸／挑戰資料未新增錯誤候選或正確案例退步，離線均在三秒內。中文提示與 beam search 未獲淨收益，模型方向不變。最終規則使用過新增資料修正，不能稱盲測；仍僅在 benchmark，兩語言未達 98% 或 production gate。

2026-11-02 [中文分段與延遲驗證](../../reports/2026-11-02-chinese-segmentation-latency.md)：保留只裁前後數位零值與全零略過的 benchmark 原型。505 筆回歸定位不退步、無新增錯誤候選，離線 P95 1.127s、最大 2.829s；中文口令仍 212/292，尚未達 98%。內建 VAD 預設失去 1 個正確定位並增加 3 個錯誤候選，600 ms 切句失去 4 個正確定位並增加 6 個錯誤候選，均不採用。排程預算不等於現場端到端測量；英文設定與產品 runtime 未改變。

2026-11-02 [中文 Turbo Electron 操作流程實測](../../reports/2026-11-02-chinese-electron-flow.md)：開始開發限定的 native runtime → IPC → AudioWorklet → Bible 預覽垂直整合。模型與索引先 ready 才收音；停止／離頁／手動導航／搜尋／切譯本均取消本次跟隨。以即時合成音訊經真正 Electron 流程量測「來源最後非零音訊樣本到可見目標經文」，分開記錄模型準備時間，不再以離線辨識耗時代替畫面定位。505 筆原有 transcript 的定位決策完全一致。首輪 40 筆有 1 筆畫面可見性未達標，已保留失敗證據並補上預覽捲動校正；最後 56 筆即時合成輸入的桌面流程保留原有 22 個正確定位、另恢復 2 筆，26 個負例全拒答，無新增錯誤跳轉；成功定位 P95 1.819 秒、最大 1.937 秒。這是選定回歸案例，不取代完整準確率分母。英文沿用現狀，真人由使用者核對。這不是 Phase 0 全部通過或 production-ready：本輪未完成自動安裝、正式發行 runtime、真實噪音端點與 Windows 驗收。

2026-11-02 [持續背景噪音實驗](../../reports/2026-11-02-chinese-noise-endpoint.md)：受限音量平衡在輕度穩定合成噪音的 96 筆離線案例（含小聲後置否定）保留 40/40 正確定位、56/56 負例拒答；搭配保留完整音訊的長句運算範圍配置，10 筆測試工具驅動的 Electron 整合案例全部在三秒內完成，成功定位最大 2.834 秒，無新增錯誤候選。較強噪音仍有 4 筆錯誤候選與 2 筆定位退步，未通過安全 gate，因此僅保留為明確旗標控制的 benchmark 實驗，不啟用通用噪音環境自動跟隨。噪音端點由測試工具觸發現有完成一句流程，尚不是正式自動校準／分句 UI。英文及真人錄音不變；正式驗收與後續 production phases 仍開放。

## 9. Acceptance and measurement protocol

以下是目標，不是已測成績。Phase 0 固定語料、硬體、量測起訖與樣本數；校準與驗收語料分開，不能用同一批調門檻再宣稱正確率。

- 中文與英文各至少 200 個完整 reference 樣本，涵蓋全部 66 卷、numbered books、零、範圍、章節邊界與同語言自我修正。混說既有至少 50 筆另列為相容性回歸，不併入主要語言正確率分母，也不設混說命中率發布門檻。
- 每種語言至少 100 個已指定譯本的 quotation 樣本，涵蓋逐字、跨節、近似段落與改述；分開報逐字／改述，不承諾全部意譯能定位。
- 原 reference 定位率目標為各語言 >=98%；依最新使用者決定，英文現有約 97.6% 合成回歸結果先予階段性接受，不再追分或阻擋中文優化，中文繼續朝 98% 改善。各自完整口令最後音節至穩定候選的 P95 <=3 秒，另列最大值及超時筆數。每種語言分開比對基線，不能增加錯誤定位；低信心拒答計為未成功定位，不能用大量拒答灌高正確率。離線 ASR 加定位耗時僅為預驗證，不替代端到端量測；正式真人／平台／穩定性 gates 仍保留。
- 逐字／輕微口語變動的 quotation，至少 8 個中文字或 5 個英文詞，在固定譯本測 top-3 recall >=95%；改述單列。同時報 false positives，不把所有內容回傳三筆就算成功。
- 自動 preview 對人工標記無引用的講道、音樂、靜音合計至少 2 小時測試，目標 <=1 次錯誤定位／小時；任何自動變更 projection owner／內容皆為失敗。正式語料的模糊片語與相似經文另外檢查。
- 必測 A 正在投影、語音預覽 B、操作者按 next/previous verse/chapter：繼續 A 並暫停跟隨；明確投影 B 後才從 B 繼續。另測 projection owner 已是 Timer／Media 時的候選更新不搶 owner，延續現有快捷鍵作用域。
- 最低設備上連續運行 >=2 小時，與既有投影／媒體播放同時執行；記錄 CPU、RSS、音訊 backlog、UI responsiveness 與延遲分位數，warm-up 後不可持續累積記憶體或延遲。
- 每平台至少 5 次 cold／warm startup，記錄安裝大小與下載／驗證／載入各階段時間；Phase 0 根據固定最低硬體訂出具體 startup/RAM/CPU 上限，未訂出前不得標記 production-ready。
- macOS arm64／Windows 實際安裝包測：乾淨安裝、斷網、磁碟不足、斷下載、checksum 不符、取消後重試、同時 install、舊版升級、runtime crash、麥克風拒絕／拔除、切語言、sleep/wake、離頁與重啟。
- 斷網辨識需驗證沒有模型/tokenizer/runtime 資源的隱藏網路依賴；網站另實測兩語言支援與不支援狀態。離線經文資料與搜尋索引也必須預先準備。
- 索引升級必測「已存在舊 cache → 更新 normalizer/schema → 離線重建 → 繁簡／英文標點搜尋」，結果需與乾淨安裝一致；另測跨節／重複段落的重排分數與拒答，保留 canonical 譯本文字。
- 現場驗收使用經同意的音源，涵蓋台灣華語、多位講者、講台麥克風／混音台及一般電腦輸入。無錄音授權時使用自錄／合成語料，不擅自收集聚會音訊。

實作 PR 必跑：`npm run lint`、`npm run typecheck`、`npx vitest run`、`npm run build`、`npm run build:web`、`npm run test:e2e:browser`。native 修改另跑對應 native checks、打包 E2E 與雙平台 smoke；手動在 Electron dev 與 browser 檢查權限／console。單元 mock tests 不替代 real-engine fixture 和 packaged tests。

原文件階段僅做格式／連結與既有測試。2026-11-02 已依使用者授權下載公開模型並執行本機 benchmark；未打包或發布。Windows 目標為 Windows 11、Intel i7（世代待確定）、32 GB RAM，尚未實測。

## 10. Consultant review and remaining evidence

本輪 1 位獨立 Codex 顧問已完成計畫與相關程式的唯讀審查，沒有執行測試、上網或驗證模型。結論為可開始 Phase 0，但有 3 個需補齊的契約及 2 個值得做的優化；全部已納入：

| 類型     | Finding 與證據                                                          | 處理                                                                 |
| -------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 必須修訂 | `BiblePage.tsx` next/previous 以 preview 為基準，語音跳頁會間接影響投影 | §3 分離 candidate／committed passage；§9 加 A→B→next/previous E2E    |
| 必須修訂 | 現有 builder／release 明確 unsigned，不能假設有可信簽署發行             | §5 記錄現況、責任與發行 gate；本地實作可先進行，不能冒稱完整發布就緒 |
| 必須修訂 | query normalization 與既有 raw index／cache identity 不一致             | §6 共用 normalizer、索引版本化；§9 加舊 cache 升級驗證               |
| 採納優化 | 搜尋只回傳 IDs，無法直接計算候選信心差距                                | §6 有界候選重排與分離 ASR／retrieval 評估，保留手動 API              |
| 採納優化 | 既有 Bible phrases 可改善領域詞彙，但 bias 也會造成 false positives     | §4 加有／無 bias A/B，只有淨改善才啟用                               |

主代理另補網站舊 API key 精準清理。沒有未處理的本輪文件 finding；這不表示工程驗證已完成。

前一輪程式顧問已完成；兩位 Gemini 呼叫逾時且無分析內容，不能列為同意本計畫。引擎、browser 能力與效能門檻以 Phase 0 實測為準。

## References

- [sherpa-onnx streaming models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html)
- [whisper.cpp official repository](https://github.com/ggml-org/whisper.cpp)
- [MDN: Using the Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API)
- [M5 Bible workflow](../../roadmap/milestones/M5-bible-professional-workflow.md)

官方文件於前一輪 2026-11-01 分析查閱；只支持候選能力，不構成本專案 benchmark 或特定模型散布授權確認。
