import test from "node:test";
import assert from "node:assert/strict";
import { initialState, notificationReadiness, Service } from "../src/service.ts";
import type { MetricSeries, Notice, PingTask, Rpc, State } from "../src/types.ts";
import { validateConfig } from "../src/config.ts";
import { filterResult, TaskVisibility } from "../src/visibility.ts";

function fixture() {
  let now = Date.parse("2026-01-01T00:00:00Z"), id = 0;
  const tasks: PingTask[] = [{ id: 999, name: "User-owned", target: "example.com:80", type: "tcp", interval: 60, clients: ["a"], default_on: true }];
  const calls: { method: string; params: any }[] = [];
  let metrics: MetricSeries[] = [];
  let saved: State;
  let failNotifications = false, failRetention = false, failClients = false;
  let clients: unknown = ["a", "b", "observer"].map(uuid => ({ uuid, name: uuid, ipv4: "203.0.113.20", group: "test", token: "MUST_NOT_ESCAPE" }));
  const rpc = { async call(method: string, params: any) {
    calls.push({ method, params });
    if (method === "admin:listClients") { if (failClients) throw new Error("SECRET_CLIENT_RPC_ERROR"); return structuredClone(clients); }
    if (method === "admin:getSettings") return { notification_enabled: true, notification_method: "test", notification_template: "{{message}}" };
    if (method === "admin:getAllPingTasks") return structuredClone(tasks);
    if (method === "admin:addPingTask") { const task = { ...params, id: ++id }; tasks.push(task); return { task_id: task.id }; }
    if (method === "admin:editPingTask") { for (const task of params.tasks) Object.assign(tasks.find(t => t.id === task.id)!, task); return null; }
    if (method === "admin:deletePingTask") { for (let i = tasks.length - 1; i >= 0; i--) if (params.id.includes(tasks[i].id)) tasks.splice(i, 1); return null; }
    if (method === "public:queryMetrics") { assert.ok(params.max_points > 0); assert.equal(params.fill_empty, false); return { series: metrics }; }
    if (method === "admin:sendNotification") { if (failNotifications) throw new Error("SECRET_CHANNEL_URL"); return null; }
    if (method === "admin:dbTables") { if (failRetention) throw new Error("SECRET_DATABASE_DSN"); return { database: "metrics", driver: "sqlite", tables: ["metric_series", "metric_rollups", "metric_resolutions"] }; }
    if (method === "admin:dbQuery") return { database: "metrics", driver: "sqlite", columns: params.sql.includes("resolution_milli") ? ["id", "resolution_milli"] : ["id", "tags"], rows: [], truncated: false };
    throw new Error(`Unexpected ${method}`);
  } } as Rpc;
  const state = initialState("00112233445566778899aabb");
  const service = new Service(state, rpc, { save(value) { saved = structuredClone(value); } }, () => now);
  function setRound(values: number[], reverse?: Record<string, number>) {
    now += 60000;
    metrics = Object.entries(service.state.tasks).map(([key, taskId], index) => ({
      metric_key: "ping.latency_ms", entity_id: key.startsWith("reverse:") ? "observer" : "a", downsampled: false,
      tags: { task_id: String(taskId) }, points: [{ time: new Date(now - 500 + index).toISOString(), value: key.startsWith("reverse:") ? reverse?.[key.slice(8)] ?? -1 : values[index] }],
    }));
  }
  return { service, rpc, tasks, calls, setRound, saved: () => saved!, metrics: () => metrics, fail: () => { failNotifications = true; }, failRetention: () => { failRetention = true; }, failClients: () => { failClients = true; }, setClients: (value: unknown) => { clients = value; }, removeClient: (uuid: string) => { clients = (clients as { uuid: string }[]).filter(c => c.uuid !== uuid); }, now: () => now, advance: (ms: number) => { now += ms; } };
}

