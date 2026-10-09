# Validation scope

This branch is based on v4.68.2. Upstream main has advanced to v4.90.0; integration and macOS regression testing remain pending.

Focused Windows tests cover process arguments and termination, PTY, image conversion, CRLF steps, HTTP protections, translation stability, workspace relocation, and Skill scanning and prompt integration.

The complete upstream suite is not certified on Windows. Existing Unix executable/shebang and POSIX signal assumptions affect the ai-tools suite. Live Tailscale, macOS native app, real project Git merge/revert, and end-to-end AI adherence to selected Skills have not been validated.

## Latest focused run (2026-10-09, Windows / Node.js 24)

110 tests passed, 0 failed:

```powershell
node --test --test-force-exit --test-concurrency=2 --test-timeout=20000 hub/test/windows-security.test.js hub/test/zh-TW.test.js hub/test/workspace-location.test.js hub/test/skills.test.js hub/test/rich-text.test.js hub/test/chat-scroll.test.js hub/test/completion.test.js hub/test/guidance.test.js hub/test/instruction-size.test.js hub/test/limit-evidence.test.js hub/test/model-order.test.js hub/test/procwatch.test.js hub/test/project-order.test.js hub/test/transcript.test.js hub/test/usage.test.js hub/test/remote.test.js
```
