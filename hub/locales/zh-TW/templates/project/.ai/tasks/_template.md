---
id: YYYYMMDD-任務名稱    # 任務ID，一個任務一個檔案。
title:                  # 任務名稱，顯示於清單。
role:                   # roles.yaml 的角色鍵，保留內部識別值。
phase:                  # PROJECT.md 的 phases 名稱；留空使用目前階段。
owner:                  # 負責人：claude-code / codex / discord:サンプル担当 / 人。
via:                    # 透過 Discord 交辦的位置，例如 #範例工作。
state: 実行中           # 內部值：未着手 / 実行中 / 返事待ち / 停止 / 上限で停止 / 完了。
workdir:                # 與 PROJECT.md 位置不同時填寫，例如 Work/ 工作副本。
model:                  # 本任務指定模型，留空使用角色設定。
effort:                 # 本任務指定思考程度：中 / 高 / 極高 / MAX / Ultra。
question:               # 給人的問題，顯示於「輪到你了」。
skills: []              # 使用的技能，每次使用後新增。
updated: YYYY-MM-DD HH:MM
---
## 步驟（3～5個，完成後勾成 [x]；全勾後等待確認完成）
- [ ]
## 已完成的工作（含變更檔案與測試結果）
## 下一步
## 注意事項
