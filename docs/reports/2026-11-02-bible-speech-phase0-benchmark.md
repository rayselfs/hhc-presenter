# Bible 本機語音 Phase 0 實測報告

日期：2026-11-02。範圍：模型與解析／檢索實驗；未修改應用功能、移除 Azure、打包或發布。

## 使用者補充：三秒與 GPU

2026-11-02 使用者接受三秒內的延遲，並強調不能犧牲品質。計畫現以最後音節至穩定候選 P95 <=3 秒作為量測門檻，準確率要求不變；以下原始實測數字與當時兩秒門檻的決策紀錄保留。Small 仍是原型基線，尚未鎖定最終出貨模型。Turbo 在本輪已啟用 Metal，quotation decode P95 仍為 3.57／3.76 秒，尚未證明符合新門檻，應保留為品質候選而不是直接排除。

同一 140 段中，Small Metal 的中文／英文 quotation P95 為 0.914／0.976 秒，CPU-only 為 3.083／5.385 秒；本機實測顯示 GPU 加速有明顯幫助。GPU 主要降低推論時間，不會直接修正同一模型的辨識品質，但可讓更高品質模型進入可接受延遲範圍。Windows 應依實際 GPU 型號選擇與驗證 backend，不能從 i7 或 32 GB RAM 推定 GPU 能力。

## 決策與階段狀態

建議以 **whisper.cpp + multilingual Whisper Small** 作為下一階段 Electron 原型的預設基線，中英文共用語音包，由使用者選中文或 English 作為主要語言。這是本輪已完整比較方案的速度／準確率折衷，不是所有免費模型中的最優證明，也不是 production 驗收通過。Python binding 僅用於實驗，不建議因此為 Electron 增加 Python 部署依賴。

**Mac 合成語料比較完成；Phase 0 正式退出條件尚未全部滿足。** 真人音源、Windows 實機、麥克風到穩定預覽延遲、長時間及安裝包驗證仍缺。不要將本報告的檢索命中率當作現有產品已能自動正確跳轉。目前沒有任何方案證明達到完整 reference 定位 >=98% 的目標。

使用者指定 Windows 11、Intel i7、32 GB RAM。i7 世代、GPU 與實機存取尚未提供；Mac CPU-only 測試不能替代 Intel 實測。建議後續指定完整 CPU 型號，原樣搬移本輪已記錄 hash 的音訊，在目標 Windows 電腦重跑。

## 測試方法與可追溯性

- 實測：Apple M4、10 logical CPUs、24 GiB RAM、macOS 27.0.1。來源程式 commit `5c3ca4f40947371402b597b2059c868b45633ebc`。
- 共 660 段合成音訊，約 43.6 分鐘：中文／英文各 200 references、各 100 quotations、50 中文主語言混說、各 5 非引用句。涵蓋全部 66 卷，quotation 各含 10 段跨節。
- 中文使用 Meijia、Eddy (Chinese (Taiwan))；英文 Samantha、Daniel；語速 150／175／195。來源為本機 macOS TTS，沒有教會私人錄音、麥克風擷取或雲端 ASR。
- 中文 CUV、英文 KJV。語料、來源版本、模型 revision、SHA-256、runtime native binaries hash 均留存於 [evidence](evidence/bible-speech-phase0-20261101/)。模型與音檔未納入 repository。
- 固定 20% calibration／80% holdout。140 段 screening 為 calibration 加全部 negatives，包含兩種聲音；A/B 使用相同 IDs。完整 660 成績是描述性比較，不能用同一批數據調參再當盲測。
- 模型逐一執行，不並行競爭 ASR 資源。Whisper 使用 Metal、4 CPU threads、明確 `zh`／`en`；Sherpa CPU 4 threads；Transformers.js 使用 Node CPU ONNX Runtime，**不是實際 Electron Worker／browser WASM**。
- 中文先繁簡與數字正規化後計 CER，英文數字正規化後計 WER；標點不計。插字可使錯誤率超過 100%。固定語料未人工逐段聽辨，TTS 書卷／混說發音與模板相關性可能偏置排名。

此輪沒有真人口音、現場混音台、回音、噪聲、靜音／音樂長片、完整自我修正／範圍／改述涵蓋。符合樣本數並不代表符合計畫的全部語料內容要求。

模型檔案大小（十進位 MB，不含 runtime）：Base 148 MB、Small 488 MB、Turbo Q5_0 574 MB；Sherpa int8 encoder／decoder／joiner 共 198 MB、FP32 共 357 MB。原生實驗使用 pywhispercpp 1.5.1、sherpa-onnx 2.0.1；Node 使用 @huggingface/transformers 3.8.1。完整 artifacts 與版本見 manifests。

## 完整語料比較

以下為已完成 660 段的設定。文字錯誤率只列 quotation 子集，各語言 100 段。Top-3 是獨立檢索 probe，並非產品目前的搜尋結果。

