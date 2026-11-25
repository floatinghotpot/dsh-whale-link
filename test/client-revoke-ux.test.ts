/**
 * Structural locks for the revoke UX and the host-side mutual exclusion.
 *
 * The runtime behaviour is covered by the user's local install (no fake-hub
 * integration environment here); these assertions keep the wiring from silently
 * regressing: the panel must hide actions while revoking, failures must reach it,
 * and every path that can start a tunnel must respect the start/revoke locks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

/** Slice a function body between two markers; fails loudly when a marker moves. */
function slice(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing ${start} .. ${end}`);
  return source.slice(from, to);
}

const zh = slice(client, "const zh = {", "const en = {");
const en = client.slice(client.indexOf("const en = {"));

test("client：注销相关文案在 zh/en 两份字典里都存在", () => {
  for (const key of ["status_revoking", "tip_revoking", "revokeConfirm", "revokingBusy"]) {
    assert.match(zh, new RegExp(`\\b${key}:`, "u"), `zh.${key} missing`);
    assert.match(en, new RegExp(`\\b${key}:`, "u"), `en.${key} missing`);
  }
  assert.match(client, /t\("tip_" \+ status\)/u, "the tip must be driven by the status key");
});

test("client：注销期间隐藏动作并禁用控件", () => {
  assert.match(client, /const revoking = status === "revoking"/u);
  assert.match(client, /showForm = !revoking &&/u);
  assert.match(client, /showDisconnect = !revoking &&/u);
  assert.match(client, /const disabled = busy \|\| external \|\| revoking/u);
  assert.match(client, /const actions = external \|\| revoking/u);
  assert.match(client, /\.dsh-whale-link-dot\.revoking\{/u);
});

test("client：注销/断开检查 res.ok，成功后回到扫码态", () => {
  const revoke = slice(client, "const revoke = async", "const setCode = async");
  assert.match(revoke, /window\.confirm\(t\("revokeConfirm"\)\)/u);
  assert.match(revoke, /setStatus\("revoking"\)/u);
  assert.match(revoke, /if \(!res\.ok\)/u);
  assert.match(revoke, /resetScan\(\)/u);
  assert.match(revoke, /setTokenMode\(false\)/u);
  assert.match(revoke, /setConfirmOverwrite\(false\)/u);
  assert.match(revoke, /setToken\(""\)/u);
  assert.match(revoke, /code === "timeout"[\s\S]{0,120}resetScan\(\)/u);

  const disconnect = slice(client, "const disconnect = async", "const revoke = async");
  assert.match(disconnect, /if \(!res\.ok\)/u);

  assert.match(client, /code === "revoking"[\s\S]{0,120}t\("revokingBusy"\)/u);
});

test("server：注销/接入互斥覆盖所有启动路径（机械锁）", () => {
  assert.match(server, /let revoking = false/u);
  assert.match(server, /let starting = false/u);

  const startTunnel = slice(server, "function startTunnel(", "async function syncDirect(");
  assert.match(startTunnel, /if \(disposed\) return;/u, "startTunnel gate is disposed-only");
  assert.doesNotMatch(startTunnel, /\|\| revoking/u, "startTunnel must let an in-flight connect finish");

  const connect = slice(server, "async function connect(", "async function beginScan(");
  assert.match(connect, /if \(revoking\) return err\("revoking"/u);
  assert.match(connect, /if \(starting\) return err\("busy"/u);
  assert.match(connect, /starting = true;/u);
  assert.match(connect, /finally \{\s*starting = false;/u);

  const scan = slice(server, "async function scanState(", "function writePluginMeta(");
  assert.match(scan, /if \(revoking\) return err\("revoking"/u);
  assert.match(scan, /if \(starting\) return ok\(\{ status: "pending" \}\)/u);
  assert.match(scan, /starting = true;/u);
  assert.match(scan, /const session = bindSession;/u, "scanState must capture the session identity");
  assert.match(scan, /if \(bindSession !== session\) return ok\(\{ status: "none" \}\)/u);

  const scanBegin = slice(server, "async function beginScan(", "async function scanState(");
  assert.match(scanBegin, /if \(revoking\) return err\("revoking"/u);
  assert.match(scanBegin, /detectInsecure\(hub\)[\s\S]*if \(revoking\) return err\("revoking"/u, "beginScan re-checks after the first await");

  const auto = slice(server, "async function autoConnect(", "async function disconnect(");
  assert.match(auto, /if \(revoking \|\| starting\) return;/u);
  assert.match(auto, /starting = true;/u);

  const sync = slice(server, "async function syncDirect(", "async function stopDirect(");
  assert.match(sync, /if \(revoking\) return;/u);
});

test("server：注销本地优先与状态（机械锁）", () => {
  assert.match(server, /export type Status = .*"revoking"/u);

  const revoke = slice(server, "async function revoke(", "async function state(");
  assert.match(revoke, /revoking = true;[\s\S]*?for \(let waited = 0; starting/u, "revoking must be set before the wait loop");
  assert.match(revoke, /for \(let waited = 0; starting && waited < 5_000/u);
  assert.match(revoke, /bindSession = null;/u);
  assert.match(revoke, /teardownStarted = true;/u);
  assert.match(revoke, /if \(teardownStarted\) \{[\s\S]*handle = null;[\s\S]*liveState = null;/u);
  assert.match(revoke, /handle\.stop\(\{ flushTimeoutMs: TEARDOWN_FLUSH_BUDGET_MS \}\)/u);
  assert.match(revoke, /lastMessage = outcome\.teardownError/u);
  assert.match(revoke, /revoking = false;/u);

  const state = slice(server, "async function state(", "function uiCompatEnabled(");
  assert.match(state, /status: "revoking"/u);
  assert.match(state, /status: "external",[\s\S]*message: lastMessage,/u);
});

test("server：注销期间禁止改配置（set-access-code / set-ui-compat）", () => {
  const accessCode = slice(server, "async function setAccessCode(", "async function setUiCompat(");
  assert.match(accessCode, /if \(revoking\) return err\("revoking"/u);
  const uiCompat = server.slice(server.indexOf("async function setUiCompat("));
  assert.match(uiCompat, /if \(revoking\) return err\("revoking"/u);
});
