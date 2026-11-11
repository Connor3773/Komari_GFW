import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { chromium } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import { collectRetiredHistory, RETIRED_PROTECTION_MS } from "../src/retention.ts";

// This harness creates a fresh loopback-only host and synthetic Agent identities.
// No production URL or credential is accepted, and every TCP target is loopback.
const root = resolve(".local");
await mkdir(root, { recursive: true });
const work = await mkdtemp(join(root, "host-test-"));
const binary = resolve(process.env.KOMARI_TEST_BINARY || ".local/komari.exe");
const password = `Aa1-${randomBytes(24).toString("hex")}`;
let child, browser, log = "", base, cookie = "";
const listeners = [];
let hook;
const notifications = [];
// Legacy titles are accepted only for the pre-upgrade portion of this harness.
const pluginTitles = new Set(["GFW 测试通知", "GFW 疑似被墙", "GFW 解除被墙状态", "被墙检测测试通知", "服务器疑似被墙", "服务器被墙方向变化", "服务器解除被墙状态"]);
const pluginMessages = () => notifications.filter(body => { try { return pluginTitles.has(JSON.parse(body).title); } catch { return false; } });
function verifyNotificationCopy() {
  const [blocked, recovered] = pluginMessages().slice(-2).map(body => JSON.parse(body));
  assert.equal(blocked.title, "服务器疑似被墙");
  assert.equal(recovered.title, "服务器解除被墙状态");
  for (const [message, count] of [[blocked, 0], [recovered, 3]]) {
    assert.ok(message.message.includes(`反向（受检服务器到大陆目标）：${count}/3 可达`));
    assert.ok(message.message.includes("非大陆对照（受检服务器到非大陆目标）：2/2 可达"));
    assert.ok(message.message.includes(`正向（大陆探针到受检服务器）：${count ? 2 : 0}/2 可达（正向检测）`));
    assert.ok(message.message.includes("203.0.*.*"));
    assert.ok(!message.message.includes("203.0.113.25"));
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tcpServer(port = 0) {
  const server = net.createServer(socket => socket.end());
  server.listen(port, "127.0.0.1"); await once(server, "listening");
  listeners.push(server); return server;
}
async function freePort() { const s = await tcpServer(); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
async function waitFor(fn, message, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (e) { last = e; } await sleep(300); }
  throw new Error(`${message}${last ? ": " + last.message : ""}`);
}
async function json(path, body, authenticated = true) {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { ...(authenticated ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json", "X-Komari-GFW": "1" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || data.status === "error" || data.error) throw new Error(`${path}: ${JSON.stringify(data.error || data.message || data)}`);
  return data;
}
async function rpc(method, params) {
  return (await json("/api/rpc2", { jsonrpc: "2.0", method, params: params ?? {}, id: 1 })).result;
}
async function rawTasks() {
  // Test-only privileged oracle on the disposable SQLite host. Ordinary admin
  // lists are filtered too; do not add a raw-data route to the shipped plugin.
  const result = await rpc("admin:dbQuery", { database: "main", sql: "SELECT id, weight, name, clients, all_clients AS default_on, type, target, interval FROM ping_tasks ORDER BY weight, id", limit: 1000 });
  assert.equal(result.truncated, false);
  return result.rows.map(values => {
    const task = Object.fromEntries(result.columns.map((key, i) => [key, values[i]]));
    task.clients = JSON.parse(task.clients || "[]");
    task.default_on = Boolean(task.default_on);
    return task;
  });
}
async function plugin(path, body) { return json("/api/admin/plugins/komari-gfw/" + path, body); }
async function install(zip) {
  const upload = await json("/api/admin/upload/init", { purpose: "plugin", filename: "komari-gfw.zip", size: zip.length });
  const form = new FormData(); form.set("upload_id", upload.data.upload_id); form.set("chunk_index", "0"); form.set("chunk_data", new Blob([zip]), "chunk.zip");
  const chunk = await fetch(base + "/api/admin/upload/chunk", { method: "POST", headers: { Cookie: cookie }, body: form }); assert.equal(chunk.status, 200);
  try { await json("/api/admin/upload/merge", { upload_id: upload.data.upload_id }); }
  catch (error) {
    // Reinstall succeeds but native auto-reload correctly fails when permissions grow.
    // Check the installed artifact before explicitly approving it on this test host.
    if (!/plugin reinstalled but reload failed:.*plugin permissions require approval/.test(error.message)) throw error;
    const expected = JSON.parse(strFromU8(unzipSync(zip)["komari-plugin.json"]));
    const installed = (await rpc("admin:listPlugins")).find(p => p.short === expected.short);
    assert.equal(installed?.version, expected.version);
    console.log("PASS: permission change requires reapproval after reinstall");
  }
  await rpc("admin:setPluginEnabled", { short: "komari-gfw", enabled: true, approved: true });
}
async function ping(port) {
  return new Promise(resolveResult => {
    const start = Date.now();
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = value => { socket.destroy(); resolveResult(value); };
    socket.setTimeout(500);
    socket.once("connect", () => done(Date.now() - start));
    socket.once("error", () => done(-1)); socket.once("timeout", () => done(-1));
  });
}
try {
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(binary, ["server", "--listen", `127.0.0.1:${port}`], { cwd: work, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => { log = (log + data.toString()).slice(-100000); });
  child.stderr.on("data", data => { log = (log + data.toString()).slice(-100000); });
  child.on("error", error => { log += error.message; });
  await waitFor(async () => (await fetch(base + "/api/install/status")).ok, "Host startup");
  await json("/api/install/complete", { username: "test-admin", password, sitename: "Block Detection Local Test", metric_dsn: "./data/metrics.db" }, false);
  await sleep(1500);
  const login = await json("/api/login", { username: "test-admin", password }, false);
  cookie = "session_token=" + login.data["set-cookie"].session_token;
  const hostVersion = await rpc("public:getVersion");
  console.log("PASS: isolated Komari bootstrap and authentication", JSON.stringify(hostVersion));
  const manifest = JSON.parse(await readFile("komari-plugin.json", "utf8"));
  const zip = await readFile(`dist/komari-gfw-${manifest.version}.zip`);
  await install(process.env.KOMARI_TEST_UPGRADE_FROM ? await readFile(process.env.KOMARI_TEST_UPGRADE_FROM) : zip);
  let settings = await plugin("settings");
  assert.equal(settings.config.enabled, false);
  console.log("PASS: plugin ZIP installed and loaded in MoeJS");
  const unauth = await fetch(base + "/api/admin/plugins/komari-gfw/overview"); assert.ok([401, 403].includes(unauth.status));
  const csrf = await fetch(base + "/api/admin/plugins/komari-gfw/settings", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" }); assert.equal(csrf.status, 403);
  console.log("PASS: authentication and write-request guard");
  const agents = [];
  for (const name of ["Test overseas", "Test mainland A", "Test mainland B"]) {
    const agent = await rpc("admin:addClient", { name });
    await rpc("admin:editClient", { uuid: agent.uuid, ipv4: "203.0.113.25", group: "Synthetic fixtures" });
    agents.push(agent);
  }
  const monitored = agents[0];
  hook = http.createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => { notifications.push(body); res.writeHead(200); res.end("ok"); });
  });
  hook.listen(0, "127.0.0.1"); await once(hook, "listening");
  await rpc("admin:setNotificationChannelConfiguration", { id: "webhook", data: { url: `http://127.0.0.1:${hook.address().port}`, method: "POST", content_type: "application/json", body: '{"message":"{{message}}","title":"{{title}}"}' } });
  await rpc("admin:editSettings", { eula_accepted: true, notification_enabled: true, notification_method: "webhook", notification_template: "{{message}}" });
  // First-run tours force the mobile sidebar open; this disposable host tests plugin UI instead.
  await json("/api/admin/theme/settings?theme=default", { _komari_onboarding_v1: { seen: ["install", "workbench", "notifications", "markets", "terminal"], workbenchOpened: true } });
  await plugin("test-notification", {});
  assert.equal(pluginMessages().length, 1);
  if (!process.env.KOMARI_TEST_UPGRADE_FROM) assert.equal(JSON.parse(pluginMessages()[0]).title, "被墙检测测试通知");
  const ports = [];
  for (let i = 0; i < 6; i++) { const listener = await tcpServer(); ports.push({ port: listener.address().port, listener }); }
  let cfg = { ...settings.config, enabled: true, strict: true, intervalSeconds: 30, failureThreshold: 1, recoveryThreshold: 1, clients: [monitored.uuid], observers: agents.slice(1).map(a => a.uuid), reverse: { [monitored.uuid]: { host: "127.0.0.1", port: ports[5].port } }, targets: settings.config.targets.map((t, i) => ({ ...t, address: `127.0.0.1:${ports[i].port}` })) };
  settings = await plugin("settings", { config: cfg, revision: settings.revision });
  assert.equal(settings.lastError, "");
  const tasks = await rawTasks(); assert.equal(tasks.length, 6);
  const reverseTask = tasks.find(t => t.name.includes(":reverse:"));
  assert.equal(reverseTask.clients.length, 2);
  async function cycle() {
    const started = Date.now();
    for (const task of (await rawTasks()).filter(t => t.name.startsWith("[Komari GFW:"))) {
      const targetPort = Number(task.target.split(":").at(-1));
      for (const uuid of task.clients) {
        const agent = agents.find(a => a.uuid === uuid);
        const value = await ping(targetPort);
        const response = await fetch(base + "/api/clients/v2/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "agent.pingResult", id: 1, token: agent.token, params: { task_id: task.id, ping_type: "tcp", value, finished_at: new Date().toISOString() } }) });
        const result = await response.json(); assert.equal(response.status, 200, "Agent HTTP authentication"); assert.ok(!result.error && result.status !== "error", "Agent result accepted");
      }
    }
    return waitFor(async () => {
      const state = await plugin("refresh", {});
      return state.rows.length && state.rows.every(row => row.lastRoundAt >= started) ? state : null;
    }, "Fresh complete TCP round", 15000);
  }
  let overview = await cycle();
  if (overview.rows[0].health !== "healthy") {
    console.log("DIAGNOSTIC:", overview.lastError);
    const result = await rpc("public:queryMetrics", { metric_keys: ["ping.latency_ms"], entity_ids: agents.map(a => a.uuid), start: new Date(Date.now() - 480000).toISOString(), end: new Date().toISOString(), fill_empty: false, max_points: 4000 });
    console.log("METRIC SHAPE:", result.series?.map(s => ({ downsampled: s.downsampled, points: s.points?.length, sample: s.points?.[0], tags: s.tags })));
  }
  assert.equal(overview.rows[0].health, "healthy"); assert.equal(overview.rows[0].alarm, false);
  for (const i of [0, 1, 2, 5]) await new Promise(r => ports[i].listener.close(r));
  overview = await cycle(); assert.equal(overview.rows[0].alarm, true);
  assert.equal(overview.events[0].type, "blocked");
  for (const i of [0, 1, 2, 5]) ports[i].listener = await tcpServer(ports[i].port);
  overview = await cycle(); assert.equal(overview.rows[0].alarm, false);
  assert.equal(overview.events[0].type, "recovered");
  assert.equal(pluginMessages().length, 3);
  assert.ok(!notifications.join("").includes("203.0.113.25"));
  assert.ok(notifications.join("").includes("203.0.*.*"));
  if (!process.env.KOMARI_TEST_UPGRADE_FROM) verifyNotificationCopy();
  console.log("PASS: loopback TCP, v2 ingestion, raw metrics, two mainland observers, block/recovery and system Webhook");
  await rpc("admin:setPluginEnabled", { short: "komari-gfw", enabled: false });
  assert.ok((await rawTasks()).every(t => !t.clients.length));
  await rpc("admin:setPluginEnabled", { short: "komari-gfw", enabled: true, approved: true });
  overview = await plugin("overview"); assert.equal(overview.events.length, 2);
  assert.equal(pluginMessages().length, 3);
  await cycle();
  console.log("PASS: unload pause, reload persistence and notification deduplication");
  if (process.env.KOMARI_TEST_UPGRADE_FROM) {
    for (const i of [0, 1, 2, 5]) await new Promise(r => ports[i].listener.close(r));
    const beforeAlarm = await cycle();
    assert.equal(beforeAlarm.rows[0].alarm, true);
    const blockedSince = beforeAlarm.rows[0].blockedSince;
    const removed = await rpc("admin:addClient", { name: "Deleted before upgrade" });
    let before = await plugin("settings");
    before = await plugin("settings", { config: { ...before.config, clients: [...before.config.clients, removed.uuid], reverse: { ...before.config.reverse, [removed.uuid]: { host: "127.0.0.1", port: ports[5].port } } }, revision: before.revision });
    const beforeTasks = await rawTasks();
    await rpc("admin:removeClient", { uuid: removed.uuid });
    await install(zip);
    const expected = structuredClone(before.config);
    expected.clients = expected.clients.filter(id => id !== removed.uuid);
    delete expected.reverse[removed.uuid];
    for (const uuid of expected.clients) expected.reverse[uuid].enabled ??= expected.strict;
    const repaired = await plugin("settings");
    assert.deepEqual(repaired.config, expected);
    assert.equal(repaired.lastError, "");
    assert.match(repaired.selectionNotice, /已删除的受检服务器/);
    const restoredAlarm = await plugin("overview");
    assert.equal(restoredAlarm.events.length, 3);
    assert.equal(restoredAlarm.rows[0].alarm, true);
    assert.equal(restoredAlarm.rows[0].alarmDirection, "both");
    assert.equal(restoredAlarm.rows[0].blockedSince, blockedSince);
    assert.equal(pluginMessages().length, 4);
    assert.deepEqual((await rawTasks()).map(t => t.id).sort(), beforeTasks.filter(t => !t.name.endsWith(`:reverse:${removed.uuid}]`)).map(t => t.id).sort());
    for (const i of [0, 1, 2, 5]) ports[i].listener = await tcpServer(ports[i].port);
    const recoveredAlarm = await cycle();
    assert.equal(recoveredAlarm.rows[0].alarm, false);
    assert.equal(recoveredAlarm.events[0].direction, "both");
    assert.equal(pluginMessages().length, 5);
    console.log("PASS: upgrade repairs deleted selection, preserves task IDs and migrates an active legacy strict alarm as both without replay");
    await plugin("settings", { config: repaired.config, revision: repaired.revision });
    for (const i of [0, 1, 2, 5]) await new Promise(r => ports[i].listener.close(r));
    overview = await cycle(); assert.equal(overview.rows[0].alarm, true);
    for (const i of [0, 1, 2, 5]) ports[i].listener = await tcpServer(ports[i].port);
    overview = await cycle(); assert.equal(overview.rows[0].alarm, false);
    assert.equal(pluginMessages().length, 7);
    verifyNotificationCopy();
    console.log("PASS: post-upgrade alerts use the new titles and corrected direction evidence");
  }
  const installed = (await rpc("admin:listPlugins")).find(p => p.short === manifest.short);
  assert.equal(installed.version, manifest.version);
  assert.deepEqual(installed.name, manifest.name);
  assert.deepEqual(installed.pages.map(p => p.file), ["pages/overview.html"]);
  const declaration = await rpc("admin:getPluginConfiguration", { short: manifest.short });
  assert.equal(declaration.configuration.data[0].type, "textbox");
  assert.ok(declaration.configuration.data[0].name.includes("pages/settings.html"));
  const userTask = await rpc("admin:addPingTask", { name: "User-owned retention fixture", target: `127.0.0.1:${ports[4].port}`, type: "tcp", interval: 60, clients: [monitored.uuid], default_on: false });
  const sqlQuery = async (sql, args = []) => (await rpc("admin:dbQuery", { database: "metrics", sql, args, limit: 1000 })).rows;
  const sqlExec = (sql, args = []) => rpc("admin:dbExec", { database: "metrics", sql, args });
  const labelsHash = createHash("sha256").update("{}").digest("hex");
  if (!(await sqlQuery("SELECT id FROM metric_label_sets WHERE labels_hash = ?", [labelsHash])).length) await sqlExec("INSERT INTO metric_label_sets (labels_hash, labels) VALUES (?, ?)", [labelsHash, "{}"]);
  const labelId = (await sqlQuery("SELECT id FROM metric_label_sets WHERE labels_hash = ?", [labelsHash]))[0][0];
  for (const width of [60000, 86400000]) if (!(await sqlQuery("SELECT id FROM metric_resolutions WHERE resolution_milli = ?", [width])).length) await sqlExec("INSERT INTO metric_resolutions (resolution_milli) VALUES (?)", [width]);
  const minuteId = (await sqlQuery("SELECT id FROM metric_resolutions WHERE resolution_milli = 60000"))[0][0];
  const dayId = (await sqlQuery("SELECT id FROM metric_resolutions WHERE resolution_milli = 86400000"))[0][0];
  const retentionNow = Date.now();
  const oldBucket = Math.floor(retentionNow / 60000) * 60000 - 86400000;
  const recentBucket = Math.floor(retentionNow / 60000) * 60000 - 60000;
  const currentDay = Math.floor(retentionNow / 86400000) * 86400000;
  const seeded = [];
  async function insertRollup(seriesId, resolutionId, bucket) {
    await sqlExec("INSERT INTO metric_rollups (series_id, resolution_id, label_id, bucket_milli, count, sum, sum_sq, min_val, max_val, first_val, first_ts_milli, last_val, last_ts_milli, digest, created_at_milli) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [seriesId, resolutionId, labelId, bucket, 1, 1, 1, 1, 1, 1, bucket, 1, bucket, null, retentionNow]);
  }
  for (const taskId of [tasks[0].id, userTask.task_id]) for (const metric of ["ping.latency_ms", "ping.loss"]) {
    const tags = JSON.stringify({ task_id: String(taskId) });
    await sqlExec("INSERT INTO metric_series (metric_name, entity_id, tags_hash, tags) VALUES (?, ?, ?, ?)", [metric, "retention-fixture", createHash("sha256").update(tags).digest("hex"), tags]);
    const id = (await sqlQuery("SELECT id FROM metric_series WHERE entity_id = ? AND metric_name = ? AND tags_hash = ?", ["retention-fixture", metric, createHash("sha256").update(tags).digest("hex")]))[0][0];
    seeded.push({ id, owned: taskId !== userTask.task_id });
    await insertRollup(id, minuteId, oldBucket);
    await insertRollup(id, minuteId, recentBucket);
    await insertRollup(id, dayId, currentDay);
  }
  const deliveredBeforePrune = pluginMessages().length;
  await rpc("admin:setPluginEnabled", { short: manifest.short, enabled: false });
  await rpc("admin:setPluginEnabled", { short: manifest.short, enabled: true, approved: true });
  assert.equal((await plugin("overview")).retentionError, "");
  for (const item of seeded) {
    const buckets = (await sqlQuery("SELECT bucket_milli FROM metric_rollups WHERE series_id = ? ORDER BY bucket_milli", [item.id])).map(row => row[0]);
    assert.deepEqual(buckets, (item.owned ? [recentBucket, currentDay] : [oldBucket, recentBucket, currentDay]).sort((a, b) => a - b));
  }
  assert.equal(pluginMessages().length, deliveredBeforePrune);
  await cycle();
  console.log("PASS: owned expired rollups pruned; recent/current buckets, foreign tasks and notification state preserved");
  // Seed a non-empty latest-status Ping dictionary for the actual synthetic node.
  for (const taskId of [tasks[0].id, userTask.task_id]) {
    const tags = JSON.stringify({ task_id: String(taskId) });
    const hash = createHash("sha256").update(tags).digest("hex");
    let rows = await sqlQuery("SELECT id FROM metric_series WHERE entity_id = ? AND metric_name = ? AND tags_hash = ?", [monitored.uuid, "ping.latency_ms", hash]);
    if (!rows.length) {
      await sqlExec("INSERT INTO metric_series (metric_name, entity_id, tags_hash, tags) VALUES (?, ?, ?, ?)", ["ping.latency_ms", monitored.uuid, hash, tags]);
      rows = await sqlQuery("SELECT id FROM metric_series WHERE entity_id = ? AND metric_name = ? AND tags_hash = ?", [monitored.uuid, "ping.latency_ms", hash]);
    }
    await insertRollup(rows[0][0], minuteId, recentBucket - 60000);
  }
  const report = await fetch(base + "/api/clients/v2/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "agent.report", id: 1, token: monitored.token, params: { report: { cpu: { usage: 12 }, updated_at: new Date().toISOString() } } }) });
  assert.ok(!(await report.json()).error);
  // Reproduce the native hook bypass rather than claiming strict access isolation.
  const bypassed = await new Promise((resolveBody, reject) => {
    http.get(base + "/api/task/ping", { headers: { Connection: "Upgrade", Upgrade: "websocket" } }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => { try { resolveBody(JSON.parse(body)); } catch (e) { reject(e); } });
      response.on("error", reject);
    }).on("error", reject);
  });
  assert.ok(bypassed.data.some(t => t.name.startsWith("[Komari GFW:")));
  console.log("VERIFIED LIMITATION: Upgrade headers bypass HTTP hooks even on the ordinary REST task endpoint");
  async function verifyVisibility() {
    const ownedIds = new Set((await rawTasks()).filter(t => t.name.startsWith("[Komari GFW:")).map(t => String(t.id)));
    const metricParams = { metric_keys: ["ping.latency_ms", "ping.loss"], entity_ids: ["retention-fixture"], hours: 1, fill_empty: false, max_points: 4000 };
    const requests = [
      ["public:getPublicPingTasks", {}],
      ["public:getPingRecords", { uuid: "retention-fixture", hours: "1", max_count: 1 }],
      ["public:queryMetrics", metricParams],
      ["public:getPingMetricStats", { entity_ids: ["retention-fixture"], hours: 1 }],
      ["common:getRecords", { type: "ping", uuid: "retention-fixture", hours: 1, maxCount: 1 }],
      ["common:getNodesLatestStatus", {}],
      ["common:getNodesLatestStatus", { uuid: monitored.uuid }],
    ];
    const assertClean = (method, value) => {
      assert.ok(!JSON.stringify(value).includes("[Komari GFW:"), method);
      if (method === "public:getPublicPingTasks" || method === "admin:getAllPingTasks") assert.deepEqual(value.map(t => t.id), [userTask.task_id]);
      if (method === "public:getPingRecords" || method === "common:getRecords") {
        assert.equal(value.count, value.records.length);
        assert.equal(value.count, 1, method);
        assert.ok(value.records.every(r => r.task_id === userTask.task_id));
        assert.ok(value.basic_info?.every(s => s.loss === 0 && s.min === 1 && s.max === 1));
      }
      if (method === "public:queryMetrics") {
        assert.equal(value.count, value.series.length);
        assert.ok(value.series.some(s => s.tags?.task_id === String(userTask.task_id) && s.points?.length));
        assert.ok(value.series.every(s => !ownedIds.has(s.tags?.task_id) && (s.points ?? []).every(p => !ownedIds.has(p.tags?.task_id))));
      }
      if (method === "public:getPingMetricStats") {
        assert.equal(value.count, value.stats.length);
        assert.ok(value.stats.some(s => s.task_id === String(userTask.task_id)));
        assert.ok(value.stats.every(s => !ownedIds.has(s.task_id)));
      }
      if (method === "common:getNodesLatestStatus") {
        const node = value.client ? value : value[monitored.uuid];
        assert.ok(node);
        assert.equal(node.cpu, 12);
        assert.ok(node.ping[String(userTask.task_id)]);
        assert.ok(Object.keys(node.ping).every(id => !ownedIds.has(id)));
      }
    };
    const starts = Date.now();
    for (const authenticated of [false, true]) {
      for (const [method, params] of requests) {
        const response = await json("/api/rpc2", { jsonrpc: "2.0", id: "visibility", method, params }, authenticated);
        assert.equal(response.id, "visibility");
        assertClean(method, response.result);
      }
      assert.deepEqual((await json("/api/task/ping", undefined, authenticated)).data.map(t => t.id), [userTask.task_id]);
      const history = (await json("/api/records/ping?uuid=retention-fixture&hours=1", undefined, authenticated)).data;
      assert.ok(history.records.length > 0);
      assert.ok(history.records.every(r => r.task_id === userTask.task_id));
      assert.equal(history.count, history.records.length);
    }
    const ordinary = (await rawTasks()).find(t => t.id === userTask.task_id);
    for (const path of ["/api/admin/ping", "/api/admin/ping/", "/api/admin/ping/?check=visibility"]) {
      assert.deepEqual((await json(path)).data, [ordinary]);
      const denied = await fetch(base + path);
      assert.ok([401, 403].includes(denied.status));
    }
    assert.deepEqual(await rpc("admin:getAllPingTasks"), [ordinary]);
    const batch = await json("/api/rpc2", [
      { jsonrpc: "2.0", method: "public:getPublicPingTasks", id: 10 },
      { jsonrpc: "2.0", method: "admin:getAllPingTasks", id: 10 },
      { jsonrpc: "2.0", method: "public:getVersion", id: "version" },
    ]);
    assert.deepEqual(batch[0].result.map(t => t.id), [userTask.task_id]);
    assert.deepEqual(batch[1].result, [ordinary]);
    assert.deepEqual(batch[2].result, hostVersion);
    assert.deepEqual(batch.map(r => r.id), [10, 10, "version"]);
    // Use a same-origin browser client: the host correctly rejects anonymous
    // native WebSockets without Origin. Do not weaken its Origin policy for tests.
    const wsContext = await browser.newContext();
    const wsPage = await wsContext.newPage();
    await wsPage.goto(base + "/api/version");
    try {
      const readSocket = requests => wsPage.evaluate(async ({ requests }) => {
        const ws = new WebSocket(location.origin.replace("http:", "ws:") + "/api/rpc2");
        await new Promise((resolveOpen, reject) => { ws.onopen = resolveOpen; ws.onerror = () => reject(new Error("WebSocket handshake failed")); });
        const results = [];
        try {
          for (const [method, params] of requests) for (const binary of [false, true]) {
            const response = new Promise((resolveMessage, reject) => {
              const timer = setTimeout(() => reject(new Error("WebSocket response timeout")), 5000);
              ws.onmessage = event => { clearTimeout(timer); resolveMessage(JSON.parse(event.data)); };
            });
            const wire = JSON.stringify({ jsonrpc: "2.0", id: "ws-id", method, params });
            ws.send(binary ? new TextEncoder().encode(wire) : wire);
            results.push({ method, message: await response });
          }
          return results;
        } finally { ws.close(); }
      }, { requests });
      const replies = await readSocket(requests);
      await wsContext.addCookies([{ name: "session_token", value: cookie.split("=")[1], url: base }]);
      replies.push(...await readSocket([...requests, ["admin:getAllPingTasks", {}]]));
      for (const { method, message } of replies) {
        assert.equal(message.id, "ws-id");
        assert.ok(!message.error, JSON.stringify(message.error));
        assertClean(method, message.result);
      }
    } finally { await wsContext.close(); }
    const state = await plugin("overview");
    assert.equal(state.visibilityError, "");
    if (state.enabled) assert.ok(state.rows[0].samples.every(s => s.at !== null));
    console.log(`PASS: public/admin REST, HTTP RPC mixed batches, anonymous/admin text/binary WebSocket, user history/stats and internal samples (${Date.now() - starts} ms)`);
  }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  await verifyVisibility();
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: "zh-CN" });
  await context.addCookies([{ name: "session_token", value: cookie.split("=")[1], url: base }]);
  const errors = []; context.on("page", p => p.on("pageerror", error => errors.push(error.message)));
  const page = await context.newPage();
  const overviewPath = "/admin/plugin-page?short=komari-gfw&file=pages%2Foverview.html";
  const directionalStart = pluginMessages().length;
  for (const [direction, changedPorts, opening] of [["reverse", [0, 1, 2], false], ["both", [5], false], ["forward", [0, 1, 2], true], [null, [5], true]]) {
    for (const i of changedPorts) {
      if (opening) ports[i].listener = await tcpServer(ports[i].port);
      else await new Promise(r => ports[i].listener.close(r));
    }
    const result = await cycle();
    assert.equal(result.rows[0].alarm, Boolean(direction));
    assert.equal(result.rows[0].alarmDirection, direction);
    const expected = { reverse: "疑似反向墙", both: "疑似双向墙", forward: "疑似正向墙" }[direction];
    await page.goto(base + overviewPath);
    const matrix = page.frameLocator("iframe.km-plugin-frame").locator("#matrix");
    await matrix.getByText(expected ?? "正常", { exact: true }).waitFor();
    if (direction) await page.screenshot({ path: join(root, `direction-${direction}.png`), fullPage: true });
  }
  const directionalNotices = pluginMessages().slice(directionalStart).map(body => JSON.parse(body));
  assert.deepEqual(directionalNotices.map(n => n.title), ["服务器疑似被墙", "服务器被墙方向变化", "服务器被墙方向变化", "服务器解除被墙状态"]);
  for (const [index, text] of ["疑似反向墙", "疑似双向墙", "疑似正向墙", "已解除"].entries()) {
    assert.ok(directionalNotices[index].message.includes(`被墙状态：${text}`));
    assert.ok(!directionalNotices[index].message.includes("203.0.113.25"));
    assert.doesNotMatch(directionalNotices[index].message, /说明：|封锁原因|TCP 连通性推断/);
  }
  assert.ok(directionalNotices[1].message.includes("状态变化：疑似反向墙 → 疑似双向墙"));
  assert.ok(directionalNotices[2].message.includes("状态变化：疑似双向墙 → 疑似正向墙"));
  console.log("PASS: live reverse/both/forward classifications, overview labels, direction-change Webhooks and full recovery");

  const rawBeforeEdit = await rawTasks();
  const ownBeforeEdit = rawBeforeEdit.filter(t => t.name.startsWith("[Komari GFW:"));
  const userBeforeEdit = rawBeforeEdit.find(t => t.id === userTask.task_id);
  await page.goto(base + "/admin/ping");
  const taskView = page.locator(".km-pingtask-task-table");
  await taskView.getByText(userBeforeEdit.name, { exact: true }).waitFor();
  assert.equal(await taskView.locator("tbody tr").count(), 1);
  assert.ok(!(await taskView.innerText()).includes("[Komari GFW:"));
  await page.screenshot({ path: join(root, "admin-ping-tasks.png"), fullPage: true });
  await page.locator(".km-pingtask-nav").getByRole("tab").nth(1).click();
  const serverView = page.locator(".km-pingtask-server-list");
  await serverView.getByText("Test overseas", { exact: true }).waitFor();
  assert.ok(!(await serverView.innerText()).includes("[Komari GFW:"));
  await page.screenshot({ path: join(root, "admin-ping-servers.png"), fullPage: true });
  for (const assigned of [false, true]) {
    await serverView.getByRole("row").filter({ hasText: "Test overseas" }).getByRole("button").click();
    const dialog = page.locator(".km-pingtask-server-form");
    await dialog.locator("tbody tr").filter({ hasText: userBeforeEdit.name }).waitFor();
    assert.equal(await dialog.locator("tbody tr").count(), 1);
    assert.ok(!(await dialog.innerText()).includes("[Komari GFW:"));
    if (!assigned) await page.screenshot({ path: join(root, "admin-ping-selector.png"), fullPage: true });
    await dialog.locator("tbody tr").click();
    await dialog.getByRole("button", { name: /^(保存|Save)$/ }).click();
    await dialog.waitFor({ state: "hidden" });
    await waitFor(async () => (await rawTasks()).find(t => t.id === userTask.task_id).clients.includes(monitored.uuid) === assigned, "Native user task membership saved");
    assert.deepEqual((await rawTasks()).filter(t => t.name.startsWith("[Komari GFW:")), ownBeforeEdit);
  }
  assert.deepEqual((await rawTasks()).find(t => t.id === userTask.task_id), userBeforeEdit);
  const added = (await json("/api/admin/ping/add", { name: "Ordinary CRUD fixture", target: `127.0.0.1:${ports[4].port}`, type: "tcp", interval: 60, clients: [monitored.uuid], default_on: false })).data;
  const temporary = (await rpc("admin:getAllPingTasks")).find(t => t.id === added.task_id);
  assert.ok(temporary);
  await json("/api/admin/ping/edit", { tasks: [{ ...temporary, name: "Edited ordinary fixture" }] });
  await json("/api/admin/ping/order", { [temporary.id]: 10 });
  assert.equal((await rpc("admin:getAllPingTasks")).find(t => t.id === temporary.id).name, "Edited ordinary fixture");
  assert.equal((await rpc("admin:getAllPingTasks")).find(t => t.id === temporary.id).weight, 10);
  await json("/api/admin/ping/delete", { id: [temporary.id] });
  assert.deepEqual(await rawTasks(), rawBeforeEdit);
  await verifyVisibility();
  console.log("PASS: native admin task/server views and task selector hide internals; user binding edits and CRUD preserve all plugin tasks");
  const mixedAgent = await rpc("admin:addClient", { name: "Test reverse-only" });
  agents.push(mixedAgent);
  settings = await plugin("settings");
  settings = await plugin("settings", { config: { ...settings.config, clients: [...settings.config.clients, mixedAgent.uuid], reverse: { ...settings.config.reverse, [mixedAgent.uuid]: { enabled: false, port: 0, host: "" } } }, revision: settings.revision });
  assert.equal(settings.lastError, "");
  overview = await cycle();
  assert.equal(overview.rows.find(r => r.uuid === mixedAgent.uuid).samples.length, 5);
  assert.ok(overview.rows.every(r => r.health === "healthy"));
  assert.equal((await rawTasks()).filter(t => t.name.includes(":reverse:")).length, 1);
  const mixedStart = pluginMessages().length;
  for (const i of [0, 1, 2]) await new Promise(r => ports[i].listener.close(r));
  overview = await cycle();
  assert.equal(overview.rows.find(r => r.uuid === mixedAgent.uuid).alarmDirection, "basic");
  assert.equal(overview.rows.find(r => r.uuid === monitored.uuid).alarmDirection, "reverse");
  await page.goto(base + overviewPath);
  const mixedMatrix = page.frameLocator("iframe.km-plugin-frame").locator("#matrix");
  await mixedMatrix.getByText("疑似被墙", { exact: true }).waitFor();
  await mixedMatrix.getByText("疑似反向墙", { exact: true }).waitFor();
  await mixedMatrix.getByText("未启用", { exact: true }).waitFor();
  for (const i of [0, 1, 2]) ports[i].listener = await tcpServer(ports[i].port);
  overview = await cycle();
  assert.ok(overview.rows.every(r => !r.alarm));
  const mixedNotices = pluginMessages().slice(mixedStart).map(body => JSON.parse(body));
  assert.equal(mixedNotices.length, 4);
  assert.equal(mixedNotices.filter(n => n.message.includes("服务器：Test reverse-only") && !n.message.includes("正向（大陆探针")).length, 2);
  settings = await plugin("settings");
  const existingForward = (await rawTasks()).find(t => t.name.endsWith(`:reverse:${monitored.uuid}]`));
  settings = await plugin("settings", { config: { ...settings.config, reverse: { ...settings.config.reverse, [mixedAgent.uuid]: { enabled: true, port: ports[5].port, host: "127.0.0.1" } } }, revision: settings.revision });
  assert.equal(settings.lastError, "");
  const removedForward = (await rawTasks()).find(t => t.name.endsWith(`:reverse:${mixedAgent.uuid}]`));
  assert.ok(removedForward);
  overview = await cycle();
  assert.ok(overview.rows.every(r => r.forwardEnabled && r.health === "healthy"));
  await rpc("admin:removeClient", { uuid: mixedAgent.uuid });
  overview = await plugin("refresh", {});
  assert.equal(overview.rows.length, 1);
  assert.equal(overview.strict, true);
  assert.equal(overview.enabled, true);
  assert.ok(!(await rawTasks()).some(t => t.id === removedForward.id));
  assert.deepEqual((await rawTasks()).find(t => t.id === existingForward.id), existingForward);
  settings = await plugin("settings");
  assert.ok(!(mixedAgent.uuid in settings.config.reverse));
  await plugin("settings", { config: settings.config, revision: settings.revision });
  await cycle();
  console.log("PASS: mixed forward/reverse-only tasks, independent alarms/recovery, overview and dedicated task deletion");
  await page.goto(base + overviewPath);
  const overviewFrame = page.frameLocator("iframe.km-plugin-frame");
  await overviewFrame.getByRole("heading", { name: "被墙检测总览", exact: true }).waitFor();
  await overviewFrame.getByRole("cell", { name: /Test overseas/ }).waitFor();
  assert.equal(await overviewFrame.locator("header a, header nav").count(), 0);
  await overviewFrame.getByRole("columnheader", { name: "正向探针（大陆出发）", exact: true }).waitFor();
  assert.ok(!(await overviewFrame.locator("body").innerText()).includes("203.0.113.25"));
  await page.screenshot({ path: join(root, "overview-desktop.png"), fullPage: true });
  const configPage = page;
  // Exercise a real request-hook failure before opening the configuration UI.
  // The host must reject the ambiguous request, never return raw Ping tasks.
  const ambiguous = await fetch(base + "/api/rpc2", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"public:getPublicPingTasks","method":"public:getVersion"}' });
  assert.equal(ambiguous.status, 500);
  assert.ok(!(await ambiguous.text()).includes("[Komari GFW:"));
  const failureState = await plugin("overview");
  assert.match(failureState.visibilityError, /POST \/api\/rpc2 request \/ Ambiguous duplicate JSON key/);
  assert.ok(failureState.visibilityDiagnostics.some(d => d.entry === "POST /api/rpc2 request" && d.recoveredAt === null));
  await rpc("public:getVersion");
  assert.ok((await plugin("overview")).visibilityError, "An unrelated RPC cannot clear a warning");
  await configPage.goto(base + "/admin/plugins/config?short=komari-gfw");
  const configFrame = configPage.frameLocator('iframe[title="被墙检测配置"]');
  await configFrame.getByRole("heading", { name: "被墙检测配置", exact: true }).waitFor();
  assert.equal(await configFrame.locator("header a, header nav").count(), 0);
  await configFrame.locator("#settings-fields").waitFor();
  await waitFor(async () => !(await configFrame.locator("#settings-fields").isDisabled()), "Settings enabled");
  await configFrame.locator("#visibility-diagnostics summary").click();
  await configFrame.locator("#visibility-failures").getByText(/Ambiguous duplicate JSON key/).waitFor();
  await rpc("public:getPublicPingTasks");
  const recoveredVisibility = await plugin("overview");
  assert.equal(recoveredVisibility.visibilityError, "");
  assert.ok(recoveredVisibility.visibilityDiagnostics.some(d => d.check === "Ambiguous duplicate JSON key" && d.recoveredAt !== null));
  await waitFor(async () => (await configFrame.locator("#visibility-failures").innerText()).includes("已恢复"), "Recovered diagnostics retained in UI without reloading", 15000);
  assert.equal(await configFrame.locator("#message").isHidden(), true);
  console.log("PASS: real request failure is scoped, fails closed and remains in administrator diagnostics after recovery");
  assert.equal(await configFrame.locator("#strict").isChecked(), true);
  assert.equal(await configPage.getByRole("button", { name: /保存并重载|Save and reload/i }).isVisible(), false);
  const observerSearch = configFrame.getByRole("searchbox", { name: "搜索境内探针", exact: true });
  const searchRevision = (await plugin("settings")).revision;
  await observerSearch.fill("MAINLAND A");
  await observerSearch.press("Enter");
  await observerSearch.press("Tab");
  assert.equal(await configFrame.locator("#observers input").count(), 1);
  assert.equal(await configFrame.locator("#dirty").innerText(), "所有更改已保存");
  assert.equal((await plugin("settings")).revision, searchRevision);
  await configFrame.locator("#observers input").uncheck();
  await observerSearch.fill("mainland b");
  assert.equal(await configFrame.locator("#observers input").isChecked(), true);
  await observerSearch.fill("no matching probe");
  await configFrame.getByText("没有匹配的境内探针", { exact: true }).waitFor();
  await observerSearch.fill("mainland a");
  assert.equal(await configFrame.locator("#observers input").isChecked(), false);
  await configFrame.locator("#observers input").check();
  await observerSearch.fill("203.0.*.*");
  assert.equal(await configFrame.locator("#observers input").count(), 3);
  await observerSearch.fill("Synthetic fixtures");
  assert.equal(await configFrame.locator("#observers input:checked").count(), 2);
  await observerSearch.fill("");
  const extraClients = [];
  for (let i = 0; i < 32; i++) extraClients.push(await rpc("admin:addClient", { name: `Compact selection ${String(i).padStart(2, "0")}` }));
  await configPage.reload();
  await waitFor(async () => !(await configFrame.locator("#settings-fields").isDisabled()), "Large selection loaded");
  async function verifyCompactSelection() {
    for (const id of ["clients", "observers"]) {
      const region = configFrame.locator(`#${id}`);
      const dimensions = await region.evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight, width: el.clientWidth, scrollWidth: el.scrollWidth, max: parseFloat(getComputedStyle(el).maxHeight), overflow: getComputedStyle(el).overflowY }));
      assert.ok(dimensions.height <= 360 && dimensions.height <= dimensions.max + 1, `${id} bounded height`);
      assert.ok(dimensions.scroll > dimensions.height, `${id} internal scroll`);
      assert.equal(dimensions.overflow, "auto");
      assert.ok(dimensions.scrollWidth <= dimensions.width, `${id} no horizontal overflow`);
      await region.evaluate(el => { el.scrollTop = el.scrollHeight; });
      assert.ok(await region.evaluate(el => el.scrollTop > 0));
      await region.evaluate(el => { el.scrollTop = 0; });
    }
  }
  await verifyCompactSelection();
  const forwardToggle = configFrame.getByRole("checkbox", { name: "Test overseas 启用正向检测", exact: true });
  const portInput = configFrame.getByRole("spinbutton", { name: "Test overseas 测试端口", exact: true });
  const hostInput = configFrame.getByRole("textbox", { name: "Test overseas 测试地址", exact: true });
  await portInput.fill(""); await hostInput.fill("unfinished/");
  assert.equal(await portInput.evaluate(el => el.validity.valid), false);
  await forwardToggle.uncheck();
  assert.equal(await portInput.count(), 0);
  await configFrame.getByRole("button", { name: "保存配置", exact: true }).click();
  await configFrame.getByText("配置已保存，探测任务已同步。", { exact: true }).waitFor();
  settings = await plugin("settings");
  assert.equal(settings.config.reverse[monitored.uuid].port, 0);
  assert.equal(settings.config.reverse[monitored.uuid].host, "unfinished/");
  assert.equal(settings.config.reverse[monitored.uuid].enabled, false);
  await configPage.reload();
  await waitFor(async () => !(await configFrame.locator("#settings-fields").isDisabled()), "Disabled draft reloaded");
  await forwardToggle.check();
  assert.equal(await portInput.inputValue(), "");
  assert.equal(await hostInput.inputValue(), "unfinished/");
  await portInput.fill(String(ports[5].port)); await hostInput.fill("127.0.0.1");
  await configFrame.locator("#strict").uncheck();
  assert.equal(await forwardToggle.count(), 0);
  assert.equal(await configFrame.locator("[data-forward-client]").count(), 0);
  assert.equal(await portInput.count(), 0);
  assert.equal(await configFrame.locator("#strict-options").isHidden(), true);
  await configFrame.getByRole("button", { name: "保存配置", exact: true }).click();
  await configFrame.getByText("配置已保存，探测任务已同步。", { exact: true }).waitFor();
  await configPage.reload();
  await waitFor(async () => !(await configFrame.locator("#settings-fields").isDisabled()), "Global-off draft reloaded");
  assert.equal(await forwardToggle.count(), 0);
  assert.equal(await configFrame.locator("[data-forward-client]").count(), 0);
  assert.equal(await portInput.count(), 0);
  await configFrame.locator("#strict").check();
  assert.equal(await forwardToggle.isChecked(), true);
  assert.equal(await portInput.inputValue(), String(ports[5].port));
  assert.equal(await hostInput.inputValue(), "127.0.0.1");
  const clientSearch = configFrame.locator("#client-search");
  await clientSearch.fill("no matching server");
  assert.equal(await configFrame.locator("#clients input").count(), 0);
  await clientSearch.fill("Test overseas");
  assert.equal(await forwardToggle.isChecked(), true);
  assert.equal(await portInput.inputValue(), String(ports[5].port));
  await clientSearch.fill("");
  await configPage.screenshot({ path: join(root, "probes-desktop.png"), fullPage: true });
  await configFrame.locator("#enabled").uncheck();
  await configFrame.getByRole("button", { name: "保存配置", exact: true }).click();
  await configFrame.getByText("配置已保存，探测任务已同步。", { exact: true }).waitFor();
  assert.equal((await plugin("settings")).config.enabled, false);
  await verifyVisibility();
  await configPage.reload();
  await configFrame.locator("#settings-fields").waitFor();
  await waitFor(async () => !(await configFrame.locator("#settings-fields").isDisabled()), "Reloaded settings");
  assert.equal(await configFrame.locator("#enabled").isChecked(), false);
  await configPage.screenshot({ path: join(root, "settings-desktop.png"), fullPage: true });
  await configPage.setViewportSize({ width: 390, height: 844 });
  const menuCollapsed = () => configPage.locator(".km-admin-panel-nav").evaluate(el => Number(getComputedStyle(el).opacity) < 0.01);
  async function closeMobileMenu() {
    await waitFor(() => configPage.locator(".km-admin-panel-nav").evaluate(el => getComputedStyle(el).position === "absolute"), "Mobile navigation active");
    if (!await menuCollapsed()) {
      try { await configPage.locator(".km-admin-panel-nav button[aria-label]").first().click({ timeout: 5000 }); }
      catch (error) { if (!await menuCollapsed()) throw error; }
    }
    await waitFor(menuCollapsed, "Mobile menu closed");
  }
  await closeMobileMenu();
  await verifyCompactSelection();
  await configFrame.locator("#strict").uncheck();
  assert.equal(await configFrame.locator("[data-forward-client], .reverse-fields").count(), 0);
  await configFrame.locator("#strict").check();
  assert.equal(await forwardToggle.isChecked(), true);
  assert.equal(await portInput.inputValue(), String(ports[5].port));
  assert.equal(await hostInput.inputValue(), "127.0.0.1");
  // Restore the saved form without leaving a spurious beforeunload prompt.
  await configFrame.getByRole("button", { name: "保存配置", exact: true }).click();
  await configFrame.getByText("配置已保存，探测任务已同步。", { exact: true }).waitFor();
  assert.equal(await configPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await configFrame.locator("html").evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await configPage.screenshot({ path: join(root, "settings-mobile.png"), fullPage: true });
  await observerSearch.fill("mainland b");
  assert.equal(await configFrame.locator("#observers input").count(), 1);
  assert.equal(await configFrame.locator("#observers input").isChecked(), true);
  await observerSearch.evaluate(el => el.scrollIntoView({ block: "center" }));
  await configPage.screenshot({ path: join(root, "probes-mobile.png"), fullPage: true });
  await observerSearch.fill("");
  await configPage.locator("nav button[aria-label]").first().click();
  const overviewLink = configPage.getByRole("link", { name: "被墙检测总览", exact: true });
  await overviewLink.scrollIntoViewIfNeeded();
  await overviewLink.press("Enter");
  await configPage.waitForURL(base + overviewPath);
  await closeMobileMenu();
  const mobileOverview = configPage.frameLocator("iframe.km-plugin-frame");
  await mobileOverview.getByRole("heading", { name: "被墙检测总览", exact: true }).waitFor();
  assert.equal(await configPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await mobileOverview.locator("html").evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await configPage.screenshot({ path: join(root, "overview-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS: native admin navigation, display names, no duplicate header links, config save/reload and desktop/mobile UI");
  await configPage.goto(base + "/api/version");
  for (const client of extraClients) await rpc("admin:removeClient", { uuid: client.uuid });
  settings = await plugin("settings");
  await plugin("settings", { config: { ...settings.config, enabled: true }, revision: settings.revision });
  await cycle();
  const existingUserTask = (await rawTasks()).find(t => t.id === userTask.task_id);
  const messageCount = pluginMessages().length;
  await rpc("admin:removeClient", { uuid: agents[1].uuid });
  overview = await plugin("refresh", {});
  assert.equal(overview.lastError, "");
  assert.equal(overview.enabled, true);
  assert.equal(overview.strict, false);
  assert.match(overview.selectionNotice, /正向检测已自动关闭，继续反向检测/);
  assert.ok(!(await rawTasks()).some(t => t.name.includes(":reverse:")));
  assert.deepEqual((await rawTasks()).find(t => t.id === userTask.task_id), existingUserTask);
  overview = await cycle();
  assert.equal(overview.rows[0].health, "healthy");
  assert.equal(pluginMessages().length, messageCount);
  await configPage.setViewportSize({ width: 1400, height: 1000 });
  await configPage.goto(base + "/admin/plugins/config?short=komari-gfw");
  await waitFor(async () => !(await configFrame.locator("#settings-fields").isDisabled()), "Repaired settings enabled");
  assert.equal(await configFrame.locator("#enabled").isChecked(), true);
  assert.equal(await configFrame.locator("#strict").isChecked(), false);
  assert.match(await configFrame.locator("#selection-notice").innerText(), /正向检测已自动关闭/);
  await configPage.screenshot({ path: join(root, "deleted-observer-settings.png"), fullPage: true });
  const repairedRevision = (await plugin("settings")).revision;
  await waitFor(async () => !(await plugin("settings")).selectionNotice, "Selection notice acknowledged without saving");
  await waitFor(() => configFrame.locator("#selection-notice").isHidden(), "One-time notice auto-dismissed", 12000);
  assert.equal((await plugin("settings")).revision, repairedRevision);
  await configPage.reload();
  await waitFor(async () => !(await configFrame.locator("#settings-fields").isDisabled()), "Acknowledged settings reloaded");
  assert.equal(await configFrame.locator("#selection-notice").isHidden(), true);
  await configFrame.getByRole("button", { name: "保存配置", exact: true }).click();
  await configFrame.getByText("配置已保存，探测任务已同步。", { exact: true }).waitFor();
  await rpc("admin:setPluginEnabled", { short: "komari-gfw", enabled: false });
  await rpc("admin:setPluginEnabled", { short: "komari-gfw", enabled: true, approved: true });
  settings = await plugin("settings");
  assert.equal(settings.config.strict, false);
  assert.equal(settings.config.enabled, true);
  await cycle();
  const retiring = (await rawTasks()).filter(t => t.name.startsWith("[Komari GFW:"));
  await rpc("admin:removeClient", { uuid: monitored.uuid });
  overview = await plugin("refresh", {});
  assert.equal(overview.lastError, "");
  assert.equal(overview.enabled, false);
  assert.deepEqual(overview.rows, []);
  assert.deepEqual((await rawTasks()).map(t => t.id), [userTask.task_id]);
  assert.equal(pluginMessages().length, messageCount);
  settings = await plugin("settings");
  await plugin("settings", { config: settings.config, revision: settings.revision });
  assert.deepEqual(errors, []);
  console.log("PASS: deleted observer disables strict mode only; notice acknowledges and expires without saving, reload does not repeat it; basic probes continue; last target deletion stops without false recovery");
  await plugin("cleanup", { confirm: "DELETE_PLUGIN_TASKS" });
  assert.deepEqual((await rawTasks()).map(t => t.id), [userTask.task_id]);
  assert.deepEqual((await rpc("admin:getAllPingTasks")).map(t => t.id), [userTask.task_id]);
  console.log("PASS: owned-task cleanup");
  // Exercise the real metrics SQL with aged test-only tombstones. Hooks are off
  // so public RPC here reads raw host samples, just like in-process server.call.
  await rpc("admin:setPluginEnabled", { short: manifest.short, enabled: false });
  const gcNow = Date.now();
  const retired = Object.fromEntries(retiring.map(t => [t.id, { name: t.name, deletedAt: gcNow - RETIRED_PROTECTION_MS }]));
  const userRows = await sqlQuery("SELECT * FROM metric_series WHERE tags_hash = ?", [createHash("sha256").update(JSON.stringify({ task_id: String(userTask.task_id) })).digest("hex")]);
  const collected = await collectRetiredHistory({ call: rpc }, retired, "metric_", gcNow, agents.map(a => a.uuid));
  assert.deepEqual(collected.sort((a, b) => a - b), retiring.map(t => t.id).sort((a, b) => a - b));
  for (const task of retiring) assert.deepEqual(await sqlQuery("SELECT id FROM metric_series WHERE tags_hash = ?", [createHash("sha256").update(JSON.stringify({ task_id: String(task.id) })).digest("hex")]), []);
  assert.deepEqual(await sqlQuery("SELECT * FROM metric_series WHERE tags_hash = ?", [createHash("sha256").update(JSON.stringify({ task_id: String(userTask.task_id) })).digest("hex")]), userRows);
  console.log("PASS: real SQLite retired dictionary GC, unfiltered raw verification and user data preservation (accelerated test tombstones)");
  await writeFile(join(root, "host-test-result.json"), JSON.stringify({ komari: hostVersion, plugin: manifest.version, upgradeFrom: Boolean(process.env.KOMARI_TEST_UPGRADE_FROM), passed: true, checkedAt: new Date().toISOString(), checks: ["ZIP lifecycle", "ACL/CSRF", "raw metrics", "strict 2-observer block/recovery", "reverse/forward/both changes", "Webhook title/direction/redaction/no explanation", "persistence", "owned rollup retention", "public/admin HTTP/WS filtering", "native task/server/selector UI and user CRUD", "user history/statistics", "paused filtering", "observer search", "desktop/mobile UI", "deleted observer switches to basic monitoring", "deleted selection save/reload", "deleted last target stops without false recovery", "cleanup"], limitation: "Synthetic v2 Agents with real loopback TCP, not production geographically distributed Agents; real retention test uses SQLite. Hook limits are not an authorization boundary." }, null, 2));
} catch (error) {
  await writeFile(join(root, "host-test-error.log"), log);
  console.error(error?.stack ?? String(error)); process.exitCode = 1;
} finally {
  await browser?.close();
  for (const listener of listeners) if (listener.listening) await new Promise(r => listener.close(r));
  if (hook?.listening) { hook.closeAllConnections(); await new Promise(r => hook.close(r)); }
  if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
  if (!work.startsWith(root + sep)) throw new Error("Refusing unexpected cleanup path");
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
