import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { collectRetiredHistory, prunePingHistory, PING_HISTORY_MS, readPingTasks, RETIRED_PROTECTION_MS } from "../src/retention.ts";
import type { Rpc } from "../src/types.ts";

const now = Date.parse("2026-11-02T12:00:00Z");
function fixture(driver = "sqlite") {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE metric_series (id INTEGER, metric_name TEXT, tags_hash TEXT, tags TEXT, entity_id TEXT); CREATE TABLE metric_resolutions (id INTEGER, resolution_milli INTEGER); CREATE TABLE metric_rollups (series_id INTEGER, resolution_id INTEGER, label_id INTEGER, bucket_milli INTEGER); INSERT INTO metric_resolutions VALUES (1, 60000), (2, 86400000)");
  const owned = new Map([[10, "owned-10"], [20, "owned-20"]]);
  const tasks = [...owned].map(([id, name]) => ({ id, name }));
  const calls: { method: string; params: any }[] = [];
  let failSchema = false, truncate = false, failWrite = false;
  let raw: unknown = { series: [], count: 0 };
  const rpc = { async call(method: string, params: any) {
    calls.push({ method, params });
    if (method === "admin:getAllPingTasks") return tasks;
    if (method === "public:queryMetrics") {
      assert.equal(Date.parse(params.end) - Date.parse(params.start), 10 * 60000);
      assert.equal(params.fill_empty, false);
      assert.deepEqual(params.metric_keys, ["ping.latency_ms", "ping.loss"]);
      return raw;
    }
    assert.equal(params.database, "metrics");
    if (method === "admin:dbTables") return { database: "metrics", driver, tables: failSchema ? [] : ["metric_series", "metric_resolutions", "metric_rollups"] };
    // Parameter spelling is driver-specific; the shared SQL shape is executed in SQLite.
    const stmt = db.prepare(params.sql.replace(/\$\d+/g, "?"));
    if (method === "admin:dbQuery") {
      const columns = stmt.columns().map(c => c.name);
      const rows = stmt.all(...params.args).map(row => columns.map(c => row[c]));
      return { database: "metrics", driver, columns, rows, truncated: truncate };
    }
    assert.equal(method, "admin:dbExec");
    assert.match(params.sql, /^DELETE FROM metric_(rollups|series) WHERE/);
    if (failWrite) throw new Error("write failed");
    return { rows_affected: stmt.run(...params.args).changes };
  } } as Rpc;
  function series(id: number, taskId: number, metric = "ping.latency_ms") {
    const tags = JSON.stringify({ task_id: String(taskId) });
    db.prepare("INSERT INTO metric_series VALUES (?, ?, ?, ?, ?)").run(id, metric, createHash("sha256").update(tags).digest("hex"), tags, "deleted-server");
  }
  function point(id: number, at: number, resolution = 1, label = 1) { db.prepare("INSERT INTO metric_rollups VALUES (?, ?, ?, ?)").run(id, resolution, label, at); }
  return { db, owned, tasks, calls, rpc, series, point, fail: () => { failSchema = true; }, truncate: () => { truncate = true; }, failWrite: (value = true) => { failWrite = value; }, raw: (value: unknown) => { raw = value; }, run: () => prunePingHistory(rpc, owned, "metric_", now) };
}

for (const driver of ["sqlite", "mysql", "postgresql"]) test(`retention SQL shape scopes closed buckets and both ping metrics (${driver})`, async () => {
  const f = fixture(driver);
  try {
    f.series(1, 10); f.series(2, 20, "ping.loss"); f.series(3, 999); f.series(4, 10, "cpu.usage");
    const old = now - PING_HISTORY_MS - 60000;
    for (const id of [1, 2, 3, 4]) { f.point(id, old); f.point(id, now - 60000); }
    f.point(1, now - PING_HISTORY_MS, 2); // An unfinished daily aggregate remains.
    await f.run();
    const rows = f.db.prepare("SELECT series_id, resolution_id, bucket_milli FROM metric_rollups ORDER BY series_id, bucket_milli").all();
    assert.equal(rows.length, 7);
    assert.ok(!rows.some(r => [1, 2].includes(Number(r.series_id)) && r.bucket_milli === old));
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM metric_series").get()!.n, 4);
    assert.equal(f.calls.filter(c => c.method === "admin:dbExec").length, 1);
  } finally { f.db.close(); }
});

