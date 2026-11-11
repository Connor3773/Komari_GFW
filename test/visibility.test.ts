import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { initialState } from "../src/service.ts";
import { filterResult, PingResponseFilter, PREFIX, TaskVisibility, type HookRequest, type HookResponse } from "../src/visibility.ts";

const instance = "00112233445566778899aabb";
const own = { id: 1, name: `${PREFIX}${instance}:forward:cn1]` };
const user = { id: 9, name: "User task" };
const row = (task_id: number, value = 10, n = 0, client = "a") => ({ task_id, value, client, time: new Date(1700000000000 + n * 1000).toISOString() });
const result = (records = [row(1, -1), row(9)], tasks = [own, user]) => ({ records, count: records.length, tasks, basic_info: [{ client: "a", loss: 50, min: 10, max: 10 }] });
const request = (method: string, params: unknown = {}, id: unknown = 1) => ({ jsonrpc: "2.0", method, params, id });

function fixture() {
  const state = initialState(instance);
  state.tasks = { "forward:cn1": 1 };
  const visibility = new TaskVisibility(state);
  const hooks = new Map<string, (...args: any[]) => any>();
  let now = 1000000;
  const filter = new PingResponseFilter(visibility, "test-random-nonce", () => now);
  filter.register({ hook(kind, matcher, callback) { hooks.set(`${kind} ${matcher}`, callback); } });
  const run = (kind: string, matcher: string, ...args: any[]) => hooks.get(`${kind} ${matcher}`)?.(...args);
  function prepare(body: unknown) {
    const req: HookRequest = { url: "/api/rpc2", method: "POST", headers: {}, body: JSON.stringify(body) };
    run("request", "POST /api/rpc2", req);
    return { req, data: JSON.parse(req.body) };
  }
  function finish(req: HookRequest, data: unknown) {
    const res: HookResponse = { statusCode: 200, headers: { etag: "old", "content-length": "123" }, body: JSON.stringify(data) };
    run("response", "POST /api/rpc2", { ...req, body: "" }, res);
    return { res, data: JSON.parse(res.body) };
  }
  function rpc(method: string, value: unknown, params: unknown = {}) {
    const { req, data } = prepare(request(method, params));
    return finish(req, { jsonrpc: "2.0", id: data.id, result: value }).data;
  }
  return { state, visibility, hooks, run, prepare, finish, rpc, advance() { now += 121000; } };
}

test("hooks are limited to Ping reads and RPC transports, never Agent or admin writes", () => {
  const f = fixture();
  assert.equal(f.hooks.size, 9);
  for (const key of f.hooks.keys()) assert.match(key, /(?:GET \/api\/(?:task|records)\/ping|response GET \/api\/admin\/ping\/\*|POST \/api\/rpc2|ws(?:Message|Send|Close) \/api\/rpc2)$/);
});

test("ownership needs exact instance marker; prefix lookalikes and foreign instances remain", () => {
  const f = fixture();
  const users = [user, { id: 2, name: `${PREFIX}another-instance:forward:cn1]` }, { id: 3, name: `${PREFIX}${instance}:forward:cn1] copy` }, { id: 4, name: `${PREFIX} manual` }];
  assert.deepEqual(filterResult([own, ...users], { kind: "tasks" }, f.visibility), users);
  assert.deepEqual(filterResult(null, { kind: "tasks" }, f.visibility), null);
});

test("same-instance legacy tasks are discovered, retired IDs survive reload, renamed/reused IDs are revoked", () => {
  const f = fixture();
  const legacy = { id: 17, name: `${PREFIX}${instance}:reverse:old-server]` };
  f.visibility.observe([legacy]);
  assert.ok(f.visibility.has(17));
  const restored = new TaskVisibility(structuredClone(f.state));
  restored.observe([]);
  assert.ok(restored.has(17));
  restored.observe([{ id: 17, name: "User repurposed task" }]);
  assert.ok(!restored.has(17));
  assert.ok(restored.has(1));
});

test("REST removes internal tasks for anonymous and logged-in visitors without changing user entries", () => {
  const f = fixture();
  const res = { statusCode: 200, headers: {}, body: JSON.stringify({ status: "success", message: "", data: [own, user] }) };
  f.run("response", "GET /api/task/ping", {}, res);
  assert.deepEqual(JSON.parse(res.body), { status: "success", message: "", data: [user] });
  assert.equal((res.headers as any)["cache-control"], "no-store");
});

test("admin REST list with slash and query hides current and legacy owned tasks, preserving user fields", () => {
  const f = fixture();
  const legacy = { id: 17, name: `${PREFIX}${instance}:reverse:old-server]`, clients: ["a"], target: "example.com:80" };
  const ordinary = { ...user, clients: ["a"], default_on: true, target: "example.org:443", type: "tcp", interval: 60, weight: 2 };
  for (const url of ["/api/admin/ping", "/api/admin/ping/", "/api/admin/ping?x=1", "/api/admin/ping/?x=1"]) {
    const data = { status: "success", message: "", data: [own, legacy, ordinary] };
    const res = { statusCode: 200, headers: { etag: "old" }, body: JSON.stringify(data) };
    f.run("response", "GET /api/admin/ping/*", { url }, res);
    assert.deepEqual(JSON.parse(res.body), { ...data, data: [ordinary] });
    assert.equal((res.headers as any)["cache-control"], "no-store");
    assert.equal((res.headers as any).etag, undefined);
  }
  assert.ok(f.visibility.has(17));
});

test("admin subtree hook ignores other paths without parsing their response", () => {
  const f = fixture();
  for (const url of ["/api/admin/ping/add", "/api/admin/ping/delete", "/api/admin/ping/edit", "/api/admin/ping/order", "/api/admin/ping/future", "/api/admin/ping-extra"]) {
    const res = { statusCode: 200, headers: { etag: "unchanged" }, body: "not-json" };
    const before = structuredClone(res);
    f.run("response", "GET /api/admin/ping/*", { url }, res);
    assert.deepEqual(res, before);
  }
  assert.equal(f.visibility.lastError, "");
});