for (const strict of [false, true]) test(`visibility survives lifecycle without filtering internal RPC (strict=${strict})`, async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true, strict, observers: ["observer"], reverse: { a: { port: 443, host: "" } }, failureThreshold: 1, recoveryThreshold: 1 }, 0);
  const assertHidden = () => assert.deepEqual(filterResult(structuredClone(f.tasks), { kind: "tasks" }, f.service.visibility), [f.tasks[0]]);
  assertHidden();
  f.setRound([-1, -1, -1, 1, 1], { a: -1 }); await f.service.tick();
  assert.equal(f.service.snapshot().rows[0].alarm, true);
  assert.ok(f.service.snapshot().rows[0].samples.every(s => s.at !== null));
  assertHidden();
  const oldId = f.service.state.tasks["forward:cn1"];
  f.tasks.splice(f.tasks.findIndex(t => t.id === oldId), 1);
  await f.service.tick();
  assert.notEqual(f.service.state.tasks["forward:cn1"], oldId);
  assert.ok(f.service.visibility.has(oldId));
  assertHidden();
  await f.service.saveConfig({ ...f.service.state.config, enabled: false }, 1);
  assertHidden();
  assert.equal(f.service.snapshot().rows[0].health, "paused");
  assert.equal(f.service.snapshot().rows[0].alarm, true);
  const restored = new TaskVisibility(structuredClone(f.saved()));
  for (const id of f.saved().hiddenTaskIds!) assert.ok(restored.has(id));
  await f.service.saveConfig({ ...f.service.state.config, enabled: true }, 2);
  f.setRound([1, 1, 1, 1, 1], { a: 1 }); await f.service.tick();
  assert.equal(f.service.snapshot().rows[0].alarm, false);
  assertHidden();
  await f.service.saveConfig({ ...f.service.state.config, enabled: false }, 3);
  await f.service.cleanup();
  assertHidden();
  assert.ok(f.service.visibility.has(oldId));
});

test("notification preflight catches silent disabled/no-channel/no-message cases", () => {
  assert.equal(notificationReadiness({}).ready, false);
  assert.equal(notificationReadiness({ notification_enabled: true, notification_method: "none" }).ready, false);
  assert.equal(notificationReadiness({ notification_enabled: true, notification_method: "test", notification_template: "{{event}}" }).ready, false);
  assert.equal(notificationReadiness({ notification_enabled: true, notification_method: "test", notification_template: "{{message}}" }).ready, true);
});

test("obsolete strict tasks are removed without changing active or user tasks", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true, strict: true, observers: ["observer"], reverse: { a: { port: 443, host: "" } } }, 0);
  const active = f.tasks.filter(t => t.name.includes(":forward:")).map(t => t.id);
  await f.service.saveConfig({ ...f.service.state.config, strict: false }, 1);
  assert.deepEqual(f.tasks.filter(t => t.name.includes(":forward:")).map(t => t.id), active);
  assert.ok(!f.tasks.some(t => t.name.includes(":reverse:")));
  assert.ok(!("reverse:a" in f.service.state.tasks));
  assert.ok(f.tasks.some(t => t.name === "User-owned"));
});

test("history is bounded while paused; alarm state and live pending deliveries survive", async () => {
  const f = fixture();
  const event = (id: string, at: number, delivery: Notice["delivery"] = "sent"): Notice => ({ id, type: "blocked", at, since: at, client: "a", delivery, attempts: 0, nextAttemptAt: at, lastError: "", mainland: 0, overseas: 2, reverse: 0, reverseTotal: 0 });
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true, failureThreshold: 1 }, 0);
  f.setRound([-1, -1, -1, 1, 1]); await f.service.tick();
  await f.service.saveConfig({ ...f.service.state.config, enabled: false }, 1);
  f.service.state.events = [event("old", f.now() - 8 * 86400000), ...Array.from({ length: 150 }, (_, i) => event(String(i), f.now() - 1000 + i)), event("pending", f.now(), "pending")];
  await f.service.tick();
  assert.equal(f.saved().events.length, 101);
  assert.equal(f.saved().events[0].id, "50");
  assert.equal(f.saved().events.at(-1)!.delivery, "pending");
  assert.equal(f.saved().monitors.a.alarm, true);
  f.advance(8 * 86400000); await f.service.tick();
  assert.equal(f.saved().events.length, 0);
  assert.equal(f.saved().monitors.a.alarm, true);
});

