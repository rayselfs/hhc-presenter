# Chinese segmentation and latency validation

日期：2026-11-02。英文 Small + v3 設定維持不變。中文保留 Turbo Q5_0、中文 hint、greedy、無 prompt、context 768 與長句保護；只比較音訊邊界處理，不放寬定位／否定門檻。所有本輪測試均為已知合成音訊，未把私人逐字稿當標準答案。

## Safety before shorter audio

只要切掉書卷、序數、章節或否定語意，即使推論較快也不採用。本輪比較：

- Energy crop：20 ms RMS >=0.001，句首句尾保留 300 ms，不切內部停頓。低於門檻的微弱前綴仍可能被刪掉；單元反例確認此風險。新增的 24 段音訊中未實際刪除非零 sample，不能把單元反例說成這 24 段的實測失敗。
- Digital crop：只裁前後數位零值，保留 300 ms 與每一個非零 sample，內部停頓完整保留。原音訊 SHA 與實際送入模型的 payload SHA 分開記錄。這只能保證聲音資料未刪除，不能保證 Whisper 對 padding 改變完全不敏感，仍需定位回歸。
- Built-in VAD：使用本機 pywhispercpp 1.5.1 的原生預設分段與 [ggml-org 的 Silero 模型](https://huggingface.co/ggml-org/whisper-vad/tree/9ffd54a1e1ee413ddf265af9913beaf518d1639b)，版本／大小／SHA 留存於 evidence；沒有修改主辨識模型，也未加入產品設定。此試驗不代表所有 VAD 設定都無效。
- Endpoint diagnostic：在已知合成拼接邊界模擬 600 ms 停頓就切開，真的對各片段重新 ASR。它是用已知邊界測試切句後果，不是完成一個現場 VAD。

## Paired screens

M4／24 GiB、Metal、4 threads；單次只執行一個 ASR。第一輪 81 筆為 71 個中文 calibration 加 10 個長句／邊界案例。第二輪加入兩個聲音、0.2／0.8／1.2 秒句中停頓、前置／後置否定與 0.02 倍音量前綴，共 24 個新案例，另加入既有中文負例，合計 167 筆。數位裁剪在同一個常駐模型中逐筆交替先後順序，不使用不同批次的速度差宣稱精確加速倍率。

| Experiment                | Cases | Correct candidates, whole → candidate | Wrong candidates | Offline maximum, whole → candidate | Decision                                 |
| ------------------------- | ----: | ------------------------------------: | ---------------: | ---------------------------------: | ---------------------------------------- |
| Energy crop               |    81 |                               56 → 56 |            0 → 0 |                     2.281 → 4.342s | 無速度收益證據，另有小聲前綴風險，不採用 |
| Digital crop, interleaved |   167 |                               62 → 62 |            0 → 0 |                     3.224 → 2.701s | 通過初篩，擴大回歸                       |
| Built-in VAD              |   105 |                               62 → 61 |            0 → 3 |                     3.224 → 2.209s | 品質退步，不採用                         |

各列分母不同，不能拿 correct 數量跨列比較。167 筆包含 48 口令、24 朗讀、12 非阻擋的混說與 83 負例。數位裁剪後保留全部原正確候選，83 負例全拒答；口令 P95 1.501→1.080s，整體 P95 1.751→1.355s，超過三秒 1→0。這是一次交錯測試的觀察，不是長期效能保證。

內建 VAD 在 `0155` 失去原正確書卷辨識；在 `segment-003`、`007`、`011` 的小聲「請不要切換到」前綴案例，輸出只剩可定位的經文，形成三個錯誤候選。不能用這種方式換取更低延遲。

## Short endpoint regression

24 個完整語句拆成 40 段，按完整語句意圖評分並以 source ID 聚合，任何片段的錯誤候選都計入。原本 6 個正確口令只剩 2 個可定位，**失去 4 個正確定位、增加 6 個錯誤候選**。尤其前／後否定與經文分開後，片段本身可能看似有效引用。未執行 UI 導航，因此這是錯誤候選風險，不是已量測的現場誤跳率。

片段沿用完整語句的 expected target 是為了驗證整體意圖；不得把片段對完整文字的 CER 當作辨識準確率。後續需保留完整音訊／語意與 revision，中間候選不能在短停頓時直接發出導航。

## Exact-zero fast path

新增 benchmark-only `--skip-digital-silence`，只有所有 sample 都為零才略過 ASR。6 個純靜音案例仍全拒答，crop/check 加定位最慢 0.000250s；正常語音與小聲否定句的對照仍執行辨識，既有定位結果未退步。單元測試確認即使只有一個正／負最低 PCM 非零 sample 都不略過。真實麥克風底噪通常不符合這個條件，不可把它當成完整噪音抑制。

## Full Chinese regression

對既有 505 筆中文回歸重新處理：244 筆實際改變前後零值 padding，4 筆全零略過模型，其餘仍以原音訊推論。原始 WAV SHA、裁剪後 payload SHA、每個非零 sample 的保留與 baseline 的 frozen grammar hash 均已核對。

| Kind           | Cases | Correct before → after | Wrong after | Candidate P95 | Candidate maximum |
| -------------- | ----: | ---------------------: | ----------: | ------------: | ----------------: |
| 中文口令       |   292 |              212 → 212 |           0 |        1.095s |            1.788s |
| 中文朗讀       |   100 |                89 → 89 |           0 |        1.183s |            2.829s |
| 混說（非阻擋） |    51 |                14 → 14 |           0 |        1.118s |            1.147s |
| 負例           |    62 |        全拒答 → 全拒答 |           0 |        1.120s |            1.151s |

**原正確案例退步 0、增加錯誤候選 0，505 筆離線處理全在三秒內；整體 P95 1.127s、最大 2.829s。** 回歸 baseline 沿用前輪真實 ASR 記錄，不能拿其時間與本次新推論直接推論加速倍率。只有前述 167 筆交錯比較是本輪同步的速度對照，而且也不是多輪受控負載測試。

篩選與回歸合計 606 個不同 source ID；重複測量及 40 個切段不能當成獨立新增語料。這是合成回歸／挑戰，不是盲測或真人定位率。中文口令仍為 212/292（72.6%），本輪改善處理方式而沒有提高定位率；98% 目標仍未達到。先前出現超過三秒的慢測量仍保留，本輪通過不構成所有系統負載下的時間保證。

結論：保留「只裁前後數位零值、保留 300 ms、全零略過」為 benchmark 原型；淘汰本輪 energy crop、內建 VAD 預設與硬式 600 ms 切句。逐筆記錄與 protocol 見 [evidence](evidence/chinese-segmentation-20261102/)。

## End-to-end budget and limits

目前產品仍是舊有 renderer Whisper adapter／worker 路徑：固定兩秒送出並清空 batch，與本輪 native Turbo 原型不同。因此不能把離線推論結果稱為產品「最後音節到穩定畫面」驗收。

另用 24 個已知合成邊界與實測處理時間計算排程預算：停頓 300 ms 開始暫存辨識，續講就失效但保留完整音訊，單一 inference flight，至少等待 1500 ms 穩定期且取得最新完整結果才准出候選。公式為 `start=max(last_speech_end+0.3, previous_request_end)`，`ready=max(last_speech_end+1.5, start+measured_final_processing)`。需計入前一次尚未完成的辨識造成的排隊。

這個**已知邊界排程模型**得到 P95 1.500s、最大 1.709s；不是實機端到端測量。它沒有驗證現場聲音邊界、收音／重採樣、冷啟動、IPC、畫面更新或噪音。超過穩定期才出現的後置修正仍可能造成提早候選，不能因這個模型的數字就宣告解決。保留這個方向供後續 runtime 原型驗證，沒有直接上線。

## Validation and delivery boundary

24 個 Python 測試通過，新增腳本語法檢查通過；引用評估執行既有 Node assertions。私人音訊、AI 逐字稿與核對資料未進 Git。本輪只有 benchmark、合成證據與計劃；沒有變更產品語音設定、執行完整 app CI、推送、merge、tag 或 release。真人核聽仍由使用者稍後完成；Windows 11／i7／32 GB 與現場端到端驗收未完成。