test("admin REST keeps errors and native empty responses, rejects unknown list wrappers", () => {
  const f = fixture();
  for (const body of [{ status: "success", data: [] }, { status: "success", data: null }, { status: "success" }, { status: "error", message: "denied" }]) {
    const res = { statusCode: 200, headers: {}, body: JSON.stringify(body) };
    f.run("response", "GET /api/admin/ping/*", { url: "/api/admin/ping/" }, res);
    assert.deepEqual(JSON.parse(res.body), body);
  }
  const denied = { statusCode: 403, headers: {}, body: '{"status":"error","message":"denied"}' };
  f.run("response", "GET /api/admin/ping/*", { url: "/api/admin/ping/" }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body, '{"status":"error","message":"denied"}');
  const paged = { statusCode: 200, headers: {}, body: JSON.stringify({ status: "success", data: { tasks: [own, user], total: 2 } }) };
  f.run("response", "GET /api/admin/ping/*", { url: "/api/admin/ping/" }, paged);
  assert.equal(paged.statusCode, 502);
  assert.ok(!paged.body.includes(own.name));
});

test("admin task RPC hides owned tasks without changing its original input or user fields", () => {
  const f = fixture();
  const source = [own, { ...user, clients: ["a"], target: "example.org:443", default_on: false, weight: 0 }];
  assert.deepEqual(f.rpc("admin:getAllPingTasks", source).result, source.slice(1));
  assert.deepEqual(source[0], own);
  assert.equal(source.length, 2);
  assert.deepEqual(f.rpc("admin:getAllPingTasks", [own]).result, []);
  assert.equal(f.rpc("admin:getAllPingTasks", null).result, null);
});

test("REST records remove internal data and recompute count and unsampled client summary", () => {
  const f = fixture();
  const data = result([row(1, 9999), row(9, -1), row(9, 20), row(9, 40)]);
  const res = { statusCode: 200, headers: {}, body: JSON.stringify({ status: "success", data }) };
  f.run("response", "GET /api/records/ping", { headers: {} }, res);
  const visible = JSON.parse(res.body).data;
  assert.equal(visible.count, 3);
  assert.deepEqual(visible.records, data.records.slice(1));
  assert.deepEqual(visible.tasks, [user]);
  assert.deepEqual(visible.basic_info, [{ client: "a", loss: 1 / 3 * 100, min: 20, max: 40 }]);
});

for (const method of ["public:getPingRecords", "common:getRecords"]) test(`${method} filters before sampling and preserves full user task stats`, () => {
  const f = fixture();
  const common = method.startsWith("common");
  const originalUser = { ...user, total: 3, min: 10, max: 40, loss: 100 / 3, avg: 25 };
  const full = result([row(1, -1), row(9, 10, 1), row(9, -1, 2), row(9, 40, 3)], [own, originalUser]);
  const { req, data } = f.prepare(request(method, common ? { type: "ping", maxCount: 1 } : { uuid: "a", max_count: 1 }));
  assert.equal(data.params[common ? "maxCount" : "max_count"], common ? -1 : 0);
  const visible = f.finish(req, { jsonrpc: "2.0", id: data.id, result: full }).data.result;
  assert.equal(visible.count, 1);
  assert.deepEqual(visible.records, [full.records.at(-1)]);
  assert.deepEqual(visible.tasks, [originalUser]);
  assert.deepEqual(visible.basic_info, [{ client: "a", loss: 1 / 3 * 100, min: 10, max: 40 }]);
});

test("a direct hidden task query returns an empty result, never a fabricated ping value", () => {
  const f = fixture();
  const value = f.rpc("public:getPingRecords", result([row(1)], [own]), { task_id: "1" }).result;
  assert.deepEqual(value, { records: [], count: 0, tasks: [] });
});

test("metrics remove whole internal series, point-tag records and empty internal series, retaining CPU", () => {
  const f = fixture();
  const metric = (task: string, points: any[] | null = []) => ({ metric_key: "ping.latency_ms", tags: { task_id: task }, points, count: points?.length ?? 0, downsampled: false });
  const cpu = { ...metric("1", [{ value: 70 }]), metric_key: "cpu.usage" };
  const visible = metric("9", [{ value: 10 }]);
  const mixed = { metric_key: "ping.loss", points: [{ value: 1, tags: { task_id: "1" } }, { value: 0, tags: { task_id: "9" } }], count: 2 };
  const series = [metric("1", [{ value: 10 }]), metric("1", null), visible, cpu, mixed];
  const data = f.rpc("public:queryMetrics", { series, count: 5, default_points: 500 }, { metric_keys: ["ping.latency_ms", "ping.loss", "cpu.usage"] }).result;
  assert.equal(data.count, 3);
  assert.deepEqual(data.series, [visible, cpu, { ...mixed, count: 1, points: mixed.points.slice(1) }]);
});

test("metric stats remove the plugin task, preserving all user statistics exactly", () => {
  const f = fixture();
  const ordinary = { task_id: "9", name: "User task", total: 100, valid: 90, loss: 10, p99: 25 };
  const stats = [{ task_id: "1", name: own.name, total: 20 }, ordinary];
  assert.deepEqual(f.rpc("public:getPingMetricStats", { stats, count: 2, start: "s", end: "e" }).result, { stats: [ordinary], count: 1, start: "s", end: "e" });
});

test("latest-status single and map responses strip only internal ping keys", () => {
  const f = fixture();
  const node = { client: "a", cpu: 42, ping: { "1": { loss: 100 }, "9": { loss: 0 } } };
  const expected = { ...node, ping: { "9": { loss: 0 } } };
  assert.deepEqual(f.rpc("common:getNodesLatestStatus", node).result, expected);
  assert.deepEqual(f.rpc("common:getNodesLatestStatus", { a: node }).result, { a: expected });
});