test("history cleanup is hourly and does not disturb fresh detection", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true }, 0);
  f.setRound([1, 1, 1, 1, 1]); await f.service.tick();
  await f.service.tick();
  assert.equal(f.calls.filter(c => c.method === "admin:dbTables").length, 1);
  assert.equal(f.service.state.monitors.a.health, "healthy");
  assert.equal(f.service.retentionError, "");
  f.advance(3600000); await f.service.tick();
  assert.equal(f.calls.filter(c => c.method === "admin:dbTables").length, 2);
});

test("cleanup failures are redacted and do not reset detection streaks", async () => {
  const f = fixture(); f.failRetention();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true }, 0);
  f.setRound([-1, -1, -1, 1, 1]); await f.service.tick();
  assert.equal(f.service.state.monitors.a.failureStreak, 1);
  assert.equal(f.service.lastError, "");
  assert.ok(f.service.retentionError);
  assert.ok(!JSON.stringify(f.service.snapshot()).includes("SECRET_DATABASE_DSN"));
  for (let i = 0; i < 2; i++) { f.setRound([-1, -1, -1, 1, 1]); await f.service.tick(); }
  assert.equal(f.service.state.monitors.a.alarm, true);
});
test("disabled initial load creates no tasks and exposes no tokens", async () => {
  const f = fixture(); await f.service.tick();
  assert.equal(f.tasks.length, 1);
  assert.ok(!JSON.stringify(f.service.settings()).includes("MUST_NOT_ESCAPE"));
});
test("create 5 server-initiated tasks once, pause and cleanup only owned tasks", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, enabled: true, clients: ["a"] }, 0);
  assert.equal(f.tasks.length, 6);
  await f.service.tick(); await f.service.tick();
  assert.equal(f.tasks.length, 6);
  assert.ok(f.tasks.slice(1).every(t => t.default_on === false && t.clients.join() === "a"));
  await f.service.saveConfig({ ...f.service.state.config, enabled: false }, 1);
  assert.ok(f.tasks.slice(1).every(t => t.clients.length === 0));
  await f.service.cleanup();
  assert.equal(f.tasks.length, 1); assert.equal(f.tasks[0].name, "User-owned");
});
test("strict creates a mainland-to-server task per selected server, excludes self", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a", "b"], enabled: true, strict: true, observers: ["a", "observer"], reverse: { a: { port: 443, host: "" }, b: { port: 8443, host: "probe.example.com" } } }, 0);
  const a = f.tasks.find(t => t.name.endsWith(":reverse:a]"))!;
  const b = f.tasks.find(t => t.name.endsWith(":reverse:b]"))!;
  assert.equal(a.target, "203.0.113.20:443"); assert.deepEqual(a.clients, ["observer"]);
  assert.equal(b.target, "probe.example.com:8443"); assert.deepEqual(b.clients, ["a", "observer"]);
});
test("conflicting revisions cannot overwrite configuration", async () => {
  const f = fixture(); await assert.rejects(() => f.service.saveConfig(f.service.state.config, 9), /已变化/);
  assert.equal(f.service.state.revision, 0);
});

function pending(client: string, at: number): Notice {
  return { id: `${client}:${at}`, type: "blocked", at, since: at, client, delivery: "pending", attempts: 0, nextAttemptAt: at, lastError: "", mainland: 0, overseas: 2, reverse: 0, reverseTotal: 1 };
}

