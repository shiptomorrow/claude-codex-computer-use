#!/usr/bin/env node
// Stdio MCP wrapper that lets Claude Code use Codex's bundled computer-use server (cua_repl).
//
// - Launches cua_repl exactly as the newest unified-computer-use plugin's .mcp.json describes,
//   so Codex/ChatGPT updates are picked up on the next start.
// - Adds the `x-codex-turn-metadata` (session_id + turn_id) that the browser backend requires
//   to every tools/call. One wrapper process = one session; a turn lasts until the server has
//   been idle for IDLE_TURN_MS, like a Codex turn ending at its Stop hook.
// - Sends `turn_ended` when a turn goes idle and on shutdown so claimed Chrome tabs are released.
// - Records live sessions in a state file; if a previous wrapper died without ending its turn,
//   the next start ends it before launching the server.
// - Filters tools/list to the plugin's `enabled_tools`, minus tools marked hidden.
// - Shows confirmation elicitations (browser permission prompts) as a native macOS dialog, because
//   headless Claude Code hosts decline them unseen and the decline is then saved for the session.
//   Set CODEX_CU_NATIVE_PROMPTS=0 to forward them to the MCP client instead.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const PLUGIN_ROOT = path.join(CODEX_HOME, "plugins/cache/openai-bundled/unified-computer-use");
const SERVER_NAME = "cua_repl";
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-cu-wrapper.state.json");
const META_KEY = "x-codex-turn-metadata";
const NATIVE_PROMPTS = process.platform === "darwin" && process.env.CODEX_CU_NATIVE_PROMPTS !== "0";
const PROMPT_RAISE_SECONDS = 10;
const IDLE_TURN_MS = Number(process.env.CODEX_CU_IDLE_TURN_MS) || 3 * 60 * 1000;

const log = (...args) => console.error("[codex-cu-wrapper]", ...args);

function findServerConfig() {
  const versions = fs
    .readdirSync(PLUGIN_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    try {
      const file = path.join(PLUGIN_ROOT, version, ".mcp.json");
      const cfg = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers?.[SERVER_NAME];
      if (cfg?.command) return { version, file, cfg };
    } catch {}
  }
  throw new Error(`No ${SERVER_NAME} entry found in ${PLUGIN_ROOT}/*/.mcp.json`);
}

function spawnServer(cfg) {
  return spawn(cfg.command, cfg.args ?? [], {
    env: { ...process.env, ...(cfg.env ?? {}) },
    stdio: ["pipe", "pipe", "inherit"],
  });
}

const turnMeta = (session_id, turn_id) => JSON.stringify({ session_id, turn_id });

// ---------- state file ----------

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).entries ?? [];
  } catch {
    return [];
  }
}

function writeState(entries) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ entries }, null, 2));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// ---------- minimal JSON-RPC client over a child's stdio ----------