test("mixed batches, reordered responses and duplicate original IDs cannot misidentify methods", () => {
  const f = fixture();
  const { req, data } = f.prepare([request("public:getPublicPingTasks", {}, "same"), request("admin:getAllPingTasks", {}, "same"), request("public:getPingRecords", { uuid: "a" }, null), request("admin:listClients", {}, "same")]);
  const response = f.finish(req, [
    { jsonrpc: "2.0", id: data[2].id, result: result() },
    { jsonrpc: "2.0", id: data[1].id, result: [own, user] },
    { jsonrpc: "2.0", id: data[0].id, result: [own, user] },
    { jsonrpc: "2.0", id: data[3].id, result: [own, user] },
  ]).data;
  assert.deepEqual(response.map((r: any) => r.id), [null, "same", "same", "same"]);
  assert.deepEqual(response[1].result, [user]);
  assert.deepEqual(response[2].result, [user]);
  assert.deepEqual(response[3].result, [own, user]);
  assert.deepEqual(response[0].result.records, [row(9)]);
});

test("unrelated RPC and common load requests are byte-for-byte untouched", () => {
  const f = fixture();
  for (const method of ["admin:getAllPingTasksExtra", "admin:addPingTask", "admin:editPingTask", "admin:deletePingTask", "admin:orderPingTask", "admin:dbQuery", "public:getVersion", "public:queryMetricsExtra", "common:getRecords", "public:queryMetrics", "getRecords"]) {
    const body = JSON.stringify(request(method, { type: "load" }));
    const { req } = f.prepare(JSON.parse(body));
    assert.equal(req.body, body);
    assert.deepEqual(req.headers, {});
    const original = ' {"jsonrpc":"2.0", "id":1,"result":{"records":[],"count":0}} ';
    const res = { statusCode: 200, headers: {}, body: original };
    f.run("response", "POST /api/rpc2", req, res);
    assert.equal(res.body, original);
  }
});

test("case-insensitive JSON fields, positional params, scalar type and null limits match Go binding", () => {
  const f = fixture();
  for (const body of [
    { JSONRPC: "2.0", METHOD: "common:getRecords", PARAMS: { TYPE: "ping", MAXCOUNT: 2 }, ID: 0 },
    { jsonrpc: "2.0", method: "common:getRecords", "param\u017f": { type: "ping" }, id: 1 },
    request("common:getRecords", ["ping", "a", 1, null, null, "", 0, 2]),
    request("common:getRecords", "ping"),
    request("public:getPingRecords", ["a", "", "4", 2]),
    request("public:getPingRecords", { uuid: "a", max_count: null }),
  ]) {
    const { req, data } = f.prepare(body);
    const res = f.finish(req, { jsonrpc: "2.0", id: data.id, result: result() }).data;
    assert.deepEqual(res.result.records, [row(9)]);
    assert.equal(res.id, (body as any).ID ?? (body as any).id);
  }
});

test("metric field Unicode folding cannot bypass the Ping selector", () => {
  const f = fixture();
  const response = f.rpc("public:queryMetrics", { count: 1, series: [{ metric_key: "ping.loss", tags: { task_id: "1" }, points: [], count: 0 }] }, { "metric_\u212aeys": ["ping.loss"] });
  assert.deepEqual(response.result, { count: 0, series: [] });
});

test("case-alias null string fields preserve Go semantics instead of bypassing selection", () => {
  const f = fixture();
  const { req, data } = f.prepare({ jsonrpc: "2.0", JSONRPC: null, method: "common:getRecords", METHOD: null, params: { TYPE: "ping", type: null }, id: 3 });
  const response = f.finish(req, { jsonrpc: "2.0", id: data.id, result: result() }).data;
  assert.deepEqual(response.result.records, [row(9)]);
  assert.equal(response.id, 3);
});

test("ambiguous duplicate JSON keys, including escaped spellings, are rejected", () => {
  const f = fixture();
  for (const suffix of ['"method":null', '"meth\\u006fd":null']) {
    const req = { url: "/api/rpc2", method: "POST", headers: {}, body: `{"jsonrpc":"2.0","method":"public:getPublicPingTasks",${suffix},"id":1}` };
    assert.throws(() => f.run("request", "POST /api/rpc2", req), /duplicate JSON key/);
  }
});

test("JSON punctuation inside values and separate objects does not look like duplicate keys", () => {
  const f = fixture();
  const { req, data } = f.prepare([request("public:getPublicPingTasks", {}, '"{},[]:"'), request("public:getPublicPingTasks", {}, 2)]);
  const replies = data.map((q: any) => ({ jsonrpc: "2.0", id: q.id, result: [own, user] }));
  assert.deepEqual(f.finish(req, replies).data.map((r: any) => r.result), [[user], [user]]);
});

test("native RPC and REST errors are preserved, including their IDs", () => {
  const f = fixture();
  const { req, data } = f.prepare(request("public:getPingRecords", { uuid: "a" }, "error-id"));
  const error = { code: -32602, message: "Invalid request" };
  assert.deepEqual(f.finish(req, { jsonrpc: "2.0", id: data.id, error }).data, { jsonrpc: "2.0", id: "error-id", error });
  const res = { statusCode: 401, headers: {}, body: '{"status":"error","message":"login"}' };
  f.run("response", "GET /api/records/ping", { headers: {} }, res);
  assert.equal(res.body, '{"status":"error","message":"login"}');
});

test("unknown pagination/count shapes produce explicit errors, not leaked data or fabricated totals", () => {
  const f = fixture();
  for (const changed of [{ ...result(), total: 200 }, { ...result(), count: 50 }, { ...result(), next_cursor: "cursor" }]) {
    const res = f.rpc("public:getPingRecords", changed, { uuid: "a" });
    assert.equal(res.error.code, -32603);
    assert.equal(res.result, undefined);
  }
  assert.ok(f.visibility.lastError);
});

