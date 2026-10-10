---
name: （專案名稱）
status: 進行中            # 內部值：未着手 / 進行中 / 停止中 / 完了。
updated: YYYY-MM-DD
phases:                   # role 使用 roles.yaml 的角色鍵；自動決定負責 AI。
  - { name: 規劃,       role: 司令塔,     state: 未着手 }
  - { name: 設計,       role: デザイン,   state: 未着手 }
  - { name: 實作,       role: コーディング, state: 未着手 }
  - { name: 審查,       role: チェック,   state: 未着手 }
  - { name: 最終確認,   role: 最終確認,   state: 未着手 }
folders:                  # 分散的位置也可填在此處，再從 Hub 開啟。
  資料:
  成果物:                 # 成品的位置；保留既有資料夾鍵。
related: []               # 可讀取資料的相關專案，例如 [範例應用程式, 範例文件]。
chats: []                 # 瀏覽器對話連結 { title, url }。
issues: []                # 問題 { text, level: 高/中/低 }。
# 任務的狀態與問題寫在 .ai/tasks/<任務ID>.md。
---

# 備註
