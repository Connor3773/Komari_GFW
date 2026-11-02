import test from "node:test";
import assert from "node:assert/strict";
import { initialState, notificationReadiness, Service } from "../src/service.ts";
import type { MetricSeries, PingTask, Rpc, State } from "../src/types.ts";

function fixture() {
  let now = Date.parse("2026-01-01T00:00:00Z"), id = 0;
  const tasks: PingTask[] = [{ id: 999, name: "User-owned", target: "example.com:80", type: "tcp", interval: 60, clients: ["a"], default_on: true }];
  const calls: { method: string; params: any }[] = [];
  let metrics: MetricSeries[] = [];
  let saved: State;
  let failNotifications = false;
  const rpc = { async call(method: string, params: any) {
    calls.push({ method, params });
    if (method === "admin:listClients") return ["a", "b", "observer"].map(uuid => ({ uuid, name: uuid, ipv4: "203.0.113.20", group: "test", token: "MUST_NOT_ESCAPE" }));
    if (method === "admin:getSettings") return { notification_enabled: true, notification_method: "test", notification_template: "{{message}}" };
    if (method === "admin:getAllPingTasks") return structuredClone(tasks);
    if (method === "admin:addPingTask") { const task = { ...params, id: ++id }; tasks.push(task); return { task_id: task.id }; }
    if (method === "admin:editPingTask") { for (const task of params.tasks) Object.assign(tasks.find(t => t.id === task.id)!, task); return null; }
    if (method === "admin:deletePingTask") { for (let i = tasks.length - 1; i >= 0; i--) if (params.id.includes(tasks[i].id)) tasks.splice(i, 1); return null; }
    if (method === "public:queryMetrics") { assert.ok(params.max_points > 0); assert.equal(params.fill_empty, false); return { series: metrics }; }
    if (method === "admin:sendNotification") { if (failNotifications) throw new Error("SECRET_CHANNEL_URL"); return null; }
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
  return { service, tasks, calls, setRound, saved: () => saved!, metrics: () => metrics, fail: () => { failNotifications = true; }, now: () => now, advance: (ms: number) => { now += ms; } };
}

test("notification preflight catches silent disabled/no-channel/no-message cases", () => {
  assert.equal(notificationReadiness({}).ready, false);
  assert.equal(notificationReadiness({ notification_enabled: true, notification_method: "none" }).ready, false);
  assert.equal(notificationReadiness({ notification_enabled: true, notification_method: "test", notification_template: "{{event}}" }).ready, false);
  assert.equal(notificationReadiness({ notification_enabled: true, notification_method: "test", notification_template: "{{message}}" }).ready, true);
});
test("disabled initial load creates no tasks and exposes no tokens", async () => {
  const f = fixture(); await f.service.tick();
  assert.equal(f.tasks.length, 1);
  assert.ok(!JSON.stringify(f.service.settings()).includes("MUST_NOT_ESCAPE"));
});
test("create 5 forward tasks once, pause and cleanup only owned tasks", async () => {
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
test("strict creates a reverse task per selected server, excludes self", async () => {
  const f = fixture();
  await f.service.saveConfig({ ...f.service.state.config, clients: ["a", "b"], enabled: true, strict: true, observers: ["a", "observer"], reverse: { a: { port: 443, host: "" }, b: { port: 8443, host: "probe.example.com" } } }, 0);
  const a = f.tasks.find(t => t.name.endsWith(":reverse:a]"))!;
  const b = f.tasks.find(t => t.name.endsWith(":reverse:b]"))!;
  assert.equal(a.target, "203.0.113.20:443"); assert.deepEqual(a.clients, ["observer"]);
  assert.equal(b.target, "probe.example.com:8443"); assert.deepEqual(b.clients, ["a", "observer"]);
});
test("conflicting revisions cannot overwrite configuration", async () => {
  const f = fixture(); await assert.rejects(() => f.service.saveConfig(f.service.state.config, 9), /其它页面/);
  assert.equal(f.service.state.revision, 0);
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
test("strict reverse samples belong to the monitored server, not the observer", async () => {
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
