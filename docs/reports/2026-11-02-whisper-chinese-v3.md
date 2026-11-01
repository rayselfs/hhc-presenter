# Chinese speech follow-up: language decoding and private recordings

日期：2026-11-02。Engineering issue：[#197](https://github.com/rayselfs/hhc-presenter/issues/197)。仍在 Phase 0；沒有變更產品 runtime，沒有通過 production acceptance，也沒有 merge／tag release。

## Calibration results

沿用 v2 固定 `phonetic-0.85` 定位政策，不因新模型輸出放寬書卷、否定或引用格式門檻。M4／24 GiB；Whisper 使用 Metal，SenseVoice 使用 CPU／4 threads。下表是同一批合成校準資料的正確定位數；不是新盲測或真人準確率。

| Configuration                           | Chinese references /40 | Chinese quotations /20 | Mixed /10 | Wrong candidates /71 |
| --------------------------------------- | ---------------------: | ---------------------: | --------: | -------------------: |
| Small, Chinese hint (previous baseline) |                     22 |                     11 |         5 |                    0 |
| Small, automatic language               |                     22 |                     11 |         5 |                    0 |
| Small, English hint on Chinese input    |                      0 |                      0 |         0 |                    0 |
| Turbo Q5, audio context 512             |                     25 |                     11 |         5 |                    0 |
| Turbo Q5, audio context 768             |                     28 |                     15 |         5 |                    0 |
| SenseVoice int8                         |                     21 |                     12 |         5 |                    0 |

三種正例合計 70 筆，另有一筆負例；零錯誤候選的負例覆蓋非常有限。所有拒答都保留在分母，沒有算成成功。

- 不採用 Small 自動語言或英文重試：沒有定位收益。自動語言的中文朗讀 P95 為 3.326 秒，71 筆中 3 筆超過三秒。
- Turbo context 768 值得做後續回歸：校準正例 38→48/70，但混說仍只有 5/10。口令、朗讀、混說離線 P95 分別 1.732、1.238、1.235 秒，71 筆未超過三秒。縮短 context 可能截斷較長音訊，必須另測長句與分段邊界；不能直接套用到 20 秒錄音窗口。
- SenseVoice 很快，但未帶來整體正確率突破。中文口令、朗讀、混說 P95 分別 0.139、0.370、0.070 秒；英文校準口令 19/40、朗讀 17/20。暫不增加第二條產品引擎或串接雙模型。
- SenseVoice 權重使用自訂模型授權，尚未確認產品散布條件；不能當成 Apache/MIT 已完成授權審查。[模型卡](https://huggingface.co/FunAudioLLM/SenseVoiceSmall/blob/main/README.md)、[模型授權](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)。固定下載 revision 與 hash 見 evidence manifest。

離線時間包含先前實測推論與本輪定位計算；沒有麥克風、VAD endpoint、IPC 或 UI 延遲。校準集只用來決定值得進一步測的設定，不作 98% acceptance 證據。

## Private real-recording review

使用者提供 11 份錄音與 11 份對應 AI 逐字稿，總長約 116 分鐘。以檔名逐一確認配對，每份都只有一個對應文件；不依資料夾排序猜配對。來源與衍生檔全留在 Git 外的私人資料目錄。

錄音轉為 16 kHz mono，建立 393 個最長 20 秒、重疊 2 秒的片段，依序執行 Small 與 SenseVoice。本輪用途是找出值得核聽的時間點，不是模擬即時音訊管線。重疊片段不是獨立引用事件，不能重複計入命中數。

兩個模型均完成全部 393 個片段，沒有缺漏 ID；整理出 92 個待核聽候選窗口。以下只報離線推論時間，不包含定位，也不是現場最後音節到畫面的延遲。實驗期間曾執行輕量文字核對／工具測試，並非完全隔離負載的效能認證。

| Engine          | Decode P50 | Decode P95 | Maximum | Over 3s |
| --------------- | ---------: | ---------: | ------: | ------: |
| Whisper Small   |     1.158s |     1.760s |  3.485s |   1/393 |
| SenseVoice int8 |     0.349s |     0.421s |  1.421s |   0/393 |

尚無核聽確認的 gold labels，所以不報這批真人錄音的定位正確率、CER/WER 或誤跳率。速度快不能取代品質驗證。

AI 文件註明需要聆聽校正，所以不能當作標準答案。新增本機核對頁，提供音訊播放、兩個模型文字及相關 AI 逐字稿段落；所有項目保持 `human_verified: false`、`expected_reference: null`。字串相似度與模型一致都不會升格成人工標註。頁面包含私人內容，不上傳、不放進 public evidence。

候選頁只挑選引用格式或相關逐字稿片段，會漏掉部分意譯及一般談話。因此不能用其子集推算整場誤跳率；後續仍要核對一般談話、靜音、歧義引用及 session 上下文失效。相對引用應使用既定 plan 的有期限上下文，不能靠猜測最近書卷補齊。

評分工具現在明確拒絕 `unlabeled` 輸入。早期私人推論 raw output 的空參考 edit count 沒有意義，僅保留推論時間與文字作核對，不報 CER/WER 或正確率。

## Evidence and next gate

[Synthetic calibration evidence](evidence/whisper-chinese-v3-20261102/) 包含逐筆推論、固定政策結果與模型 manifest，不含私人錄音／逐字稿。工具使用方式見 [README](../../scripts/speech-benchmark/README.md)。

下一個可驗證步驟是核聽並凍結真人標註，區分完整引用、相對引用、朗讀、一般談話與不應跳轉；再量測 production policy 的定位率、拒答、錯誤事件與最後音節到穩定候選時間。Windows 11 i7／32 GB 尚無可操作設備，不能用 Mac CPU-only 結果代替 Windows 驗收。既有 98%／三秒／不增加錯誤跳轉 gate 保持不變。