| 設定          | 中文 CER | 英文 WER | 中文／英文 Top-3 | 中文／英文 decode P95 | Peak RSS |
| ------------- | -------: | -------: | ---------------- | --------------------- | -------: |
| sherpa        |   101.3% |    27.1% | 90/100、96/100   | 1.951s、1.902s        |  438 MiB |
| sherpa-fp32   |    35.3% |    26.8% | 94/100、97/100   | 1.113s、1.663s        |  595 MiB |
| whisper-base  |    32.0% |    16.2% | 94/100、99/100   | 0.361s、0.623s        |  353 MiB |
| whisper-small |    23.9% |     5.6% | 99/100、100/100  | 1.314s、1.308s        |  594 MiB |

檢索 probe 在完整譯本上，以中文 bigram／英文 word IDF 取前 40，再對文字與相鄰節做重排；正確原文的 oracle Top-3 為中文 100/100、英文 100/100。因此這些朗讀經文對該 probe 本來較容易，不能外推到短片語、意譯、相似段落或一般講道。

四個完整配置的 10 段非引用句均未被 benchmark reference scorer 誤判為章節；這不是 quotation 拒答測試，也不足以估計每小時 false preview。

上述 decode 是**完整音訊已備妥後的計算時間**，不含收音、VAD 等待、穩定候選、UI 或投影。Sherpa 雖分 100 ms chunks 餵入，並未按真實時間播放；不是串流尾延遲。RSS 為程序高水位，可能未包含全部 GPU 記憶體。Sherpa threads=4 也不代表全程序最多使用四核心。

## 口令解析才是跳轉的另一半

直接執行目前產品 `parseVerseReference` 與 `matchBookName`，對照 canonical book/chapter/verse：

| 輸入                | 中文 reference | 英文 reference | 中文主語言混說 |
| ------------------- | -------------: | -------------: | -------------: |
| gold-text           |        198/200 |          0/200 |          30/50 |
| sherpa.jsonl        |         47/200 |          0/200 |           0/50 |
| sherpa-fp32.jsonl   |         94/200 |          0/200 |           5/50 |
| whisper-base.jsonl  |        108/200 |         52/200 |           0/50 |
| whisper-small.jsonl |        125/200 |         55/200 |           0/50 |

Gold 中文 198/200，英文 0/200、混說 30/50。英文測試使用 spoken chapter/verse grammar 與英文數字；現有 parser 缺少這條路徑，**不是所有英文引用都不支援**，例如 `John 3:16` 屬不同輸入形式。ASR 偶爾自動改成數字格式，才可能比 gold spoken grammar 得分更高。

測試工具另有嚴格書名 scorer，用於比較 ASR 輸出，不能與產品 fuzzy book matcher 分數混用。它已先驗證全部 450 筆 gold reference/mixed；但書名同音字仍會失敗。完整失敗輸入保留於 `product-parser.json`，可在下一階段變成固定回歸案例。

因此推薦順序是：補齊英文與混說 grammar、中文／英文數字及明確書名別名；使用候選排名、合理章節界線與拒答，再驗證實際跳轉。不能用廣泛 fuzzy matching 一律修正書名，也不能為追求 98% 而對模糊音訊強制跳轉。

## 補充比較與失敗紀錄

同一批 140 段 screening，quotation 各 20 段：

| 設定                     | 中文 CER | 英文 WER | 中文／英文 decode P95 |
| ------------------------ | -------: | -------: | --------------------- |
| whisper-base             |    29.8% |    10.9% | 0.305s、0.520s        |
| whisper-small            |    21.4% |     6.3% | 0.914s、0.976s        |
| turbo-screen             |    14.6% |     1.6% | 3.572s、3.761s        |
| transformers-screen      |    29.1% |    12.5% | 1.900s、1.657s        |
| whisper-small-cpu-screen |    21.4% |     6.3% | 3.083s、5.385s        |

Turbo Q5_0 的 140 段全部完成；quotation Top-3 中文／英文均 20/20，嚴格英文 reference 為 38/40，優於同批 Small 的 24/40；中文 reference 10/40 仍低。Turbo 峰值 RSS 約 795 MiB。其中文／英文 reference decode P95 為 4.081／3.646 秒，quotation 為 3.572／3.761 秒，已超過兩秒端到端目標。故未擴大到全 660、CPU、啟動或離線測試，也未選為快速定位預設。這是精度／延遲取捨，不是 Small 精度勝過 Turbo；未來若引擎最佳化或更強硬體改變此成本，應重新比較。