test("empty records/metrics/stats remain valid, including native nil slices", () => {
  const f = fixture();
  assert.deepEqual(f.rpc("public:getPingRecords", { records: [], count: 0 }, { uuid: "a" }).result, { records: [], count: 0 });
  assert.deepEqual(f.rpc("public:getPingMetricStats", { stats: [], count: 0 }).result, { stats: [], count: 0 });
  const series = { metric_key: "ping.latency_ms", points: null, count: 0 };
  assert.deepEqual(f.rpc("public:queryMetrics", { series: [series], count: 1 }, { metric_key: "ping.latency_ms" }).result, { series: [series], count: 1 });
});

test("malformed and uncorrelated responses cannot be misidentified as another RPC", () => {
  const f = fixture();
  for (const make of [(id: string) => ({ jsonrpc: "2.0", id, result: [own], error: { code: -32603 } }), () => ({ jsonrpc: "2.0", id: "unexpected", result: [own] })]) {
    const { req, data } = f.prepare(request("public:getPublicPingTasks"));
    const output = f.finish(req, make(data.id));
    assert.equal(output.res.statusCode, 502);
    assert.ok(!output.res.body.includes(own.name));
  }
  const res = { statusCode: 200, headers: {}, body: "not-json" };
  f.run("response", "GET /api/task/ping", {}, res);
  assert.equal(res.statusCode, 502);
  assert.match((res.headers as any)["content-type"], /application\/json/);
});

test("malformed requests and oversized batches retain native errors or fail explicitly", () => {
  const f = fixture();
  const req = { method: "POST", url: "/api/rpc2", headers: {}, body: "{" };
  f.run("request", "POST /api/rpc2", req);
  assert.equal(req.body, "{");
  assert.throws(() => f.prepare(Array.from({ length: 1001 }, (_, id) => request("public:getPublicPingTasks", {}, id))), /batch limit/);
  const ctx = { connId: 7 };
  const frame = JSON.stringify(Array.from({ length: 1001 }, (_, id) => request("public:getPublicPingTasks", {}, id)));
  assert.equal(f.run("wsMessage", "/api/rpc2", ctx, { data: frame }).data, "{");
  assert.ok(f.visibility.lastError);
});

test("forged correlation headers are erased and pending requests are bounded and expire", () => {
  const f = fixture();
  const req = { url: "/api/rpc2", method: "POST", body: JSON.stringify(request("admin:listClients")), headers: { "x-komari-gfw-filter": "fake" } };
  f.run("request", "POST /api/rpc2", req);
  assert.deepEqual(req.headers, {});
  const first = f.prepare(request("public:getPublicPingTasks"));
  for (let i = 1; i < 256; i++) f.prepare(request("public:getPublicPingTasks"));
  assert.throws(() => f.prepare(request("public:getPublicPingTasks")), /pending/);
  f.advance();
  f.prepare(request("public:getPublicPingTasks"));
  const stale = f.finish(first.req, { jsonrpc: "2.0", id: first.data.id, result: [own] });
  assert.equal(stale.res.statusCode, 502);
  assert.ok(!stale.res.body.includes(own.name));
});

test("WebSocket text/binary requests are correlated, filtered, restored and cleaned up", () => {
  const f = fixture();
  for (const method of ["public:getPublicPingTasks", "admin:getAllPingTasks"]) for (const binary of [false, true]) {
    const ctx = { connId: 5 };
    const text = JSON.stringify(request(method, {}, "id"));
    const incoming = f.run("wsMessage", "/api/rpc2", ctx, { data: binary ? Uint8Array.from(Buffer.from(text)).buffer : text });
    const wire = JSON.parse(incoming.data);
    const reply = JSON.stringify({ jsonrpc: "2.0", id: wire.id, result: [own, user] });
    const outgoing = f.run("wsSend", "/api/rpc2", ctx, { data: reply });
    assert.deepEqual(JSON.parse(outgoing.data), { jsonrpc: "2.0", id: "id", result: [user] });
    const stale = f.run("wsSend", "/api/rpc2", ctx, { data: reply });
    assert.match(JSON.parse(stale.data).error.message, /Uncorrelated RPC response/);
    assert.ok(!stale.data.includes(own.name));
    f.run("wsClose", "/api/rpc2", ctx);
  }
});

test("single-item batches and missing/null/number/string IDs round-trip", () => {
  const f = fixture();
  for (const originalId of [undefined, null, 0, 42, "42"]) {
    const body: any = request("public:getPublicPingTasks", {}, originalId);
    if (originalId === undefined) delete body.id;
    const { req, data } = f.prepare([body]);
    assert.equal(f.finish(req, { jsonrpc: "2.0", id: data[0].id, result: [own, user] }).data.id, originalId ?? null);
  }
});

test("REST JSON GET bodies cannot inject the filter header or hide the sample cap", () => {
  const f = fixture();
  const req = { body: '{"uuid":"a","max_count":1}', method: "GET", url: "/api/records/ping", headers: { "x-komari-gfw-filter": "forged" } };
  f.run("request", "GET /api/records/ping", req);
  assert.equal(JSON.parse(req.body).max_count, 0);
  const res = { statusCode: 200, headers: {}, body: JSON.stringify({ status: "success", data: result([row(1), row(9, 10), row(9, 20, 1)]) }) };
  f.run("response", "GET /api/records/ping", { ...req, body: "" }, res);
  assert.deepEqual(JSON.parse(res.body).data.records, [row(9, 20, 1)]);
});

