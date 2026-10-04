# codex-cu for Claude Code

Use **Codex Computer Use** from **Claude Code** on macOS. Claude can then drive your real desktop apps and your existing Chrome tabs, in the background, through the same computer-use engine that ships with the ChatGPT desktop app.

## What it is

The ChatGPT desktop app includes Codex's computer-use MCP server (`cua_repl`). Claude Code can launch it directly, and native apps work that way. Chrome doesn't: the browser backend requires per-call Codex session metadata that only Codex sends. Without it, every browser call fails with `Missing required Codex turn metadata`.

`codex-cu-wrapper.mjs` sits between Claude Code and `cua_repl`:

```
Claude Code ──stdio──▶ codex-cu-wrapper.mjs ──stdio──▶ cua_repl (from ChatGPT.app) ──▶ apps / Chrome extension
```

It:

- **Follows Codex updates.** On every start it reads the newest `~/.codex/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json` and launches `cua_repl` exactly as that file describes. Nothing about the ChatGPT install is copied into your Claude Code config.
- **Adds the Codex turn metadata** (`session_id`, `turn_id`) to every tool call. One Claude Code session is one Codex session. A turn ends once the server has been idle for 3 minutes, like a Codex turn ending at its Stop hook.
- **Releases Chrome tabs.** It sends `turn_ended` when a turn goes idle and on shutdown. If a wrapper is killed before it can do that, the next start ends the orphaned turn so the tab stops being held.
- **Recovers tabs after a kernel reset.** When a `js` call times out ("kernel reset") or `js_reset` is called, the turn ends as soon as no other call is running. A reset in the middle of attaching to a tab can leave that tab failing with `Debugger unattached` until its turn ends; ending it at once releases the tab, and the next call starts a new turn.
- **Shows permission prompts as native macOS dialogs** (Allow / Always Allow / Deny). `cua_repl` asks before using each app or site, and headless Claude Code hosts would otherwise decline those requests without showing them.
- **Exposes the same tools as Codex** (`js`, `js_reset`), using the plugin's own `enabled_tools` list.

Nothing from OpenAI is redistributed here. The wrapper runs the copy already installed by your ChatGPT app.

## Requirements

- **macOS**
- **ChatGPT desktop app** with Codex Computer Use set up. Open Codex, enable Computer Use, and grant the macOS permissions it asks for (Accessibility, Screen Recording). The installer checks for the plugin under `~/.codex/plugins/cache/openai-bundled/unified-computer-use/`.
- **Codex Chrome extension**, only if you want Chrome control. It's the one Codex uses for `@Chrome`.
- **Node.js 18+** on your `PATH`
- **Claude Code** CLI (`claude`)

## Install

```sh
git clone https://github.com/shiptomorrow/claude-codex-computer-use.git
cd claude-codex-computer-use
./install.sh
```

Then restart Claude Code. The installer:

1. checks the requirements above
2. copies the wrapper to `~/.claude/mcp/codex-cu-wrapper.mjs`
3. registers it as the user-scoped MCP server `codex-cu`
4. adds a short rule to `~/.claude/CLAUDE.md` (inside `<!-- codex-cu:begin/end -->` markers) telling Claude to prefer `codex-cu` over other computer-use tools. Skip this step with `./install.sh --no-claude-md`.
5. confirms the server connects

Re-running it is safe. To update after a `git pull`, run `./install.sh` again.

## Use

Ask Claude for anything that needs your Mac's UI:

- "Open System Settings and tell me which Wi-Fi network I'm on"
- "In the Chrome tab I have open, scroll down and summarize the page"
- "Open Notes and read me the last note"

The first time Claude touches an app or website, a dialog asks for permission:

| Button | Effect |
| --- | --- |
| **Allow** | this time only |
| **Always Allow** | saved by Codex Computer Use |
| **Deny** | declined for the rest of the Claude Code session |

The dialog stays open until you answer and comes back to the front every 10 seconds.

## Configuration

Set these before running `./install.sh` and they are saved into the MCP server config:

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEX_CU_IDLE_TURN_MS` | `180000` (3 min) | Idle time after which the turn ends and claimed Chrome tabs are released |
| `CODEX_CU_NATIVE_PROMPTS` | on | `0` forwards permission prompts to the MCP client instead of showing a macOS dialog |
| `CODEX_HOME` | `~/.codex` | Where to look for the Codex plugin cache |

```sh
CODEX_CU_IDLE_TURN_MS=60000 ./install.sh
```

## Troubleshooting

| Symptom | Meaning / fix |
| --- | --- |
| `claude mcp get codex-cu` is not connected | Run it and read the error. Usually the ChatGPT app moved or Computer Use isn't set up yet; re-run `./install.sh` for a requirements check. |
| `Missing required Codex turn metadata` | Claude Code is launching `cua_repl` directly instead of the wrapper. Re-run `./install.sh`. |
| `Tab … is already part of browser session …` | Another live Claude Code session (or Codex) holds that tab. It's released when that session idles for 3 minutes or exits. |
| `Debugger unattached` on a tab after a timed-out call | The browser service stopped mid-attach. The wrapper ends the turn after the reset, which releases the tab; get it again (`tabs.get` or `user.claimTab`). Keep slow multi-page steps in separate `js` calls so none reaches the 30-second limit. |
| Chrome calls fail but apps work | Install the Codex Chrome extension and make sure Chrome is running. |
| A permission was denied by mistake | Denials last for the session. Restart Claude Code (or run `/mcp` and reconnect `codex-cu`). |

The wrapper logs to stderr with a `[codex-cu-wrapper]` prefix. Run `claude --debug` to see them in Claude Code's MCP logs.

## Uninstall

```sh
./uninstall.sh
```

This removes the MCP server, the installed wrapper and its state file, and the managed block in `~/.claude/CLAUDE.md`.

## Caveats

- **Undocumented internals.** This relies on undocumented behavior in OpenAI's bundled computer-use plugin: the `x-codex-turn-metadata` field, `turn_ended`, and the plugin cache layout. A ChatGPT update can break it. When that happens you get a clear error rather than silent misbehavior.
- **Unofficial.** Not affiliated with or endorsed by OpenAI or Anthropic.
- **macOS only.**

## License

[MIT](LICENSE)
