#!/usr/bin/env bash
# Installs the codex-cu wrapper and registers it as a user-scoped Claude Code MCP server.
#
#   ./install.sh                 install, register, and add the computer-use rule to ~/.claude/CLAUDE.md
#   ./install.sh --no-claude-md  skip the CLAUDE.md rule
#
# Optional env vars, baked into the MCP server config when set:
#   CODEX_CU_IDLE_TURN_MS, CODEX_CU_NATIVE_PROMPTS, CODEX_HOME
set -euo pipefail

SERVER_NAME="codex-cu"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.claude/mcp"
WRAPPER="$INSTALL_DIR/codex-cu-wrapper.mjs"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
PLUGIN_ROOT="$CODEX_HOME_DIR/plugins/cache/openai-bundled/unified-computer-use"

add_claude_md=1
for arg in "$@"; do
  case "$arg" in
    --no-claude-md) add_claude_md=0 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✘\033[0m %s\n' "$1" >&2; exit 1; }

echo "Checking requirements"

[[ "$(uname -s)" == "Darwin" ]] || fail "macOS only (Codex Computer Use ships with the macOS ChatGPT app)."
ok "macOS $(sw_vers -productVersion)"

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || fail "Node.js 18+ not found on PATH. Install it (e.g. brew install node) and re-run."
node_major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
(( node_major >= 18 )) || fail "Node.js 18+ required, found $("$NODE" --version) at $NODE."
ok "Node $("$NODE" --version) at $NODE"
case "$NODE" in
  *"/.nvm/"*|*"/.fnm/"*|*"/.volta/"*|*"/.asdf/"*)
    echo "    note: this Node path belongs to a version manager; re-run install.sh if you remove that version." ;;
esac

command -v claude >/dev/null || fail "Claude Code CLI ('claude') not found on PATH."
ok "Claude Code $(claude --version 2>/dev/null | head -1)"

plugin_json="$("$NODE" -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1];
  let dirs = [];
  try { dirs = fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); } catch {}
  for (const d of dirs) {
    const f = path.join(root, d, ".mcp.json");
    try { if (JSON.parse(fs.readFileSync(f, "utf8")).mcpServers?.cua_repl?.command) { console.log(f); break; } } catch {}
  }' "$PLUGIN_ROOT")"
[[ -n "$plugin_json" ]] || fail "Codex Computer Use plugin not found under $PLUGIN_ROOT.
    Install the ChatGPT desktop app, open Codex, and turn on Computer Use once, then re-run."
ok "Codex Computer Use plugin: $plugin_json"

echo "Installing"

mkdir -p "$INSTALL_DIR"
cp "$REPO_DIR/codex-cu-wrapper.mjs" "$WRAPPER"
chmod +x "$WRAPPER"
ok "Wrapper copied to $WRAPPER"

server_json="$("$NODE" -e '
  const [node, wrapper] = process.argv.slice(1);
  const env = {};
  for (const k of ["CODEX_CU_IDLE_TURN_MS", "CODEX_CU_NATIVE_PROMPTS", "CODEX_HOME"]) if (process.env[k]) env[k] = process.env[k];
  console.log(JSON.stringify({ type: "stdio", command: node, args: [wrapper], ...(Object.keys(env).length ? { env } : {}) }));
' "$NODE" "$WRAPPER")"
claude mcp remove "$SERVER_NAME" -s user >/dev/null 2>&1 || true
claude mcp add-json --scope user "$SERVER_NAME" "$server_json" >/dev/null
ok "Registered user MCP server '$SERVER_NAME'"

if (( add_claude_md )); then
  result="$("$NODE" -e '
    const fs = require("fs"), path = require("path");
    const [file, snippetFile] = process.argv.slice(1);
    const begin = "<!-- codex-cu:begin -->", end = "<!-- codex-cu:end -->";
    const block = `${begin}\n${fs.readFileSync(snippetFile, "utf8").trim()}\n${end}`;
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch {}
    const start = text.indexOf(begin), stop = text.indexOf(end);
    if (start !== -1 && stop > start) {
      text = text.slice(0, start) + block + text.slice(stop + end.length);
      console.log("updated");
    } else if (text.includes("mcp__codex-cu__js")) {
      console.log("skipped"); process.exit(0);
    } else {
      text = (text.trim() ? text.trimEnd() + "\n\n" : "") + block + "\n";
      console.log("added");
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  ' "$CLAUDE_MD" "$REPO_DIR/claude-md-snippet.md")"
  case "$result" in
    added)   ok "Added the computer-use rule to $CLAUDE_MD" ;;
    updated) ok "Updated the computer-use rule in $CLAUDE_MD" ;;
    skipped) ok "$CLAUDE_MD already mentions codex-cu outside the managed block; left it unchanged" ;;
  esac
fi

echo "Verifying"
if claude mcp get "$SERVER_NAME" 2>/dev/null | grep -q "Connected"; then
  ok "'$SERVER_NAME' is connected"
else
  claude mcp get "$SERVER_NAME" || true
  fail "'$SERVER_NAME' did not connect; see the output above."
fi

echo
echo "Done. Restart Claude Code to load the codex-cu tools."