function rpcClient(child, onOther) {
  let nextId = 0;
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return onOther?.(line, null);
    }
    if (msg && !("method" in msg) && pending.has(msg.id)) {
      const { resolve, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      resolve(msg);
    } else {
      onOther?.(line, msg);
    }
  });
  const send = (obj) => child.stdin.writable && child.stdin.write(JSON.stringify(obj) + "\n");
  return {
    send,
    request(method, params, timeoutMs = 30000) {
      const id = `codex-cu-wrapper-${nextId++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
  };
}

async function initialize(rpc) {
  await rpc.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-cu-wrapper", version: "1" },
  });
  rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

const endTurn = (rpc, session_id, turn_id, timeoutMs) =>
  rpc.request(
    "tools/call",
    { name: "turn_ended", arguments: { hook_event_name: "Stop", session_id, turn_id } },
    timeoutMs,
  );

// End turns left behind by wrappers that died without shutting down. turn_ended only reaches
// the extension once this process has talked to the browser under that session, hence tabs.list().
async function cleanupStaleSessions(cfg, stale) {
  const child = spawnServer(cfg);
  const rpc = rpcClient(child);
  try {
    await initialize(rpc);
    for (const { session_id, turn_id } of stale) {
      try {
        await rpc.request("tools/call", {
          name: "js",
          arguments: { code: 'await (await cua.getBrowser({ id: "chrome" })).tabs.list();' },
          _meta: { [META_KEY]: turnMeta(session_id, turn_id) },
        });
        await endTurn(rpc, session_id, turn_id, 10000);
        log(`ended stale session ${session_id}`);
      } catch (e) {
        log(`could not end stale session ${session_id}: ${e.message}`);
      }
    }
  } catch (e) {
    log(`stale-session cleanup failed: ${e.message}`);
  } finally {
    child.kill();
  }
}

// ---------- native permission prompts ----------

// JXA NSAlert: stays open until answered and is raised to the front every PROMPT_RAISE_SECONDS.
const DIALOG_SCRIPT = `ObjC.import("AppKit");
function run([text, title, allowAlways, raiseSeconds]) {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  const alert = $.NSAlert.alloc.init;
  alert.messageText = title;
  alert.informativeText = text;
  alert.alertStyle = $.NSAlertStyleWarning;
  const buttons = allowAlways === "1" ? ["Allow", "Always Allow", "Deny"] : ["Allow", "Deny"];
  buttons.forEach((button) => alert.addButtonWithTitle(button));
  // Lay out and center before the first raise; ordering front first shows it at the screen origin.
  // NSWindow.center sits above the middle, so center on the visible frame exactly.
  alert.layout;
  const screen = ($.NSScreen.mainScreen.isNil() ? alert.window.screen : $.NSScreen.mainScreen).visibleFrame;
  const size = alert.window.frame.size;
  alert.window.setFrameOrigin($.NSMakePoint(
    screen.origin.x + (screen.size.width - size.width) / 2,
    screen.origin.y + (screen.size.height - size.height) / 2,
  ));
  const raise = () => {
    app.activateIgnoringOtherApps(true);
    alert.window.orderFrontRegardless;
  };
  const timer = $.NSTimer.timerWithTimeIntervalRepeatsBlock(Number(raiseSeconds), true, raise);
  $.NSRunLoop.currentRunLoop.addTimerForMode(timer, $.NSModalPanelRunLoopMode);
  raise();
  const response = Number(alert.runModal);
  timer.invalidate;
  return buttons[response - 1000] ?? "dismissed";
}`;

const openDialogs = new Map();

function isConfirmation(params) {
  if (params?.mode === "url") return false;
  const properties = params?.requestedSchema?.properties;
  return !properties || Object.keys(properties).length === 0;
}

function showDialog(requestId, text, title, allowAlways) {
  return new Promise((resolve) => {
    const dialog = spawn(
      "osascript",
      ["-l", "JavaScript", "-e", DIALOG_SCRIPT, text, title, allowAlways ? "1" : "0", String(PROMPT_RAISE_SECONDS)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    openDialogs.set(requestId, dialog);
    let out = "";
    let err = "";
    dialog.stdout.on("data", (d) => (out += d));
    dialog.stderr.on("data", (d) => (err += d));
    dialog.on("error", (e) => resolve({ error: e.message }));
    dialog.on("close", (code, signal) => {
      openDialogs.delete(requestId);
      resolve(code === 0 ? { choice: out.trim() } : { error: err.trim() || `exit ${code ?? signal}` });
    });
  });
}

function closeDialog(requestId) {
  openDialogs.get(requestId)?.kill();
  openDialogs.delete(requestId);
}

// A dismissed or failed prompt is answered with `cancel`, which the browser service does not persist.
const cancelledPrompts = new Set();

async function answerElicitation(msg) {
  const params = msg.params ?? {};
  const meta = params._meta ?? params.meta ?? {};
  const persist = [meta.persist].flat();
  const title = meta.connector_name ? `${meta.connector_name} permission` : "Codex Computer Use";
  const lines = [params.message || "Allow this action?"];
  if (meta.tool_title) lines.push("", meta.tool_title);
  const { choice, error } = await showDialog(msg.id, lines.join("\n"), title, persist.includes("always"));
  if (cancelledPrompts.delete(msg.id)) return;
  if (error) log(`permission dialog failed: ${error}`);
  let result = { action: "cancel" };
  if (choice === "Deny") result = { action: "decline" };
  else if (choice === "Allow") result = { action: "accept", content: {} };
  else if (choice === "Always Allow") result = { action: "accept", content: {}, _meta: { persist: "always" } };
  log(`permission prompt "${params.message}": ${choice ?? "failed"} -> ${result.action}`);
  child?.stdin.writable && child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
}

// ---------- main ----------

const { version, file, cfg } = findServerConfig();
log(`using ${SERVER_NAME} from ${file}`);

const SESSION_ID = randomUUID();
let turnId = randomUUID();
let turnUsed = false;
let idleTimer = null;
const pendingCalls = new Set();

const enabledTools = Array.isArray(cfg.enabled_tools) ? new Set(cfg.enabled_tools) : null;
const toolsListIds = new Set();
const clientQueue = [];
let child = null;
let rpc = null;
let initialized = false;
let shuttingDown = false;

const clientIn = readline.createInterface({ input: process.stdin });
clientIn.on("line", (line) => (child ? forwardToServer(line) : clientQueue.push(line)));
clientIn.on("close", () => shutdown(0));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(0));

function forwardToServer(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return child.stdin.write(line + "\n");
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) {
    if (m?.method === "tools/call") {
      m.params = { ...m.params, _meta: { ...m.params?._meta, [META_KEY]: turnMeta(SESSION_ID, turnId) } };
      turnUsed = true;
      pendingCalls.add(m.id);
      clearTimeout(idleTimer);
    } else if (m?.method === "initialize" && NATIVE_PROMPTS) {
      // cua_repl only requests approvals from clients that advertise form elicitation.
      m.params = { ...m.params, capabilities: { elicitation: {}, ...m.params?.capabilities } };
    } else if (m?.method === "tools/list") {
      toolsListIds.add(m.id);
    } else if (m?.method === "notifications/initialized") {
      initialized = true;
    }
  }
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function forwardToClient(line, msg) {
  if (NATIVE_PROMPTS && msg?.method === "elicitation/create" && "id" in msg && isConfirmation(msg.params)) {
    answerElicitation(msg);
    return;
  }
  if (msg?.method === "notifications/cancelled" && openDialogs.has(msg.params?.requestId)) {
    cancelledPrompts.add(msg.params.requestId);
    closeDialog(msg.params.requestId);
  }
  if (msg && !("method" in msg) && pendingCalls.delete(msg.id) && pendingCalls.size === 0) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(endIdleTurn, IDLE_TURN_MS);
    idleTimer.unref();
  }
  if (msg && !("method" in msg) && toolsListIds.delete(msg.id) && Array.isArray(msg.result?.tools)) {
    msg.result.tools = msg.result.tools.filter((t) => {
      const hidden = Array.isArray(t._meta?.ui?.visibility) && t._meta.ui.visibility.length === 0;
      return !hidden && (!enabledTools || enabledTools.has(t.name));
    });
    line = JSON.stringify(msg);
  }
  process.stdout.write(line + "\n");
}

function recordTurn() {
  writeState(readState().map((e) => (e.pid === process.pid ? { ...e, turn_id: turnId } : e)));
}

// End the idle turn so the extension releases its tabs; the next call starts a new turn.
async function endIdleTurn() {
  if (shuttingDown || pendingCalls.size || !turnUsed) return;
  const endedTurn = turnId;
  turnId = randomUUID();
  turnUsed = false;
  recordTurn();
  try {
    await endTurn(rpc, SESSION_ID, endedTurn, 5000);
  } catch (e) {
    log(`turn_ended failed: ${e.message}`);
  }
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const requestId of [...openDialogs.keys()]) closeDialog(requestId);
  if (child && child.exitCode === null) {
    clearTimeout(idleTimer);
    if (initialized && turnUsed) {
      try {
        await endTurn(rpc, SESSION_ID, turnId, 5000);
      } catch (e) {
        log(`turn_ended failed: ${e.message}`);
      }
    }
    child.stdin.end();
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    if (child.exitCode === null) child.kill();
  }
  writeState(readState().filter((e) => e.pid !== process.pid));
  process.exit(code);
}

const entries = readState();
const stale = entries.filter((e) => !isAlive(e.pid));
writeState([
  ...entries.filter((e) => isAlive(e.pid)),
  { pid: process.pid, session_id: SESSION_ID, turn_id: turnId, version, started: new Date().toISOString() },
]);
if (stale.length) await cleanupStaleSessions(cfg, stale);

if (!shuttingDown) {
  child = spawnServer(cfg);
  rpc = rpcClient(child, forwardToClient);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    log(`${SERVER_NAME} exited (code ${code}, signal ${signal})`);
    // Leave our state entry so the next start ends this turn.
    process.exit(code ?? 1);
  });
  for (const line of clientQueue.splice(0)) forwardToServer(line);
}
