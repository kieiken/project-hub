# English language pack (draft)

Project Hub runs in Japanese. This optional pack shows the app in English. Texts without a translation stay in Japanese.

Install: unzip the pack, then in the app open [Settings] → "Language pack" → [Add language pack…], choose this folder, select English as the display language, and save.

Files: `ui.json` (screens), `backend.json` (messages from the app and to the AIs), `native.json` (Mac app window). Keys are the Japanese source text; values are the English text. Keep `${0}` placeholders, HTML tags, line breaks and Markdown marks as they are.

This is an AI-assisted draft for Project Hub source version 4.126.41. `verifiedWith` records the source version used for automated compatibility checks; it does not mean every screen has been reviewed. Corrections are welcome as Pull Requests — see CONTRIBUTING.md, section "言語パック". The glossary is in `docs/GLOSSARY.md`.

Check before sending: `HUB_I18N_STRICT=1 node hub/test/run.cjs ../langpacks/en/test/en-pack.test.js`

The voice notices and button labels use this pack. Speech recognition stays Japanese (`ja-JP`); the display language does not change what language you can dictate. Automated checks used simulated recognition in isolated Chrome, not a real microphone or a Windows/iPhone app.

The pack has 53 native dictionary entries. The source Mac launcher (`hub/app/window.swift`) reads these entries where it uses its translation helper. The separate release-candidate window is built from `hub/staging-app/Window.swift` and still has fixed Japanese messages; its system microphone and speech-recognition purpose descriptions also remain Japanese. This pack update does not change either launcher or certify English display on a packaged Mac or Windows app.

For 4.126.41, this update adds 101 UI entries, including the three new Muse notices. Existing translations and all 53 native entries are preserved. The marked-source scan covers literal and conditional `UI.text` / `UI.message` calls, `UI.html` / `UI.template`, backend `lt`, and native `tr` calls; it is not a guarantee that every screen is translated.

In 4.126.42, the chat send button uses the existing translations for `Send` / `Send to Muse`. This pack is verified with 4.126.42; dictionaries are unchanged from the 4.126.41 update.

Known product limits: template interpolation values are not translated automatically. Some Muse status/action labels remain Japanese. Muse result toasts that call `UI.text` can use the new entries, but pending notices, saved event text and error toasts that bypass translation still show the original Japanese. The earlier send-button failure in the Traditional Chinese suite is resolved by the 4.126.42 product fix; test expectations are unchanged.

For 4.126.44, six sidebar search entries were added and the compact search form uses this pack. Existing translations are preserved; verifiedWith is 4.126.44.
