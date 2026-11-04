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
const pluginTitles = new Set(["GFW 测试通知", "GFW 疑似被墙", "GFW 解除被墙状态", "被墙检测测试通知", "服务器疑似被墙", "服务器解除被墙状态"]);
const pluginMessages = () => notifications.filter(body => { try { return pluginTitles.has(JSON.parse(body).title); } catch { return false; } });
function verifyNotificationCopy() {
  const [blocked, recovered] = pluginMessages().slice(-2).map(body => JSON.parse(body));
  assert.equal(blocked.title, "服务器疑似被墙");
  assert.equal(recovered.title, "服务器解除被墙状态");
  for (const [message, count] of [[blocked, 0], [recovered, 3]]) {
    assert.ok(message.message.includes(`反向（受检服务器到大陆目标）：${count}/3 可达`));
    assert.ok(message.message.includes("非大陆对照（受检服务器到非大陆目标）：2/2 可达"));
    assert.ok(message.message.includes(`正向（大陆探针到受检服务器）：${count ? 2 : 0}/2 可达（严格模式）`));
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
  const tasks = await rpc("admin:getAllPingTasks"); assert.equal(tasks.length, 6);
  const reverseTask = tasks.find(t => t.name.includes(":reverse:"));
  assert.equal(reverseTask.clients.length, 2);
  async function cycle() {
    const started = Date.now();
    for (const task of (await rpc("admin:getAllPingTasks")).filter(t => t.name.startsWith("[Komari GFW:"))) {
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
      return state.rows[0].lastRoundAt >= started ? state : null;
    }, "Fresh complete TCP round", 15000);
  }
  let overview = await cycle();
  if (overview.rows[0].health !== "healthy") {
    console.log("DIAGNOSTIC:", overview.lastError);
    const result = await rpc("public:queryMetrics", { metric_keys: ["ping.latency_ms"], entity_ids: agents.map(a => a.uuid), start: new Date(Date.now() - 480000).toISOString(), end: new Date().toISOString(), fill_empty: false, max_points: 4000 });
    console.log("METRIC SHAPE:", result.series?.map(s => ({ downsampled: s.downsampled, points: s.points?.length, sample: s.points?.[0], tags: s.tags })));
  }
  assert.equal(overview.rows[0].health, "healthy"); assert.equal(overview.rows[0].alarm, false);
  for (const item of ports.slice(0, 3)) await new Promise(r => item.listener.close(r));
  overview = await cycle(); assert.equal(overview.rows[0].alarm, false);
  await new Promise(r => ports[5].listener.close(r));
  overview = await cycle(); assert.equal(overview.rows[0].alarm, true);
  assert.equal(overview.events[0].type, "blocked");
  for (const item of ports.slice(0, 3)) item.listener = await tcpServer(item.port);
  overview = await cycle(); assert.equal(overview.rows[0].alarm, true);
  ports[5].listener = await tcpServer(ports[5].port);
  overview = await cycle(); assert.equal(overview.rows[0].alarm, false);
  assert.equal(overview.events[0].type, "recovered");
  assert.equal(pluginMessages().length, 3);
  assert.ok(!notifications.join("").includes("203.0.113.25"));
  assert.ok(notifications.join("").includes("203.0.*.*"));
  if (!process.env.KOMARI_TEST_UPGRADE_FROM) verifyNotificationCopy();
  console.log("PASS: loopback TCP, v2 ingestion, raw metrics, two mainland observers, block/recovery and system Webhook");
  await rpc("admin:setPluginEnabled", { short: "komari-gfw", enabled: false });
  assert.ok((await rpc("admin:getAllPingTasks")).every(t => !t.clients.length));
  await rpc("admin:setPluginEnabled", { short: "komari-gfw", enabled: true, approved: true });
  overview = await plugin("overview"); assert.equal(overview.events.length, 2);
  assert.equal(pluginMessages().length, 3);
  await cycle();
  console.log("PASS: unload pause, reload persistence and notification deduplication");
  if (process.env.KOMARI_TEST_UPGRADE_FROM) {
    const removed = await rpc("admin:addClient", { name: "Deleted before upgrade" });
    let before = await plugin("settings");
    before = await plugin("settings", { config: { ...before.config, clients: [...before.config.clients, removed.uuid], reverse: { ...before.config.reverse, [removed.uuid]: { host: "127.0.0.1", port: ports[5].port } } }, revision: before.revision });
    const beforeTasks = await rpc("admin:getAllPingTasks");
    await rpc("admin:removeClient", { uuid: removed.uuid });
    await install(zip);
    const expected = structuredClone(before.config);
    expected.clients = expected.clients.filter(id => id !== removed.uuid);
    delete expected.reverse[removed.uuid];
    const repaired = await plugin("settings");
    assert.deepEqual(repaired.config, expected);
    assert.equal(repaired.lastError, "");
    assert.match(repaired.selectionNotice, /已删除的受检服务器/);
    assert.equal((await plugin("overview")).events.length, 2);
    assert.equal(pluginMessages().length, 3);
    assert.deepEqual((await rpc("admin:getAllPingTasks")).map(t => t.id).sort(), beforeTasks.filter(t => !t.name.endsWith(`:reverse:${removed.uuid}]`)).map(t => t.id).sort());
    await cycle();
    console.log("PASS: upgrade repairs deleted selection while retaining surviving configuration, notification history and task identities");
    await plugin("settings", { config: repaired.config, revision: repaired.revision });
    for (const i of [0, 1, 2, 5]) await new Promise(r => ports[i].listener.close(r));
    overview = await cycle(); assert.equal(overview.rows[0].alarm, true);
    for (const i of [0, 1, 2, 5]) ports[i].listener = await tcpServer(ports[i].port);
    overview = await cycle(); assert.equal(overview.rows[0].alarm, false);
    assert.equal(pluginMessages().length, 5);
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
    const ownedIds = new Set((await rpc("admin:getAllPingTasks")).filter(t => t.name.startsWith("[Komari GFW:")).map(t => String(t.id)));
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
      if (method === "public:getPublicPingTasks") assert.deepEqual(value.map(t => t.id), [userTask.task_id]);
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
    const batch = await json("/api/rpc2", [
      { jsonrpc: "2.0", method: "public:getPublicPingTasks", id: 10 },
      { jsonrpc: "2.0", method: "admin:getAllPingTasks", id: 10 },
      { jsonrpc: "2.0", method: "public:getVersion", id: "version" },
    ]);
    assert.deepEqual(batch[0].result.map(t => t.id), [userTask.task_id]);
    assert.ok(batch[1].result.some(t => ownedIds.has(String(t.id))));
    assert.deepEqual(batch.map(r => r.id), [10, 10, "version"]);
    // Use a same-origin browser client: the host correctly rejects anonymous
    // native WebSockets without Origin. Do not weaken its Origin policy for tests.
    const wsPage = await browser.newPage();
    await wsPage.goto(base + "/api/version");
    try {
      const replies = await wsPage.evaluate(async ({ requests }) => {
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
      for (const { method, message } of replies) {
        assert.equal(message.id, "ws-id");
        assert.ok(!message.error, JSON.stringify(message.error));
        assertClean(method, message.result);
      }
    } finally { await wsPage.close(); }
    const state = await plugin("overview");
    assert.equal(state.visibilityError, "");
    if (state.enabled) assert.ok(state.rows[0].samples.every(s => s.at !== null));
    console.log(`PASS: public REST, HTTP RPC mixed batches, text/binary WebSocket, user history/stats and internal samples (${Date.now() - starts} ms)`);
  }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  await verifyVisibility();
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: "zh-CN" });
  await context.addCookies([{ name: "session_token", value: cookie.split("=")[1], url: base }]);
  const errors = []; context.on("page", p => p.on("pageerror", error => errors.push(error.message)));
  const page = await context.newPage();
  const overviewPath = "/admin/plugin-page?short=komari-gfw&file=pages%2Foverview.html";
  await page.goto(base + overviewPath);
  const overviewFrame = page.frameLocator("iframe.km-plugin-frame");
  await overviewFrame.getByRole("heading", { name: "被墙检测总览", exact: true }).waitFor();
  await overviewFrame.getByRole("cell", { name: /Test overseas/ }).waitFor();
  assert.equal(await overviewFrame.locator("header a, header nav").count(), 0);
  await overviewFrame.getByRole("columnheader", { name: "正向探针（大陆出发）", exact: true }).waitFor();
  assert.ok(!(await overviewFrame.locator("body").innerText()).includes("203.0.113.25"));
  await page.screenshot({ path: join(root, "overview-desktop.png"), fullPage: true });
  const configPage = page;
  await configPage.goto(base + "/admin/plugins/config?short=komari-gfw");
  const configFrame = configPage.frameLocator('iframe[title="被墙检测配置"]');
  await configFrame.getByRole("heading", { name: "被墙检测配置", exact: true }).waitFor();
  assert.equal(await configFrame.locator("header a, header nav").count(), 0);
  await configFrame.locator("#settings-fields").waitFor();
  await waitFor(async () => !(await configFrame.locator("#settings-fields").isDisabled()), "Settings enabled");
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
  await configPage.getByRole("link", { name: "被墙检测总览", exact: true }).click();
  await configPage.waitForURL(base + overviewPath);
  await closeMobileMenu();
  const mobileOverview = configPage.frameLocator("iframe.km-plugin-frame");
  await mobileOverview.getByRole("heading", { name: "被墙检测总览", exact: true }).waitFor();
  assert.equal(await configPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await mobileOverview.locator("html").evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await configPage.screenshot({ path: join(root, "overview-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS: native admin navigation, display names, no duplicate header links, config save/reload and desktop/mobile UI");
  settings = await plugin("settings");
  await plugin("settings", { config: { ...settings.config, enabled: true }, revision: settings.revision });
  await cycle();
  const existingUserTask = (await rpc("admin:getAllPingTasks")).find(t => t.id === userTask.task_id);
  const messageCount = pluginMessages().length;
  await rpc("admin:removeClient", { uuid: agents[1].uuid });
  overview = await plugin("refresh", {});
  assert.equal(overview.lastError, "");
  assert.equal(overview.enabled, true);
  assert.equal(overview.strict, false);
  assert.match(overview.selectionNotice, /严格模式已自动关闭，继续普通模式监测/);
  assert.ok(!(await rpc("admin:getAllPingTasks")).some(t => t.name.includes(":reverse:")));
  assert.deepEqual((await rpc("admin:getAllPingTasks")).find(t => t.id === userTask.task_id), existingUserTask);
  overview = await cycle();
  assert.equal(overview.rows[0].health, "healthy");
  assert.equal(pluginMessages().length, messageCount);
  await configPage.setViewportSize({ width: 1400, height: 1000 });
  await configPage.goto(base + "/admin/plugins/config?short=komari-gfw");
  await waitFor(async () => !(await configFrame.locator("#settings-fields").isDisabled()), "Repaired settings enabled");
  assert.equal(await configFrame.locator("#enabled").isChecked(), true);
  assert.equal(await configFrame.locator("#strict").isChecked(), false);
  assert.match(await configFrame.locator("#message").innerText(), /严格模式已自动关闭/);
  await configPage.screenshot({ path: join(root, "deleted-observer-settings.png"), fullPage: true });
  await configFrame.getByRole("button", { name: "保存配置", exact: true }).click();
  await configFrame.getByText("配置已保存，探测任务已同步。", { exact: true }).waitFor();
  await rpc("admin:setPluginEnabled", { short: "komari-gfw", enabled: false });
  await rpc("admin:setPluginEnabled", { short: "komari-gfw", enabled: true, approved: true });
  settings = await plugin("settings");
  assert.equal(settings.config.strict, false);
  assert.equal(settings.config.enabled, true);
  await cycle();
  await rpc("admin:removeClient", { uuid: monitored.uuid });
  overview = await plugin("refresh", {});
  assert.equal(overview.lastError, "");
  assert.equal(overview.enabled, false);
  assert.deepEqual(overview.rows, []);
  assert.equal(pluginMessages().length, messageCount);
  settings = await plugin("settings");
  await plugin("settings", { config: settings.config, revision: settings.revision });
  assert.deepEqual(errors, []);
  console.log("PASS: deleted observer disables strict mode only; basic probes, settings save and reload continue; deleting last target stops monitoring without false recovery");
  await plugin("cleanup", { confirm: "DELETE_PLUGIN_TASKS" });
  assert.deepEqual((await rpc("admin:getAllPingTasks") ?? []).map(t => t.id), [userTask.task_id]);
  console.log("PASS: owned-task cleanup");
  await writeFile(join(root, "host-test-result.json"), JSON.stringify({ komari: hostVersion, plugin: manifest.version, upgradeFrom: Boolean(process.env.KOMARI_TEST_UPGRADE_FROM), passed: true, checkedAt: new Date().toISOString(), checks: ["ZIP lifecycle", "ACL/CSRF", "raw metrics", "strict 2-observer block/recovery", "Webhook title/direction/redaction", "persistence", "owned rollup retention", "public HTTP/WS filtering", "user history/statistics", "paused filtering", "observer search", "desktop/mobile UI", "deleted observer switches to basic monitoring", "deleted selection save/reload", "deleted last target stops without false recovery", "cleanup"], limitation: "Synthetic v2 Agents with real loopback TCP, not production geographically distributed Agents; real retention test uses SQLite. Hook limits are not an authorization boundary." }, null, 2));
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