test("current Komari task, record, metric, stat and latest shapes stay filtered", () => {
  const f = fixture();
  const owned = { ...own, clients: null, default_on: false, type: "icmp", target: "example.com", interval: 60, weight: 0 };
  const ordinary = { ...user, clients: null, default_on: true, type: "tcp", target: "example.org", interval: 60, weight: 1 };
  assert.deepEqual(f.rpc("admin:getAllPingTasks", [owned, ordinary]).result, [ordinary]);

  const records = {
    from: "2026-11-09T00:00:00Z",
    to: "2026-11-09T01:00:00Z",
    records: [row(1, 1.5), row(9, 2.25)],
    count: 2,
    tasks: [owned, ordinary],
  };
  const visibleRecords = f.rpc("common:getRecords", records, { type: "ping" }).result;
  assert.deepEqual(visibleRecords.records, [records.records[1]]);
  assert.equal(visibleRecords.count, 1);
  assert.equal(visibleRecords.from, records.from);
  assert.deepEqual(visibleRecords.tasks, [ordinary]);

  const point = (task: string, value: number | null, count?: number) => ({ time: "2026-11-09T00:00:00Z", value, ...(count === undefined ? {} : { count }), tags: { task_id: task } });
  const ping = {
    metric_key: "ping.latency_ms", entity_id: "node-a", type: "gauge", unit: "ms", retention_days: 30,
    tags: { task_id: "9" }, downsampled: true, downsample_algorithm: "avg", fill_empty: true,
    max_points: 500, interval_seconds: 60, count: 2, points: [point("9", 12.5, 4), point("9", null)],
  };
  const cpu = { metric_key: "cpu.usage", tags: {}, count: 1, points: [{ time: "2026-11-09T00:00:00Z", value: 1.5, count: 3 }] };
  const metrics = f.rpc("public:queryMetrics", {
    start: "2026-11-09T00:00:00Z", end: "2026-11-09T01:00:00Z", server_downsample_default: true, default_points: 500, series: [ping, cpu], count: 2,
  }, { metric_key: "ping.latency_ms" }).result;
  assert.equal(metrics.count, 2);
  assert.equal(metrics.server_downsample_default, true);
  assert.deepEqual(metrics.series[0].points, ping.points);
  assert.deepEqual(metrics.series[1], cpu);

  const userStat = { task_id: "9", entity_id: "a", name: "User task", total: 10, valid: 8, loss: 20, min: null, max: 30.5, avg: 12.25, latest: null, p50: 10, p99: 28 };
  const stats = f.rpc("public:getPingMetricStats", { start: "s", end: "e", interval_seconds: 60, stats: [{ ...userStat, task_id: "1", name: own.name }, userStat], count: 2 }).result;
  assert.deepEqual(stats, { start: "s", end: "e", interval_seconds: 60, stats: [userStat], count: 1 });

  const summary = { name: "user", latest: 2.5, avg: 2, tail: 3, loss: 0, min: 1, max: 4 };
  const node = { client: "a", time: "2026-11-09T00:00:00Z", cpu: 1, online: true, ping: { "1": { ...summary, name: own.name, loss: 100 }, "9": summary } };
  const bare = { client: "b", cpu: 0, time: "t", online: false };
  const latest = f.rpc("common:getNodesLatestStatus", { a: node, b: bare, c: null, d: { client: "d", ping: null } }).result;
  assert.deepEqual(latest, { a: { ...node, ping: { "9": summary } }, b: bare, c: null, d: { client: "d", ping: null } });
  assert.deepEqual(f.rpc("common:getNodesLatestStatus", bare).result, bare);
  assert.equal(f.visibility.lastError, "");
});

test("missing attribution, wrapper pagination and a non-object ping map still fail closed", () => {
  const f = fixture();
  const missing = f.rpc("public:getPingRecords", { records: [{ value: 1, client: "a", time: row(9).time, note: own.name }, row(9)], count: 2 }, { uuid: "a" });
  assert.equal(missing.result, undefined);
  assert.match(missing.error.message, /POST \/api\/rpc2 public:getPingRecords \/ Unsupported ping record/);
  assert.ok(!JSON.stringify(missing).includes(own.name));
  const paged = f.rpc("public:getPingMetricStats", { stats: [{ task_id: "9", total: 1 }], count: 1, total: 9 });
  assert.match(paged.error.message, /POST \/api\/rpc2 public:getPingMetricStats \/ Unsupported pagination/);
  const badPing = f.rpc("common:getNodesLatestStatus", { a: { client: "a", cpu: 1, ping: own.name } });
  assert.match(badPing.error.message, /Unsupported node ping summary/);
  assert.ok(!JSON.stringify(badPing).includes(own.name));
  const inherited = Object.assign(Object.create({ total: 99 }), { records: [row(9)], count: 1, tasks: [user] });
  const filtered = filterResult(inherited, { kind: "records" }, f.visibility) as { records: unknown };
  assert.deepEqual(filtered.records, [row(9)]);
});