for (const strict of [false, true]) for (const enabled of [false, true]) test(`deleted monitored server is pruned and remaining monitoring recovers (strict=${strict}, enabled=${enabled})`, async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a", "b"], enabled: true, strict, observers: ["observer"], reverse: { a: { port: 443, host: "" }, b: { port: 80, host: "" } } }, 0);
  if (!enabled) await f.service.saveConfig({ ...f.service.state.config, enabled: false }, f.service.state.revision);
  const userTask = structuredClone(f.tasks[0]);
  const removedTask = f.service.state.tasks["reverse:b"];
  f.service.state.monitors.a.alarm = true;
  f.service.state.monitors.a.blockedSince = f.now();
  f.service.state.events.push(pending("b", f.now()), { ...pending("b", f.now() - 1000), delivery: "sent" });
  f.service.lastError = "任务同步失败 (Error)";
  f.removeClient("b");
  await f.service.tick();
  assert.equal(f.service.lastError, "");
  assert.deepEqual(f.service.state.config.clients, ["a"]);
  assert.deepEqual(Object.keys(f.service.state.config.reverse), ["a"]);
  assert.deepEqual(Object.keys(f.service.state.monitors), ["a"]);
  assert.equal(f.service.state.config.strict, strict);
  assert.equal(f.service.state.config.enabled, enabled);
  assert.equal(f.service.state.monitors.a.alarm, true);
  assert.ok(!("reverse:b" in f.service.state.tasks));
  assert.ok(!f.tasks.some(t => t.name.endsWith(":reverse:b]")));
  if (strict) assert.ok(f.service.visibility.has(removedTask));
  assert.equal(f.service.state.events.find(e => e.at === f.now())?.delivery, "superseded");
  assert.equal(f.service.state.events.find(e => e.at < f.now())?.delivery, "sent");
  assert.equal(f.calls.filter(c => c.method === "admin:sendNotification").length, 0);
  assert.deepEqual(f.tasks[0], userTask);
  assert.match(f.service.snapshot().selectionNotice, /已移除 1 台已删除的受检服务器/);
  const revision = f.service.state.revision;
  await f.service.tick();
  assert.equal(f.service.state.revision, revision);
  if (enabled) {
    f.setRound([-1, -1, -1, 1, 1]); await f.service.tick();
    assert.equal(f.service.state.monitors.a.failureStreak, 1);
  } else assert.ok(f.tasks.slice(1).every(t => !t.clients.length && !t.default_on));
  await f.service.saveConfig(f.service.state.config, revision);
  assert.equal(f.service.settings().selectionNotice, "");
  assert.deepEqual(validateConfig(f.saved().config), f.saved().config);
});

for (const observers of [["observer"], ["b", "observer"], ["a", "observer"]]) test(`deleted strict observer disables only strict mode (${observers.join(",")})`, async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true, strict: true, observers, reverse: { a: { port: 443, host: "" } }, failureThreshold: 1, recoveryThreshold: 1 }, 0);
  const forwardIds = Object.entries(f.service.state.tasks).filter(([key]) => key.startsWith("forward:")).map(([, id]) => id);
  const oldReverse = f.service.state.tasks["reverse:a"];
  f.service.state.monitors.a.alarm = true;
  f.service.state.events.push(pending("a", f.now()));
  f.removeClient("observer");
  await f.service.tick();
  assert.equal(f.service.lastError, "");
  assert.equal(f.service.state.config.strict, false);
  assert.equal(f.service.state.config.enabled, true);
  assert.deepEqual(f.service.state.config.observers, observers.filter(id => id !== "observer"));
  assert.equal(f.service.state.monitors.a.alarm, true);
  assert.equal(f.service.state.events[0].delivery, "superseded");
  assert.deepEqual(Object.values(f.service.state.tasks), forwardIds);
  assert.ok(!f.tasks.some(t => t.id === oldReverse));
  assert.ok(f.service.visibility.has(oldReverse));
  assert.match(f.service.settings().selectionNotice, /严格模式已自动关闭，继续普通模式监测/);
  f.setRound([1, 1, 1, 1, 1]); await f.service.tick();
  assert.equal(f.service.state.monitors.a.alarm, false);
  assert.equal(f.service.state.events.at(-1)?.type, "recovered");
  assert.equal(f.calls.filter(c => c.method === "admin:sendNotification").length, 1);
  const restored = new Service(structuredClone(f.saved()), f.rpc, { save() {} }, f.now);
  await restored.tick();
  assert.equal(restored.state.config.strict, false);
  assert.equal(restored.state.config.enabled, true);
  assert.equal(restored.state.events.filter(e => e.type === "recovered").length, 1);
  assert.match(restored.snapshot().selectionNotice, /继续普通模式监测/);
  assert.deepEqual(validateConfig(restored.state.config), restored.state.config);
});

