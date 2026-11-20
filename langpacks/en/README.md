# English language pack

Project Hub runs in Japanese. This optional pack shows the app in English. Texts without a translation stay in Japanese.

In Project Hub 4.126.111, open Settings → Language and select [Download and add] next to English. Then select English as the display language, save, and restart Hub.

Files: `ui.json` (screens), `backend.json` (messages from the app and to the AIs), `native.json` (Mac app window). Keys are the Japanese source text; values are the English text. Keep `${0}` placeholders, HTML tags, line breaks and Markdown marks as they are.

This is an AI-assisted language pack, originally prepared for Project Hub source version 4.126.41. `verifiedWith` records the source version used for automated compatibility checks; it does not mean every screen has been reviewed. Corrections are welcome as Pull Requests — see CONTRIBUTING.md, section "言語パック". The glossary is in `docs/GLOSSARY.md`.

Check before sending: `HUB_I18N_STRICT=1 node hub/test/run.cjs ../langpacks/en/test/en-pack.test.js`

The voice notices and button labels use this pack. Speech recognition stays Japanese (`ja-JP`); the display language does not change what language you can dictate. Automated checks used simulated recognition in isolated Chrome, not a real microphone or a Windows/iPhone app.

The pack has 53 native dictionary entries. The source Mac launcher (`hub/app/window.swift`) reads these entries where it uses its translation helper. The separate release-candidate window is built from `hub/staging-app/Window.swift` and still has fixed Japanese messages; its system microphone and speech-recognition purpose descriptions also remain Japanese. This pack update does not change either launcher or certify English display on a packaged Mac or Windows app.

For 4.126.41, this update adds 101 UI entries, including the three new Muse notices. Existing translations and all 53 native entries are preserved. The marked-source scan covers literal and conditional `UI.text` / `UI.message` calls, `UI.html` / `UI.template`, backend `lt`, and native `tr` calls; it is not a guarantee that every screen is translated.

In 4.126.42, the chat send button uses the existing translations for `Send` / `Send to Muse`. This pack is verified with 4.126.42; dictionaries are unchanged from the 4.126.41 update.

Known product limits: template interpolation values are not translated automatically. Some Muse status/action labels remain Japanese. Muse result toasts that call `UI.text` can use the new entries, but pending notices, saved event text and error toasts that bypass translation still show the original Japanese. The earlier send-button failure in the Traditional Chinese suite is resolved by the 4.126.42 product fix; test expectations are unchanged.

For 4.126.44, six sidebar search entries were added and the compact search form uses this pack. Existing translations are preserved; verifiedWith is 4.126.44.

For 4.126.96, 42 UI entries and 39 backend entries were added for screens and messages added or reworded since 4.126.44, including the new settings layout, video attachments and the data location picker. The strict UI scan and backend tests pass; verifiedWith is 4.126.96.

For 4.126.98, added 94 UI and 90 backend entries for tier routing, Token units/cache hit rate/tool calls, bulk review, settings and current instructions. Tier screens and review prompts now use translation helpers. Existing translations and native entries are preserved. Automated checks do not certify every screen or packaged Mac/Windows display.

For 4.126.103, added 35 UI and 35 backend translations for changes since 4.126.98, including manual update checks, wait reasons, automatic reopen, registration holds/license import and Windows setup notices. Existing translations, native entries and stored control values are unchanged; verifiedWith is 4.126.103. Published with the 4.126.103 language-pack assets.

Known 4.126.103 product limits: the automatic-reopen overlay, raw update/auto-reopen reasons, registration/import notices and Windows setup messages do not consistently call translation helpers. Their dictionary entries are ready, but these paths can still show Japanese. Pack updates alone cannot connect those paths. Automated marked-string coverage is not full-screen coverage. Wording and real Mac/Windows display still need human review.

For 4.126.104, added 2 UI and 2 backend entries for model-list refresh after CLI update checks and waits for AI work or account operations.

For 4.126.105, the same translations cover the existing interface messages. The pack was verified for import and language selection with 4.126.105.

For 4.126.106, the existing translations cover the free-talk queue editing fix.

4.126.109 adds translations for the chat input history buttons, Claude Code conversation recovery, and the restart status.

4.126.110 adds translations for the language pack download controls, status messages, and errors.

4.126.111 updates the installation guide for the simplified language settings and adds translations for the HTML sample preview.