- Small 的全 66 卷 initial prompt A/B：中文 reference 書名嚴格命中 4→13/40，但 CER 28.8%→80.0%；英文 reference 命中 24→17/40。中文 quotation CER 21.4%→22.7%，英文 6.3%→6.6%。**不預設啟用全書卷 prompt**；這不代表經過校準的短詞彙提示一定無效。
- Sherpa FP32 beam 與 beam+hotwords：中文 reference 命中 3→9/40、英文 7→10/40；quotation 沒有整體改善，尚未超越 Small。這是固定 decoding method 的 A/B，不能把 beam 與 greedy 差異歸因於 hotword。
- Sherpa 官方 sample 以 int8／FP32、整段／100 ms chunks 都得到預期文字。TTS 上 int8 的部分重複輸出在 FP32 消失，故不能把量化變體問題推論為整個 Sherpa 引擎不可用。
- Transformers.js 初次全量跑到 135/660 主動停止，因反覆長輸出；該 partial run 不列完整排名。之後使用均衡 140 段重跑成功。先前 75 段 Sherpa diagnostic 僅含主要聲音，不列正式比較。
- 首次 Whisper 程式因 `initial_prompt=None` binding 型別錯誤，在推論前失敗；修正工具後 Base／Small 都完整重跑。不能將失敗的初次執行列為有效樣本。

## 啟動、離線與資源

| 引擎          | 五次 load 範圍 | 五次完整程序 wall time 範圍 |
| ------------- | -------------: | --------------------------: |
| sherpa-fp32   |   0.580–0.986s |                0.807–1.396s |
| whisper-base  |   0.146–0.219s |                0.386–0.483s |
| whisper-small |   0.330–0.443s |                0.939–1.044s |
| transformers  |   0.478–0.575s |                1.123–1.405s |

各設定五次新程序啟動；這些測量重用 OS／Metal caches，**不是五次真正冷啟動**。首次執行時另觀察到 embedded Metal library 編譯 27.554 秒，僅一筆。安裝後必須實際載入與自我檢查完成，才顯示「已就緒」；不能只根據檔案下載完成或上述 warm-cache 秒數決定 ready。

已在禁止網路的程序中各完成 Sherpa FP32、Small、Transformers.js 一段本地辨識，exit code 均為 0。只證明該已安裝配置的一段推論不依賴網路，不證明首次安裝、整個 Electron app 或經文索引已可離線。

Small 在 M4 CPU-only 的 140 段，quotation P95 中文 3.083 秒、英文 5.385 秒，已顯示無 GPU 加速時的延遲風險；不是 Intel i7 的測量。硬體適配不能只看 32 GB RAM。尚未訂出 Windows 可驗收的 CPU／RAM／startup 上限。

## 對下一階段的具體建議

1. Electron 以 whisper.cpp + Small 建立隔離程序原型，模型與 runtime 固定版本、hash，主要語言決定解碼語言，輸出轉成繁體顯示。保留手動搜尋；不要讓使用者挑模型路徑或設定檔。
2. 語音包由程式下載、驗證、原子啟用及預熱；以安裝與 runtime 兩個狀態呈現進度。下一階段還要實測取消、斷線、空間不足、checksum 不符及恢復，這輪沒有實作下載產品流程。
3. 先讓正確文字可靠解析，再接 ASR。補英文 spoken numbers、numbered books、混說與章節有效性；quotation 索引與 query 共用 normalization，重建舊 cache。語音定位只改操作預覽，投影仍需明確動作。
4. 真實串流採有界音訊窗口／VAD，量測最後音節到穩定候選，驗證是否需要預先產生 partial candidates。本輪批次 decode 不能替代此項設計選擇。
5. 將同一批 WAV 帶到具體 Windows 11 i7／32 GB 電腦重跑，並收集有同意的台灣華語／英文真人樣本。兩小時混合噪聲與媒體播放、false preview／小時、投影不搶 owner、麥克風與休眠恢復仍是必要 gate。
6. 網站維持 browser on-device 的獨立能力檢查與不支援狀態，不能因本輪 Node ONNX 成功就宣稱 browser 可用。沒有驗證前不回退雲端服務。

[whisper.cpp](https://github.com/ggml-org/whisper.cpp) 與 [Whisper 模型](https://github.com/openai/whisper/blob/main/LICENSE) 採 MIT；[Sherpa](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE) 採 Apache-2.0。模型卡與 runtime 資訊留存於 evidence，並不替代完整散布 notices／訓練來源調查。現有發行設定仍是 unsigned；簽章、mac notarization、內含 native runtime 與 Windows 打包 smoke 均未驗證。

## 重現與驗證

工具與命令見 [benchmark README](../../scripts/speech-benchmark/README.md)。大檔保存於本機 `/Users/rayselfs/Projects/hhc/.speech-phase0-20261101`；測試 worktree 為 `/Users/rayselfs/Projects/hhc/.worktrees/bible-speech-phase0-20261101`。本輪沒有提交、push、merge、release 或改動主 checkout 的既有文件。

已通過 benchmark 單元測試 5 項、相關既有 Vitest 5 檔共 119 項；benchmark JavaScript lint、文件／JavaScript 格式與本地連結檢查亦通過。所有完整結果為 660 筆、screening 為 140 筆，音訊及模型 hashes 已記錄。

未執行整個 app build、全套 CI、browser／Electron E2E、Windows smoke 或發行；本輪只增加實驗工具與文件，沒有修改應用 runtime。