test("deleting the final monitored server pauses tasks and never sends recovery", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true, strict: true, observers: ["observer"], reverse: { a: { port: 443, host: "" } } }, 0);
  f.service.state.monitors.a.alarm = true;
  f.service.state.events.push(pending("a", f.now()));
  f.removeClient("a"); await f.service.tick();
  assert.equal(f.service.state.config.enabled, false);
  assert.deepEqual(f.service.state.config.clients, []);
  assert.deepEqual(f.service.state.config.reverse, {});
  assert.deepEqual(f.service.state.monitors, {});
  assert.ok(f.tasks.slice(1).every(t => !t.clients.length && !t.default_on));
  assert.ok(!f.tasks.some(t => t.name.endsWith(":reverse:a]")));
  assert.equal(f.service.state.events[0].delivery, "superseded");
  assert.equal(f.calls.filter(c => c.method === "admin:sendNotification").length, 0);
  assert.match(f.service.settings().selectionNotice, /监测已自动关闭/);
  await f.service.saveConfig(f.service.state.config, f.service.state.revision);
  assert.deepEqual(validateConfig(f.saved().config), f.saved().config);
});

test("observer deletion while paused never enables monitoring and a replacement is not auto-selected", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true, strict: true, observers: ["observer"], reverse: { a: { port: 443, host: "" } } }, 0);
  await f.service.saveConfig({ ...f.service.state.config, enabled: false }, f.service.state.revision);
  const oldId = f.service.state.tasks["reverse:a"];
  f.setClients([{ uuid: "a" }, { uuid: "replacement-probe" }]);
  await f.service.tick();
  assert.equal(f.service.state.config.enabled, false);
  assert.equal(f.service.state.config.strict, false);
  assert.deepEqual(f.service.state.config.observers, []);
  assert.deepEqual(f.service.state.config.clients, ["a"]);
  assert.ok(!f.tasks.some(t => t.id === oldId));
  assert.ok(f.tasks.slice(1).every(t => !t.clients.length));
});

test("upgrade with stale persisted selections repairs on first tick", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a", "b"], enabled: true, strict: true, observers: ["b", "observer"], reverse: { a: { port: 443, host: "" }, b: { port: 80, host: "" } } }, 0);
  const oldState = structuredClone(f.saved());
  delete oldState.selectionNotice;
  f.removeClient("b");
  const upgraded = new Service(oldState, f.rpc, { save() {} }, f.now);
  await upgraded.tick();
  assert.equal(upgraded.lastError, "");
  assert.equal(upgraded.state.config.strict, false);
  assert.equal(upgraded.state.config.enabled, true);
  assert.deepEqual(upgraded.state.config.clients, ["a"]);
  assert.deepEqual(upgraded.state.config.observers, ["observer"]);
  assert.ok(!f.tasks.some(t => t.name.includes(":reverse:")));
  await upgraded.saveConfig(upgraded.state.config, upgraded.state.revision);
  assert.equal(upgraded.lastError, "");
});

