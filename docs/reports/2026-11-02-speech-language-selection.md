# Separate Chinese and English speech acceptance

日期：2026-11-02。建議原型：**中文使用具長句保護的 Turbo；英文使用 Small 加固定簡短提示。** 語言 selector 只顯示「中文／English」，模型、提示、下載路徑與安裝由程式管理。這輪只更新計劃與 benchmark，尚未變更產品預設或 runtime。

## Scope and selection protocol

使用者確認通常不會中英混說。中文／英文各自驗收口令、朗讀、拒答、錯誤定位與延遲，不混合平均；混說命中率為非阻擋相容性指標，錯誤定位的安全保護仍保留。主要語言 reference >=98%、P95 最後音節至穩定候選 <=3 秒及不新增錯誤定位的 gate 不降低。

M4／24 GiB、Metal、4 threads。英文使用相同合成 WAV、相同 target、相同 v2 `phonetic-0.85` 定位政策；不為 Turbo 放寬格式或 fuzzy 門檻。兩個模型都重新推論，依序執行，不並行競爭資源。配對工具驗證 ID、音訊 SHA-256、target、kind、duration，新增語言參數與空集合拒絕，避免英文資料被舊中文篩選器誤濾成零樣本。

先跑英文校準集 61 筆：40 口令、20 朗讀、1 負例。Small 沿用前輪已選定的英文 hint／簡短 Bible prompt；Turbo 比較有無相同 prompt，均使用 768 context 加音訊長度保護。

| Calibration profile  | References /40 | Quotations /20 | Wrong /61 |
| -------------------- | -------------: | -------------: | --------: |
| Small + short prompt |             37 |             17 |         0 |
| Turbo, no prompt     |             38 |             20 |         0 |
| Turbo + short prompt |             38 |             20 |         0 |

Turbo prompt 沒有額外命中收益，故固定無 prompt 版本再跑後續比較，不事後依回歸答案切換設定。校準結果不計入下列成績。

## English results

第一批 272 筆（160 口令、80 朗讀、32 負例）；第二批 22 筆按前輪原文去重排除 `v2-129`，保留 12 口令、9 負例。`v2-097` 為中文，不在英文輸入。合計每個模型 293 筆、252 正例。這些都是已使用過的合成回歸資料，不是新真人盲測。

| Dataset / kind |       Small correct |     Turbo correct |
| -------------- | ------------------: | ----------------: |
| 第一批口令     |             152/160 |           145/160 |
| 第一批朗讀     |               72/80 |             73/80 |
| 第二批口令     |               12/12 |             10/12 |
| 合計口令       | **164/172 (95.3%)** |   155/172 (90.1%) |
| 合計朗讀       |       72/80 (90.0%) | **73/80 (91.3%)** |
| 合計正例       | **236/252 (93.7%)** |   228/252 (90.5%) |

兩者皆為零錯誤候選；41 個負例全部拒答。正例拒答 Small 16、Turbo 24。逐筆比較，Turbo 多命中 7 筆、原本 Small 正確卻拒答 15 筆，淨少 8 筆。英文不應為了朗讀多 1 筆，交換口令少 9 筆與較高等待時間。

| English offline timing |  Small |  Turbo |
| ---------------------- | -----: | -----: |
| P95, 293 samples       | 0.455s | 0.970s |
| Maximum                | 0.772s | 1.814s |
| Over 3 seconds         |      0 |      0 |

三段超過 15.36 秒的英文朗讀仍包含在主表；Turbo 的長句保護使用完整 context，沒有裁掉音訊或排除樣本。時間含推論、正規化與定位，索引已建立；不含收音、VAD endpoint、IPC、UI，不能當成現場三秒已通過。少量本機文件／工具工作並行，不是完全隔離系統負載的效能認證。

部分 Turbo 退步來自輸出引用縮寫，例如 `1 Samuel 1 verse 1`、`1 Corinthians 8 3`，以及書名拼寫失真；目前嚴格規則拒答。結論是 **Small 在目前完整辨識＋定位流程較適合英文**，不是證明 Turbo 在所有英文 ASR 任務都比較差。後續若改支援引用縮寫，必須對兩者同時重跑並加入否定、範例、日期及不完整引用負例，不能只修已看到的答案。

## Language-specific recommendation

中文沿用上一輪已實測的 [Turbo 長句保護結果](2026-11-02-turbo-chinese-validation.md)，本輪沒有重新推論中文；下表中文分母排除混說。

| Primary language | Recommended prototype                                     | Reference accuracy | Quotation localization | Observed wrong candidates |
| ---------------- | --------------------------------------------------------- | -----------------: | ---------------------: | ------------------------: |
| 中文             | Turbo Q5_0, Chinese hint, no prompt, length-aware context |    154/226 (68.1%) |         89/100 (89.0%) |                         0 |
| English          | Small, English hint, fixed short Bible prompt             |    164/172 (95.3%) |          72/80 (90.0%) |                         0 |

中文 Small 對照為口令 136/226、朗讀 68/100；Turbo 對兩類皆有收益。英文則保留 Small。兩者使用同一 whisper.cpp 引擎，一次只載入一個模型，不需要多引擎競速或逐句自動猜語言。切換語言時由程式切設定與準備需要的語音包，已驗證資源可重用，尚未 ready 不啟用麥克風。

主要語言 selector 不等於模型強弱排行。若未來保留「標準／加強」選項，必須在該語言有實測收益，不能把 Turbo 一律標成較準的英文方案。混說相容性仍記錄，不再阻擋此語言別方向。

## Remaining gates and evidence

兩種語言的 reference 仍低於 98%，英文驗收集排除校準後也只有 172 口令／80 朗讀，未滿計劃要求的至少 200／100；不能把校準資料併回去補足驗收。Quotation 上表是保守自動定位率，與計劃 top-3 recall 指標不同，不能互相替代。零觀察到的錯誤候選不等於現場誤跳率為零。

真人錄音待使用者核對；Windows 11 i7／32 GB、端到端三秒、長時間負例／穩定性、安裝與 UI 導航尚未完成。更新後的 [計劃](../superpowers/plans/2026-11-01-bible-local-speech-production.md) 保留這些 gate。沒有產品 runtime 變更，未跑全 app build／完整 CI，未 push／merge／tag release。

14 項 benchmark Python tests 通過，含語言分離、空集合拒絕、配對完整性及長句 context 邊界。[Evidence](evidence/speech-language-selection-20261102/) 保留校準、完整逐筆推論／定位、固定選擇、配對摘要、source hash 與驗證紀錄，不含私人錄音／逐字稿。[README](../../scripts/speech-benchmark/README.md) 記錄重現方式。
