## Computer use

Use the `codex-cu` MCP server (`mcp__codex-cu__js`) for all desktop-app and browser control, Chrome included: it drives the user's real apps and their existing Chrome tabs through Codex Computer Use. Use Claude in Chrome or other computer-use tools only when the user names them.

- A Chrome tab bound by this session stays claimed until `codex-cu` has been idle for 3 minutes (`CODEX_CU_IDLE_TURN_MS`) or the session ends; the next call starts a new turn, so rebind tabs with `cua.getTab` after a pause. "Tab … is already part of browser session …" means another live session holds it.
- Browser permission prompts are MCP elicitations. Headless hosts decline them unseen, so the wrapper shows them as a native macOS dialog (Deny / Allow / Always Allow; set `CODEX_CU_NATIVE_PROMPTS=0` to forward them instead). Deny is saved for the rest of the session and does not appear on the Chrome settings page; the dialog stays open until answered and returns to the front every 10 seconds.
- `codex-cu` runs `~/.claude/mcp/codex-cu-wrapper.mjs`, which launches Codex's `cua_repl` from the newest plugin version and adds the Codex turn metadata. Debug there if the server won't start or reports "Missing required Codex turn metadata".
