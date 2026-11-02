# English pack changelog

## 4.126.92 (draft)
- Added English for 4 screen texts, 7 backend texts and 2 Mac window texts introduced in 4.126.77-4.126.92: the "Unanswered question" card, the new-device code and trusted-device buttons, the "Checking the send…" status, the notes for omitted conversation messages, the "question has changed" refusal, the updated delegation instructions that use the local authentication header, the remote sign-in page with the one-time new-device code field, and two Mac window error texts. Existing translations are preserved. In the remote sign-in page only the visible text was translated; its script is unchanged.
- Two new settings messages (the new-device code prompt and the "revoked trusted-device marks" notice) are translated but not yet shown in English or Traditional Chinese, because 4.126.92 has no translation hook for them.
- Product changes covered (4.126.77-4.126.92): on phones the input and send controls stay reachable with attached images; the send screen shows "Checking the send…" right after sending; usage checks before sending are limited to the AI that will start, and the existing-credit check overlaps the first save check, with one fresh re-check when a reused result becomes stale; the light and dark themes are easier to read; background reading for conversation tidy-up and search is lighter; when the conversation handed to an AI is too long, whole messages are kept from the start and the omitted part is noted; unanswered questions and all their choices stay visible after a summary; the work phase and progress display is off by default; an old red tidy-up notice is cleared after a later normal check; and the local owner cookie alone no longer authorizes the API (a separate launch token is required, and the cookie and screen token expire after 8 hours).
- Speed figures for these changes come from simulated tests only; real response time was not measured. Not yet verified with 4.126.92 on real Mac/Windows screens, updates or language switching. Not published.

## 4.126.76 (draft)
- Added English for 41 screen texts and 3 instruction texts: the "Show full text" button for collapsed automatic requests, the previous-page button in archived conversations, the one-decimal credit balance, the section line-range guidance in AI instructions, and 38 conversation-search screen texts that had been missing since the search screen was added. Existing translations are preserved.
- Product changes covered (4.126.68-4.126.76): automatic requests are collapsed with [Show full text]; AI history shortens resolved automatic requests while keeping the original; multi-line purpose/conditions are kept in full; task files get a section line-range guide in chat instructions; tapping a search result opens the task conversation at the matched message; the credit settings have their own save button; one request can omit the line-range guide for comparison; the credit balance is shown with one decimal place.
- Verified with 4.126.76 by automated dictionary checks. Real Mac/Windows screens, updates and language switching are not yet verified. Not published.

## 4.126.67 (draft)
- Added English for 9 screen texts and 17 instruction texts introduced up to 4.126.67: automatic answer checks for Muse, the manual review guidance, the compact AI instructions, and the "reopen after a moment" notice. Existing translations are preserved. Verified with 4.126.67.

## 4.126.44 (draft)
- Added six sidebar search labels and enabled translation of the compact sidebar search form. Existing translations are preserved. Verified with 4.126.44.


## 4.126.42 (draft)
- Verified with product 4.126.42. The chat send button now uses the existing English translations. Dictionaries and test expectations are unchanged; the documented Muse and packaged Mac limitations remain.
- Not published; actual Mac/Windows display is not yet verified.

## 4.126.41 (draft)
- Added 101 UI entries, including conditional labels, template fragments and three Muse notices. Existing UI/backend/native translations are unchanged.
- Updated `verifiedWith` and version guidance to 4.126.41. Documented unlocalized template values, Muse status/error paths and the separate packaged Mac window. Product code and test expectations are unchanged.
- This update has not been published. Automated dictionary checks do not certify every screen or real Mac/Windows operation.

## 4.126.33 (draft)
- Added 40 explicitly marked UI messages and five backend messages for Muse, task-result checks and search validation. Existing dictionary entries are unchanged.
- Aligned the draft version notes and clarified the separate source and release-candidate Mac native windows. The 53 native dictionary entries are unchanged.
- Compatibility checks cover dictionary loading, placeholders and static marked strings. Dynamic or unmarked text, real screens and packaged Mac/Windows operation remain unverified. No language pack has been published.

## 4.125.10
- Added English text for the work phase and progress strip and its setting, the reviewed idea deletion, the discussion and role-review screens, merge status lines, and history indexing prompts.
- Added dictionary entries for the voice input messages and the microphone button labels. The voice input screen now reads these entries. Speech recognition remains Japanese; only the notices and labels are translated.
- `verifiedWith` is 4.125.10 after automated catalog, UI, backend and simulated voice checks. Real microphone and Windows/iPhone voice operation were not tested.

## 4.125.2 (draft)
- First English draft covering the screens, app messages, AI instructions and Mac app texts of Project Hub 4.125.2. Made with AI; review by native speakers is welcome.
