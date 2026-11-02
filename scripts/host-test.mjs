import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { chromium } from "@playwright/test";

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
const pluginMessages = () => notifications.filter(body => { try { return JSON.parse(body).title?.startsWith("GFW "); } catch { return false; } });
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
  await json("/api/install/complete", { username: "test-admin", password, sitename: "GFW Local Test", metric_dsn: "./data/metrics.db" }, false);
  await sleep(1500);
  const login = await json("/api/login", { username: "test-admin", password }, false);
  cookie = "session_token=" + login.data["set-cookie"].session_token;
  console.log("PASS: isolated Komari 1.6.1 bootstrap and authentication");
  const zip = await readFile("dist/komari-gfw-0.1.0.zip");
  const upload = await json("/api/admin/upload/init", { purpose: "plugin", filename: "komari-gfw.zip", size: zip.length });
  const form = new FormData(); form.set("upload_id", upload.data.upload_id); form.set("chunk_index", "0"); form.set("chunk_data", new Blob([zip]), "chunk.zip");
  const chunk = await fetch(base + "/api/admin/upload/chunk", { method: "POST", headers: { Cookie: cookie }, body: form }); assert.equal(chunk.status, 200);
  await json("/api/admin/upload/merge", { upload_id: upload.data.upload_id });
  await rpc("admin:setPluginEnabled", { short: "komari-gfw", enabled: true, approved: true });
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
  await rpc("admin:editSettings", { notification_enabled: true, notification_method: "webhook", notification_template: "{{message}}" });
  await plugin("test-notification", {});
  assert.equal(pluginMessages().length, 1);
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
    for (const task of tasks) {
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
  console.log("PASS: loopback TCP, v2 ingestion, raw metrics, two reverse observers, block/recovery and system Webhook");
  await rpc("admin:setPluginEnabled", { short: "komari-gfw", enabled: false });
  assert.ok((await rpc("admin:getAllPingTasks")).every(t => !t.clients.length));
  await rpc("admin:setPluginEnabled", { short: "komari-gfw", enabled: true, approved: true });
  overview = await plugin("overview"); assert.equal(overview.events.length, 2);
  assert.equal(pluginMessages().length, 3);
  await cycle();
  console.log("PASS: unload pause, reload persistence and notification deduplication");
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: "zh-CN" });
  await context.addCookies([{ name: "session_token", value: cookie.split("=")[1], url: base }]);
  const page = await context.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const pages = base + "/api/admin/plugin/komari-gfw/pages/";
  await page.goto(pages + "overview.html");
  await page.getByRole("heading", { name: "跨境连通性", exact: true }).waitFor();
  await page.getByRole("cell", { name: /Test overseas/ }).waitFor();
  assert.ok(!(await page.locator("body").innerText()).includes("203.0.113.25"));
  await page.screenshot({ path: join(root, "overview-desktop.png"), fullPage: true });
  await page.getByRole("link", { name: "配置", exact: true }).click();
  await page.locator("#settings-fields").waitFor();
  await waitFor(async () => !(await page.locator("#settings-fields").isDisabled()), "Settings enabled");
  assert.equal(await page.locator("#strict").isChecked(), true);
  await page.locator("#enabled").uncheck();
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await page.getByText("配置已保存，探测任务已同步。", { exact: true }).waitFor();
  assert.equal((await plugin("settings")).config.enabled, false);
  await page.screenshot({ path: join(root, "settings-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(root, "settings-mobile.png"), fullPage: true });
  await page.getByRole("link", { name: "总览", exact: true }).click();
  await page.getByRole("heading", { name: "跨境连通性", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(root, "overview-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS: real-host admin pages, config save, desktop/mobile overflow and browser errors");
  await plugin("cleanup", { confirm: "DELETE_PLUGIN_TASKS" });
  assert.equal((await rpc("admin:getAllPingTasks") ?? []).length, 0);
  console.log("PASS: owned-task cleanup");
  await writeFile(join(root, "host-test-result.json"), JSON.stringify({ komari: "1.6.1", passed: true, checkedAt: new Date().toISOString(), checks: ["ZIP lifecycle", "ACL/CSRF", "raw metrics", "strict 2-observer block/recovery", "Webhook redaction", "persistence", "desktop/mobile UI", "cleanup"], limitation: "Synthetic v2 Agents with real loopback TCP, not production geographically distributed Agents." }, null, 2));
} catch (error) {
  await writeFile(join(root, "host-test-error.log"), log);
  console.error(error.stack); process.exitCode = 1;
} finally {
  await browser?.close();
  for (const listener of listeners) if (listener.listening) await new Promise(r => listener.close(r));
  if (hook?.listening) { hook.closeAllConnections(); await new Promise(r => hook.close(r)); }
  if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
  if (!work.startsWith(root + sep)) throw new Error("Refusing unexpected cleanup path");
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