test("only the same entry and method recovers its warning, retaining the last failure", () => {
  const f = fixture();
  const bad = f.rpc("public:getPingRecords", { ...result(), total: 2 }, { uuid: "a" });
  assert.match(bad.error.message, /POST \/api\/rpc2 public:getPingRecords \/ Unsupported pagination/);
  assert.match(f.visibility.lastError, /POST \/api\/rpc2 public:getPingRecords \/ Unsupported pagination/);
  const native = f.prepare(request("public:getPingRecords", { uuid: "a" }));
  f.finish(native.req, { jsonrpc: "2.0", id: native.data.id, error: { code: -32602, message: "Invalid request" } });
  const denied = { statusCode: 403, headers: {}, body: "{}" };
  f.run("response", "GET /api/task/ping", {}, denied);
  const restError = { statusCode: 200, headers: {}, body: JSON.stringify({ status: "error", message: "denied" }) };
  f.run("response", "GET /api/task/ping", {}, restError);
  assert.match(f.visibility.lastError, /Unsupported pagination/);
  const batch = f.prepare([request("public:getPublicPingTasks", {}, 1), request("public:getPingRecords", { uuid: "a" }, 2)]);
  const mixed = f.finish(batch.req, [
    { jsonrpc: "2.0", id: batch.data[0].id, result: [own, user] },
    { jsonrpc: "2.0", id: batch.data[1].id, result: { ...result(), total: 1 } },
  ]).data;
  assert.deepEqual(mixed[0].result, [user]);
  assert.match(mixed[1].error.message, /public:getPingRecords \/ Unsupported pagination/);
  assert.match(f.visibility.lastError, /public:getPingRecords \/ Unsupported pagination/);
  assert.deepEqual(f.rpc("public:getPublicPingTasks", [own, user]).result, [user]);
  assert.match(f.visibility.lastError, /public:getPingRecords/);
  const rest = { statusCode: 200, headers: {}, body: JSON.stringify({ status: "success", data: [own, user] }) };
  f.run("response", "GET /api/admin/ping/*", { url: "/api/admin/ping" }, rest);
  assert.deepEqual(JSON.parse(rest.body).data, [user]);
  assert.match(f.visibility.lastError, /public:getPingRecords/);
  f.rpc("public:getPingRecords", result(), { uuid: "a" });
  assert.equal(f.visibility.lastError, "");
  const [history] = f.visibility.diagnostics;
  assert.equal(history.entry, "POST /api/rpc2 public:getPingRecords");
  assert.equal(history.check, "Unsupported pagination");
  assert.equal(history.occurrences, 2);
  assert.equal(history.lastFailedAt, 1000000);
  assert.equal(history.recoveredAt, 1000000);
});

test("WebSocket heartbeats do not consume a filtered request or record a failure", () => {
  const f = fixture();
  f.visibility.warn("unrelated entry", "previous failure", 1000000);
  const ctx = { connId: 3 };
  const incoming = f.run("wsMessage", "/api/rpc2", ctx, { data: JSON.stringify(request("public:getPublicPingTasks", {}, "id")) });
  const wire = JSON.parse(incoming.data);
  assert.equal(f.run("wsMessage", "/api/rpc2", ctx, { data: JSON.stringify({ jsonrpc: "2.0", method: "rpc.ping", params: { timestamp: 1 } }) }), undefined);
  assert.equal(f.run("wsSend", "/api/rpc2", ctx, { data: '{"jsonrpc":"2.0","result":"pong"}\n' }), undefined);
  f.run("wsMessage", "/api/rpc2", ctx, { data: JSON.stringify(request("public:getVersion", {}, 7)) });
  assert.equal(f.run("wsSend", "/api/rpc2", ctx, { data: JSON.stringify({ jsonrpc: "2.0", id: 7, result: { version: "1.6.1" } }) }), undefined);
  assert.match(f.visibility.lastError, /unrelated entry/);
  const outgoing = f.run("wsSend", "/api/rpc2", ctx, { data: JSON.stringify({ jsonrpc: "2.0", id: wire.id, result: [own, user] }) });
  assert.deepEqual(JSON.parse(outgoing.data), { jsonrpc: "2.0", id: "id", result: [user] });
  assert.match(f.visibility.lastError, /unrelated entry/);
  f.visibility.clear("unrelated entry", 1000000);
  const lost = f.run("wsMessage", "/api/rpc2", ctx, { data: JSON.stringify(request("public:getPublicPingTasks", {}, "next")) });
  const forged = f.run("wsSend", "/api/rpc2", ctx, { data: JSON.stringify({ jsonrpc: "2.0", id: "km-filter-test-random-nonce-999", result: [own] }) });
  assert.match(JSON.parse(forged.data).error.message, /WS \/api\/rpc2 public:getPublicPingTasks \/ Uncorrelated RPC response/);
  assert.ok(!forged.data.includes(own.name));
  const real = f.run("wsSend", "/api/rpc2", ctx, { data: JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(lost.data).id, result: [own, user] }) });
  assert.deepEqual(JSON.parse(real.data).result, [user]);
  assert.equal(f.visibility.lastError, "");
});

test("REST, POST and WS failures recover independently and keep sanitized timestamps", () => {
  const f = fixture();
  const bad = () => ({ statusCode: 200, headers: {}, body: JSON.stringify({ status: "success", data: { ...result(), count: 99 } }) });
  const rest = bad();
  f.run("response", "GET /api/records/ping", { headers: {} }, rest);
  f.rpc("public:getPingRecords", { ...result(), count: 99 }, { uuid: "a" });
  const ctx = { connId: 1 };
  const ws = JSON.parse(f.run("wsMessage", "/api/rpc2", ctx, { data: JSON.stringify(request("public:getPingRecords", { uuid: "a" })) }).data);
  f.run("wsSend", "/api/rpc2", ctx, { data: JSON.stringify({ jsonrpc: "2.0", id: ws.id, result: { ...result(), count: 99 } }) });
  assert.equal(f.visibility.diagnostics.filter(d => d.recoveredAt === null).length, 3);
  f.rpc("public:getPingRecords", result(), { uuid: "a" });
  assert.equal(f.visibility.diagnostics.filter(d => d.recoveredAt === null).length, 2);
  assert.match(f.visibility.lastError, /GET \/api\/records\/ping/);
  assert.match(f.visibility.lastError, /WS \/api\/rpc2 public:getPingRecords/);
  const good = { statusCode: 200, headers: {}, body: JSON.stringify({ status: "success", data: result() }) };
  f.run("response", "GET /api/records/ping", { headers: {} }, good);
  assert.equal(f.visibility.diagnostics.filter(d => d.recoveredAt === null).length, 1);
  f.advance();
  const next = JSON.parse(f.run("wsMessage", "/api/rpc2", ctx, { data: JSON.stringify(request("public:getPingRecords", { uuid: "a" })) }).data);
  f.run("wsSend", "/api/rpc2", ctx, { data: JSON.stringify({ jsonrpc: "2.0", id: next.id, result: result() }) });
  assert.equal(f.visibility.lastError, "");
  assert.equal(f.visibility.diagnostics.find(d => d.entry.startsWith("WS"))?.recoveredAt, 1121000);
  assert.equal(f.visibility.diagnostics.length, 3);
});