test("saving a form opened before deletion prunes IDs before port validation and keeps edits", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a", "b"], enabled: true, strict: true, observers: ["observer"], reverse: { a: { port: 443, host: "" }, b: { port: 80, host: "" } } }, 0);
  const form = structuredClone(f.service.settings());
  delete form.config.reverse.b;
  form.config.maskIp = false;
  f.removeClient("b"); f.removeClient("observer");
  await f.service.saveConfig(form.config, form.revision);
  assert.equal(f.service.state.config.maskIp, false);
  assert.equal(f.service.state.config.enabled, true);
  assert.equal(f.service.state.config.strict, false);
  assert.deepEqual(f.service.state.config.clients, ["a"]);
  assert.deepEqual(f.service.state.config.observers, []);
  assert.deepEqual(Object.keys(f.service.state.config.reverse), ["a"]);
  assert.equal(f.service.lastError, "");
  assert.match(f.service.settings().selectionNotice, /严格模式已自动关闭/);
});

test("automatic pruning invalidates old forms without losing concurrent user configuration", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a", "b"], enabled: true }, 0);
  const form = structuredClone(f.service.settings());
  f.removeClient("b"); await f.service.refreshClients();
  assert.deepEqual(f.service.settings().config.clients, ["a"]);
  await assert.rejects(() => f.service.saveConfig(form.config, form.revision), /配置或服务器列表已变化/);
  assert.deepEqual(f.service.state.config.clients, ["a"]);
});

for (const response of [undefined, {}, { data: [] }, [null], [{}], [{ uuid: "a" }, { uuid: 1 }], [{ uuid: "a" }, { uuid: "a" }], [{ uuid: "invalid/uuid" }]]) test(`invalid client list cannot prune selections (${JSON.stringify(response)})`, async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true }, 0);
  const before = structuredClone(f.service.state.config), tasks = structuredClone(f.tasks), revision = f.service.state.revision;
  f.setClients(response); await f.service.tick();
  assert.match(f.service.lastError, /服务器列表失败/);
  assert.deepEqual(f.service.state.config, before);
  assert.equal(f.service.state.revision, revision);
  assert.deepEqual(f.tasks, tasks);
  assert.equal(f.service.settings().selectionNotice, "");
});

test("list RPC failure and offline clients are not deletion evidence", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true }, 0);
  f.setClients([{ uuid: "a", name: "Offline", online: false }]);
  await f.service.tick();
  assert.deepEqual(f.service.state.config.clients, ["a"]);
  const before = structuredClone(f.service.state.config);
  f.failClients(); await f.service.tick();
  assert.deepEqual(f.service.state.config, before);
  assert.equal(f.service.state.config.enabled, true);
  assert.doesNotMatch(JSON.stringify(f.service.snapshot()), /SECRET_CLIENT_RPC_ERROR/);
});

