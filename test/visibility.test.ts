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
    assert.equal(f.run("wsSend", "/api/rpc2", ctx, { data: reply }), undefined);
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