for (const reverse of [false, true]) test(`one failed item prevents the same method succeeding in its batch from masking it (${reverse})`, () => {
  const f = fixture();
  const prepared = f.prepare([request("public:getPingRecords", { uuid: "a" }, 1), request("public:getPingRecords", { uuid: "b" }, 2)]);
  const replies = prepared.data.map((q: any, i: number) => ({ jsonrpc: "2.0", id: q.id, result: i ? result() : { ...result(), page: 1 } }));
  if (reverse) replies.reverse();
  f.finish(prepared.req, replies);
  assert.match(f.visibility.lastError, /Unsupported pagination/);
  assert.equal(f.visibility.diagnostics[0].recoveredAt, null);
});

test("parser failures never copy server content or credentials into diagnostics", () => {
  const f = fixture();
  const q = f.prepare(request("public:getPublicPingTasks"));
  const response = { statusCode: 200, headers: {}, body: 'SECRET_CHANNEL_AND_COOKIE invalid JSON' };
  f.run("response", "POST /api/rpc2", q.req, response);
  assert.equal(response.statusCode, 502);
  assert.ok(!JSON.stringify([response, f.visibility.diagnostics]).includes("SECRET_CHANNEL_AND_COOKIE"));
  assert.match(f.visibility.lastError, /POST \/api\/rpc2 public:getPublicPingTasks/);
});

test("null node entries, empty maps and missing ping summaries preserve their structure", () => {
  const f = fixture();
  const source = { offline: null, noPing: { client: "noPing", cpu: 0, online: false }, nilPing: { client: "nilPing", ping: null } };
  assert.deepEqual(f.rpc("common:getNodesLatestStatus", source).result, source);
  assert.deepEqual(f.rpc("common:getNodesLatestStatus", {}).result, {});
  const before = structuredClone(source);
  assert.deepEqual(f.rpc("common:getNodesLatestStatus", { ...source, online: { client: "online", ping: { "1": own, "9": user } } }).result,
    { ...source, online: { client: "online", ping: { "9": user } } });
  assert.deepEqual(source, before);
  assert.equal(f.visibility.lastError, "");
});

test("series.count counts points, not bucket sample count, and remains fail-closed on mismatch", () => {
  const f = fixture();
  const series = { metric_key: "ping.latency_ms", tags: { task_id: "9" }, downsampled: true,
    count: 2, points: [{ time: row(9).time, value: 2.5, count: 700 }, { time: row(9).time, value: null }] };
  const params = { metric_key: "ping.latency_ms" };
  assert.deepEqual(f.rpc("public:queryMetrics", { count: 1, series: [series] }, params).result.series, [series]);
  const bad = f.rpc("public:queryMetrics", { count: 1, series: [{ ...series, count: 700 }] }, params);
  assert.equal(bad.result, undefined);
  assert.match(bad.error.message, /Unsupported points count\/pagination/);
  f.rpc("public:getPublicPingTasks", [own, user]);
  assert.match(f.visibility.lastError, /public:queryMetrics/);
  assert.deepEqual(f.rpc("public:queryMetrics", { count: 1, series: [{ ...series, count: 0, points: null }] }, params).result.series[0].points, null);
  assert.equal(f.visibility.lastError, "");
});

for (const frameType of [8, 9, 10]) test(`WS control frame ${frameType} is byte-for-byte untouched and preserves the pending filter`, () => {
  const f = fixture(), ctx = { connId: 8 };
  const incoming = f.run("wsMessage", "/api/rpc2", ctx, { type: 1, data: JSON.stringify(request("public:getPublicPingTasks")) });
  const frame = { type: frameType, data: "non-JSON control data" }, before = structuredClone(frame);
  assert.equal(f.run("wsMessage", "/api/rpc2", ctx, frame), undefined);
  assert.equal(f.run("wsSend", "/api/rpc2", ctx, frame), undefined);
  assert.deepEqual(frame, before);
  assert.equal(f.visibility.lastError, "");
  const wire = JSON.parse(incoming.data);
  const reply = f.run("wsSend", "/api/rpc2", ctx, { type: 1, data: JSON.stringify({ jsonrpc: "2.0", id: wire.id, result: [own, user] }) });
  assert.deepEqual(JSON.parse(reply.data).result, [user]);
});

test("WS malformed, unsolicited and ambiguous frames fail closed without losing the real pending request", () => {
  const f = fixture(), ctx = { connId: 8 };
  const incoming = f.run("wsMessage", "/api/rpc2", ctx, { data: JSON.stringify(request("public:getPublicPingTasks")) });
  for (const data of ['not-json', JSON.stringify({ jsonrpc: "2.0", id: "wrong-id", result: [own] }), JSON.stringify({ jsonrpc: "2.0", id: "wrong-id", error: {}, result: [own] })]) {
    const reply = f.run("wsSend", "/api/rpc2", ctx, { data });
    assert.ok(JSON.parse(reply.data).error);
    assert.ok(!reply.data.includes(own.name));
  }
  const reply = f.run("wsSend", "/api/rpc2", ctx, { data: JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(incoming.data).id, result: [own, user] }) });
  assert.deepEqual(JSON.parse(reply.data).result, [user]);
  assert.equal(f.visibility.lastError, "");
  assert.ok(f.visibility.diagnostics[0].occurrences >= 3);
});