for (const response of [[], null]) test(`confirmed empty list clears deleted selections (${JSON.stringify(response)})`, async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true, strict: true, observers: ["observer"], reverse: { a: { port: 443, host: "" } } }, 0);
  f.setClients(response); await f.service.tick();
  assert.equal(f.service.lastError, "");
  assert.deepEqual(f.service.state.config.clients, []);
  assert.deepEqual(f.service.state.config.observers, []);
  assert.equal(f.service.state.config.enabled, false);
  assert.equal(f.service.state.config.strict, false);
  assert.deepEqual(validateConfig(f.saved().config), f.saved().config);
});
test("end-to-end service detects one event, persists before sending and redacts", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true }, 0);
  for (let i = 0; i < 3; i++) { f.setRound([-1, -1, -1, 1, 1]); await f.service.tick(); }
  await f.service.tick();
  const messages = f.calls.filter(c => c.method === "admin:sendNotification");
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].params.event.clients, []);
  assert.ok(!JSON.stringify(messages).includes("203.0.113.20"));
  assert.equal(f.saved().events[0].delivery, "sent");
  assert.equal(f.service.snapshot().rows[0].alarm, true);
});
test("strict mainland-to-server samples belong to the monitored server, not the observer", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true, strict: true, observers: ["observer"], reverse: { a: { port: 443, host: "" } }, failureThreshold: 1, recoveryThreshold: 1 }, 0);
  f.setRound([-1, -1, -1, 1, 1], { a: 10 }); await f.service.tick(); assert.equal(f.service.state.events.length, 0);
  f.setRound([-1, -1, -1, 1, 1], { a: -1 }); await f.service.tick(); assert.equal(f.service.state.events[0].type, "blocked");
  f.setRound([1, 1, 1, 1, 1], { a: 1 }); await f.service.tick(); assert.equal(f.service.state.events[1].type, "recovered");
});
test("aggregated metrics cannot trigger or clear an alarm", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true, failureThreshold: 1 }, 0);
  f.setRound([-1, -1, -1, 1, 1]); f.metrics()[0].downsampled = true;
  await f.service.tick(); assert.equal(f.service.state.events.length, 0); assert.ok(f.service.lastError);
});
test("notifications stop retrying after five attempts, no sensitive error escapes", async () => {
  const f = fixture(); f.fail();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true, failureThreshold: 1 }, 0);
  f.setRound([-1, -1, -1, 1, 1]); await f.service.tick();
  for (let i = 0; i < 8; i++) { f.advance(1800000); await f.service.deliver(); }
  assert.equal(f.calls.filter(c => c.method === "admin:sendNotification").length, 5);
  assert.equal(f.service.state.events[0].delivery, "failed");
  assert.ok(!JSON.stringify(f.service.snapshot()).includes("SECRET_CHANNEL"));
});

test("test notification uses the plugin display name without client information", async () => {
  const f = fixture();
  await f.service.testNotification();
  const messages = f.calls.filter(c => c.method === "admin:sendNotification");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].params.event.event, "被墙检测测试通知");
  assert.deepEqual(messages[0].params.event.clients, []);
  assert.match(messages[0].params.event.message, /^被墙检测通知通道测试/);
  assert.doesNotMatch(messages[0].params.event.message, /203\.0\.|GFW/);
});

test("renamed user tasks are not reclaimed or deleted", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true }, 0);
  f.tasks[1].name = "User took ownership";
  await f.service.reconcile();
  assert.equal(f.tasks.length, 7);
  await f.service.saveConfig({ ...f.service.state.config, enabled: false }, 1);
  await f.service.cleanup();
  assert.deepEqual(f.tasks.map(t => t.name), ["User-owned", "User took ownership"]);
});

test("persisted final in-flight notification is not retried after restart", async () => {
  const f = fixture(); f.fail();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true, failureThreshold: 1 }, 0);
  f.setRound([-1, -1, -1, 1, 1]); await f.service.tick();
  const restored = f.saved();
  restored.events[0].attempts = 5;
  restored.events[0].delivery = "pending";
  f.service.state = restored;
  f.advance(1800000);
  const before = f.calls.filter(c => c.method === "admin:sendNotification").length;
  await f.service.deliver();
  assert.equal(f.calls.filter(c => c.method === "admin:sendNotification").length, before);
  assert.equal(f.saved().events[0].delivery, "failed");
});

test("source signature changes reset confirmation and cancel stale pending notices", async () => {
  const f = fixture(); f.fail();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a"], enabled: true, failureThreshold: 1 }, 0);
  f.setRound([-1, -1, -1, 1, 1]); await f.service.tick();
  assert.equal(f.service.state.events[0].delivery, "pending");
  f.service.state.sources = {};
  await f.service.reconcile();
  assert.equal(f.service.state.events[0].delivery, "superseded");
  assert.equal(f.service.state.monitors.a.alarm, true);
  assert.equal(f.service.state.monitors.a.failureStreak, 0);
});
