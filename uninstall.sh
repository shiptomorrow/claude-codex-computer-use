#!/usr/bin/env bash
# Removes the codex-cu MCP server, the installed wrapper, and the managed block in ~/.claude/CLAUDE.md.
set -euo pipefail

INSTALL_DIR="$HOME/.claude/mcp"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"

claude mcp remove codex-cu -s user >/dev/null 2>&1 && echo "Removed MCP server 'codex-cu'" || echo "MCP server 'codex-cu' was not registered"
rm -f "$INSTALL_DIR/codex-cu-wrapper.mjs" "$INSTALL_DIR/codex-cu-wrapper.state.json"
echo "Removed wrapper files from $INSTALL_DIR"

if [[ -f "$CLAUDE_MD" ]] && command -v node >/dev/null; then
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const begin = "<!-- codex-cu:begin -->", end = "<!-- codex-cu:end -->";
    const text = fs.readFileSync(file, "utf8");
    const start = text.indexOf(begin), stop = text.indexOf(end);
    if (start === -1 || stop < start) { console.log(`No managed codex-cu block in ${file}`); process.exit(0); }
    const out = (text.slice(0, start).trimEnd() + "\n\n" + text.slice(stop + end.length).trimStart()).trim();
    fs.writeFileSync(file, out ? out + "\n" : "");
    console.log(`Removed the codex-cu block from ${file}`);
  ' "$CLAUDE_MD"
fi