const tombstone = (deletedAt: number | null = now - RETIRED_PROTECTION_MS) => ({ "10": { name: "owned-10", deletedAt } });
for (const driver of ["sqlite", "mysql", "postgresql"]) test(`retired GC removes only old orphan ping data and empty matching dictionaries (${driver})`, async () => {
  const f = fixture(driver);
  try {
    f.tasks.shift();
    f.series(1, 10); f.series(2, 10, "ping.loss"); f.series(3, 999); f.series(4, 10, "cpu.usage"); f.series(5, 20);
    const old = now - RETIRED_PROTECTION_MS - 86400000;
    for (const id of [1, 2, 3, 4, 5]) f.point(id, old);
    const collected = await collectRetiredHistory(f.rpc, tombstone(), "metric_", now, ["live-server"]);
    assert.deepEqual(collected, [10]);
    assert.deepEqual(f.db.prepare("SELECT id FROM metric_series ORDER BY id").all().map(r => r.id), [3, 4, 5]);
    assert.deepEqual(f.db.prepare("SELECT series_id FROM metric_rollups ORDER BY series_id").all().map(r => r.series_id), [3, 4, 5]);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM metric_resolutions").get()!.n, 2);
    const raw = f.calls.find(c => c.method === "public:queryMetrics")!.params;
    assert.deepEqual(raw.entity_ids, ["live-server", "deleted-server"]);
    assert.deepEqual(raw.tags, { task_id: "10" });
  } finally { f.db.close(); }
});

for (const deletedAt of [null, now - RETIRED_PROTECTION_MS + 1]) test(`retired GC skips pending or protected deletion without RPC (${deletedAt})`, async () => {
  const f = fixture();
  try {
    assert.deepEqual(await collectRetiredHistory(f.rpc, tombstone(deletedAt), "metric_", now, []), []);
    assert.equal(f.calls.length, 0);
  } finally { f.db.close(); }
});

test("retired GC preserves reused live IDs regardless of their current name", async () => {
  const f = fixture();
  try {
    f.tasks[0].name = "User-created task";
    f.series(1, 10); f.point(1, now - 10 * 86400000);
    assert.deepEqual(await collectRetiredHistory(f.rpc, tombstone(), "metric_", now, []), []);
    assert.equal(f.calls.filter(c => c.method === "admin:dbExec").length, 0);
  } finally { f.db.close(); }
});

test("recent or unfinished orphan buckets retain dictionary and hidden protection", async () => {
  const f = fixture();
  try {
    f.tasks.shift(); f.series(1, 10); f.point(1, now - 60000);
    assert.deepEqual(await collectRetiredHistory(f.rpc, tombstone(), "metric_", now, []), []);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM metric_series").get()!.n, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM metric_rollups").get()!.n, 1);
  } finally { f.db.close(); }
});

test("late raw samples restart the grace period without deleting any record", async () => {
  const f = fixture();
  try {
    f.tasks.shift(); f.series(1, 10);
    f.raw({ series: [{ metric_key: "ping.latency_ms", downsampled: false, points: [{ time: new Date(now - 9 * 60000).toISOString(), value: 1 }], count: 1 }], count: 1 });
    const retired = tombstone();
    assert.deepEqual(await collectRetiredHistory(f.rpc, retired, "metric_", now, []), []);
    assert.equal(retired[10].deletedAt, now);
    assert.equal(f.calls.filter(c => c.method === "admin:dbExec").length, 0);
  } finally { f.db.close(); }
});