test("escaped orphan wire IDs cannot bypass the WS fallback filter", () => {
  const f = fixture();
  const reply = JSON.stringify({ jsonrpc: "2.0", id: "km-filter-test-random-nonce-987", result: [own] }).replace("km-filter", "\\u006bm-filter");
  const filtered = f.run("wsSend", "/api/rpc2", { connId: 77 }, { data: reply });
  assert.match(JSON.parse(filtered.data).error.message, /Uncorrelated RPC response/);
  assert.ok(!filtered.data.includes(own.name));
});

test("an overlapping WS Ping request never replaces a still-protected request", () => {
  const f = fixture(), ctx = { connId: 8 };
  const first = f.run("wsMessage", "/api/rpc2", ctx, { data: JSON.stringify(request("public:getPublicPingTasks")) });
  const rejected = f.run("wsMessage", "/api/rpc2", ctx, { data: JSON.stringify(request("public:getPingRecords")) });
  assert.equal(rejected.data, "{");
  assert.match(f.visibility.lastError, /Overlapping Ping request/);
  const nativeError = { data: JSON.stringify({ jsonrpc: "2.0", error: { code: -32600 }, id: null }) };
  assert.equal(f.run("wsSend", "/api/rpc2", ctx, nativeError), undefined);
  const reply = f.run("wsSend", "/api/rpc2", ctx, { data: JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(first.data).id, result: [own, user] }) });
  assert.deepEqual(JSON.parse(reply.data).result, [user]);
});

test("WS pending capacity, expiry, late responses and close cleanup remain fail-closed", () => {
  const f = fixture();
  const requestFrame = () => ({ data: JSON.stringify(request("public:getPublicPingTasks")) });
  const first = f.run("wsMessage", "/api/rpc2", { connId: 0 }, requestFrame());
  for (let i = 1; i < 256; i++) f.run("wsMessage", "/api/rpc2", { connId: i }, requestFrame());
  assert.equal(f.run("wsMessage", "/api/rpc2", { connId: 256 }, requestFrame()).data, "{");
  assert.match(f.visibility.lastError, /WS \/api\/rpc2 request \/ Too many pending connections/);
  f.run("wsClose", "/api/rpc2", { connId: 1 });
  assert.ok(JSON.parse(f.run("wsMessage", "/api/rpc2", { connId: 256 }, requestFrame()).data).id);
  f.advance();
  assert.ok(JSON.parse(f.run("wsMessage", "/api/rpc2", { connId: 257 }, requestFrame()).data).id);
  const late = f.run("wsSend", "/api/rpc2", { connId: 0 }, { data: JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(first.data).id, result: [own] }) });
  assert.ok(JSON.parse(late.data).error);
  assert.ok(!late.data.includes(own.name));
});

for (const mode of ["empty", "partial", "duplicate", "ambiguous"] as const) test(`RPC ${mode} response cannot recover a warning or return unfiltered data`, () => {
  const f = fixture();
  const prepared = f.prepare([request("public:getPublicPingTasks", {}, 1), request("public:getPublicPingTasks", {}, 2)]);
  const first = { jsonrpc: "2.0", id: prepared.data[0].id, result: [own, user] };
  const replies = mode === "empty" ? [] : mode === "partial" ? [first] : mode === "duplicate" ? [first, { ...first }] : [first, { jsonrpc: "2.0", id: "unknown", error: {}, result: [own] }];
  const response = f.finish(prepared.req, replies);
  assert.equal(response.res.statusCode, 502);
  assert.ok(!response.res.body.includes(own.name));
  assert.ok(f.visibility.lastError);
});

test("unrelated WS IDs are byte-bounded and cannot exhaust or replace the pending filter", () => {
  const f = fixture(), ctx = { connId: 8 };
  const first = f.run("wsMessage", "/api/rpc2", ctx, { data: JSON.stringify(request("public:getPublicPingTasks")) });
  const oversized = f.run("wsMessage", "/api/rpc2", ctx, { data: JSON.stringify(request("public:getVersion", {}, "x".repeat(65537))) });
  assert.equal(oversized.data, "{");
  assert.match(f.visibility.lastError, /Ping filter correlation limit exceeded/);
  const reply = f.run("wsSend", "/api/rpc2", ctx, { data: JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(first.data).id, result: [own, user] }) });
  assert.deepEqual(JSON.parse(reply.data).result, [user]);
});

test("task lists with no verifiable ID fail closed, rather than returning an internal name", () => {
  const f = fixture();
  const response = f.rpc("public:getPublicPingTasks", [{ name: own.name }, user]);
  assert.ok(response.error);
  assert.ok(!JSON.stringify(response).includes(own.name));
  assert.match(f.visibility.lastError, /Unsupported task identity/);
});

test("history task summaries and stats with missing identity fail closed too", () => {
  const f = fixture();
  const record = f.rpc("public:getPingRecords", { records: [row(9)], count: 1, tasks: [{ name: own.name }] }, { uuid: "a" });
  assert.ok(record.error);
  assert.ok(!JSON.stringify(record).includes(own.name));
  const stats = f.rpc("public:getPingMetricStats", { stats: [{ name: own.name }], count: 1 });
  assert.ok(stats.error);
  assert.ok(!JSON.stringify(stats).includes(own.name));
  const latest = f.rpc("common:getNodesLatestStatus", { a: { client: "a", ping: { unknown: own } } });
  assert.ok(latest.error);
  assert.ok(!JSON.stringify(latest).includes(own.name));
});

test("large filtering is linear before optional sampling, does not mutate the raw source", t => {
  const f = fixture();
  const records = Array.from({ length: 100000 }, (_, n) => row(n % 2 ? 9 : 1, n % 20, n));
  const input = result(records);
  const start = performance.now();
  const output: any = filterResult(input, { kind: "records" }, f.visibility);
  t.diagnostic(`100000 records: ${(performance.now() - start).toFixed(1)} ms`);
  assert.equal(output.count, 50000);
  assert.equal(input.count, 100000);
  assert.equal(input.records, records);
  assert.ok(output.records.every((r: any) => r.task_id === 9));
});