for (const failure of ["schema", "truncation", "write", "tags", "raw-shape", "raw-downsampled", "prefix"] as const) test(`retired GC fails closed and can be retried (${failure})`, async () => {
  const f = fixture();
  try {
    f.tasks.shift(); f.series(1, 10); f.point(1, now - 10 * 86400000);
    const retired = tombstone(), original = structuredClone(retired);
    if (failure === "schema") f.fail();
    if (failure === "truncation") f.truncate();
    if (failure === "write") f.failWrite();
    if (failure === "tags") f.db.prepare("UPDATE metric_series SET tags = ?").run('{"task_id":"999"}');
    if (failure === "raw-shape") f.raw({ series: [], count: 1 });
    if (failure === "raw-downsampled") f.raw({ series: [{ metric_key: "ping.latency_ms", downsampled: true, count: 0, points: [] }], count: 1 });
    await assert.rejects(() => collectRetiredHistory(f.rpc, retired, failure === "prefix" ? "bad;" : "metric_", now, []));
    assert.deepEqual(retired, original);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM metric_rollups").get()!.n, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM metric_series").get()!.n, 1);
    if (failure === "write") {
      f.failWrite(false);
      assert.deepEqual(await collectRetiredHistory(f.rpc, retired, "metric_", now, []), [10]);
    }
  } finally { f.db.close(); }
});

test("retired GC bounds per-pass task and record counts without discarding unfinished work", async () => {
  const f = fixture();
  try {
    f.tasks.length = 0;
    const retired = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [i + 1, { name: `owned-${i + 1}`, deletedAt: now - RETIRED_PROTECTION_MS }]));
    assert.equal((await collectRetiredHistory(f.rpc, retired, "metric_", now, [])).length, 20);
    f.series(1, 10);
    const old = now - 10 * 86400000;
    for (let i = 0; i < 10001; i++) f.point(1, old + i);
    assert.deepEqual(await collectRetiredHistory(f.rpc, tombstone(), "metric_", now, []), []);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM metric_rollups").get()!.n, 1);
    assert.deepEqual(await collectRetiredHistory(f.rpc, tombstone(), "metric_", now, []), [10]);
  } finally { f.db.close(); }
});

for (const value of [undefined, {}, { data: [] }, [null], [{ id: 1 }], [{ id: 1, name: "x" }, { id: 1, name: "x" }]]) test(`task inventory fails closed on incomplete response ${JSON.stringify(value)}`, async () => {
  const rpc = { async call() { return value; } } as Rpc;
  await assert.rejects(() => readPingTasks(rpc));
});

test("retention leaves renamed tasks untouched and skips empty ownership", async () => {
  const f = fixture();
  try {
    f.series(1, 10); f.point(1, now - 86400000); f.tasks[0].name = "User took ownership";
    await f.run();
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM metric_rollups").get()!.n, 1);
    assert.equal(f.calls.filter(c => c.method === "admin:dbExec").length, 0);
    f.calls.length = 0;
    await prunePingHistory(f.rpc, new Map(), "metric_", now);
    assert.equal(f.calls.length, 0);
  } finally { f.db.close(); }
});

for (const failure of ["schema", "truncation", "prefix"] as const) test(`retention fails closed on ${failure}`, async () => {
  const f = fixture();
  try {
    f.series(1, 10); f.point(1, now - 86400000);
    if (failure === "schema") f.fail();
    if (failure === "truncation") f.truncate();
    await assert.rejects(() => failure === "prefix" ? prunePingHistory(f.rpc, f.owned, "metric_; DELETE", now) : f.run());
    assert.equal(f.calls.filter(c => c.method === "admin:dbExec").length, 0);
  } finally { f.db.close(); }
});

test("retention bounds each delete and removes oldest records first", async () => {
  const f = fixture();
  try {
    f.series(1, 10);
    const start = now - 86400000;
    for (let i = 0; i < 10001; i++) f.point(1, start + i);
    await f.run();
    assert.deepEqual(f.db.prepare("SELECT bucket_milli FROM metric_rollups").all().map(r => r.bucket_milli), [start + 10000]);
  } finally { f.db.close(); }
});
