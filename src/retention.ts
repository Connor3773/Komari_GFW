import { createHash } from "crypto";
import type { PingTask, Rpc } from "./types.ts";

export const PING_HISTORY_MS = 60 * 60000;
export const EVENT_HISTORY_MS = 7 * 86400000;
export const EVENT_HISTORY_LIMIT = 100;
// Exceeds the native raw/stat caches and the longest supported (daily) bucket.
export const RETIRED_PROTECTION_MS = 48 * 3600000;

interface QueryResult { database: string; driver: string; columns: string[]; rows: unknown[][]; truncated: boolean }
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

export async function readPingTasks(rpc: Rpc): Promise<PingTask[]> {
  const value = await rpc.call<unknown>("admin:getAllPingTasks");
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error("Unsupported task list");
  const seen = new Set<number>();
  for (const task of value) {
    if (!task || !positiveId(task.id) || typeof task.name !== "string" || seen.has(task.id)) throw new Error("Incomplete task ownership response");
    seen.add(task.id);
  }
  return value;
}

// Komari 1.6.1 keeps raw samples in memory. Only closed, expired disk rollups are removed.
export async function prunePingHistory(rpc: Rpc, owned: Map<number, string>, prefix: string, now: number): Promise<void> {
  if (!owned.size) return;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(prefix) || !Number.isSafeInteger(now)) throw new Error("Unsupported metric schema");
  const tasks = await readPingTasks(rpc);
  const ids = tasks.filter(t => positiveId(t.id) && owned.get(t.id) === t.name).map(t => t.id);
  if (!ids.length) return;
  const tables = await rpc.call<{ database: string; driver: string; tables: string[] }>("admin:dbTables", { database: "metrics" });
  const names = { series: prefix + "series", rollups: prefix + "rollups", resolutions: prefix + "resolutions" };
  if (tables.database !== "metrics" || !["sqlite", "mysql", "postgresql"].includes(tables.driver) || !Object.values(names).every(t => tables.tables.includes(t))) throw new Error("Unsupported metric schema");
  const placeholders = (n: number) => Array.from({ length: n }, (_, i) => tables.driver === "postgresql" ? `$${i + 1}` : "?");
  async function query(sql: string, args: unknown[], columns: string[]) {
    const result = await rpc.call<QueryResult>("admin:dbQuery", { database: "metrics", sql, args, limit: 10000 });
    if (result.database !== "metrics" || result.driver !== tables.driver || result.truncated || JSON.stringify(result.columns) !== JSON.stringify(columns) || !Array.isArray(result.rows)) throw new Error("Unsupported metric response");
    return result.rows;
  }
  const resolutions = await query(`SELECT id, resolution_milli FROM ${names.resolutions}`, [], ["id", "resolution_milli"]);
  if (resolutions.some(([id, width]) => !positiveId(id) || !positiveId(width) || Number(width) > 86400000)) throw new Error("Unsupported resolution");
  const allowed = new Set(ids.map(String));
  for (let offset = 0; offset < ids.length; offset += 20) {
    const hashes = ids.slice(offset, offset + 20).map(id => createHash("sha256").update(JSON.stringify({ task_id: String(id) })).digest("hex"));
    const rows = await query(`SELECT id, tags FROM ${names.series} WHERE metric_name IN ('ping.latency_ms', 'ping.loss') AND tags_hash IN (${placeholders(hashes.length).join(", ")})`, hashes, ["id", "tags"]);
    const series = rows.map(([id, raw]) => {
      const tags = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!positiveId(id) || !tags || typeof tags !== "object" || Object.keys(tags).length !== 1 || !allowed.has(tags.task_id)) throw new Error("Unowned metric series");
      return id;
    });
    for (let start = 0; start < series.length; start += 250) {
      const batch = series.slice(start, start + 250);
      for (const [resolutionId, width] of resolutions) {
        const args = [...batch, resolutionId, now - PING_HISTORY_MS - Number(width)];
        const p = placeholders(args.length);
        const filter = `series_id IN (${p.slice(0, batch.length).join(", ")}) AND resolution_id = ${p[batch.length]} AND bucket_milli <= ${p[batch.length + 1]}`;
        // Avoid creating host SQL audit entries when there is nothing to prune.
        const found = await query(`SELECT series_id FROM ${names.rollups} WHERE ${filter} LIMIT 1`, args, ["series_id"]);
        if (!found.length) continue;
        // The derived table keeps deletion bounded and is compatible with MySQL's target-table rule.
        const keys = "series_id, resolution_id, label_id, bucket_milli";
        await rpc.call("admin:dbExec", { database: "metrics", sql: `DELETE FROM ${names.rollups} WHERE (${keys}) IN (SELECT ${keys} FROM (SELECT ${keys} FROM ${names.rollups} WHERE ${filter} ORDER BY bucket_milli LIMIT 10000) AS expired)`, args });
      }
    }
  }
}

export async function collectRetiredHistory(rpc: Rpc, retired: Record<string, { name: string; deletedAt: number | null }>, prefix: string, now: number, clients: string[]): Promise<number[]> {
  const eligible = Object.entries(retired).filter(([id, entry]) => positiveId(Number(id)) && entry.deletedAt !== null && Number.isSafeInteger(entry.deletedAt) && entry.deletedAt <= now - RETIRED_PROTECTION_MS);
  if (!eligible.length) return [];
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(prefix) || !Number.isSafeInteger(now)) throw new Error("Unsupported metric schema");
  const live = new Set((await readPingTasks(rpc)).map(t => t.id));
  const candidates = eligible.filter(([id]) => !live.has(Number(id))).sort((a, b) => a[1].deletedAt! - b[1].deletedAt!).slice(0, 20);
  if (!candidates.length) return [];
  const tables = await rpc.call<{ database: string; driver: string; tables: string[] }>("admin:dbTables", { database: "metrics" });
  const series = prefix + "series", rollups = prefix + "rollups", resolutions = prefix + "resolutions";
  if (tables.database !== "metrics" || !["sqlite", "mysql", "postgresql"].includes(tables.driver) || ![series, rollups, resolutions].every(t => tables.tables.includes(t))) throw new Error("Unsupported metric schema");
  const placeholders = (n: number) => Array.from({ length: n }, (_, i) => tables.driver === "postgresql" ? `$${i + 1}` : "?");
  async function query(sql: string, args: unknown[], columns: string[]) {
    const result = await rpc.call<QueryResult>("admin:dbQuery", { database: "metrics", sql, args, limit: 10000 });
    if (result.database !== "metrics" || result.driver !== tables.driver || result.truncated || JSON.stringify(result.columns) !== JSON.stringify(columns) || !Array.isArray(result.rows)) throw new Error("Unsupported metric response");
    return result.rows;
  }
  const widths = await query(`SELECT id, resolution_milli FROM ${resolutions}`, [], ["id", "resolution_milli"]);
  if (widths.some(([id, width]) => !positiveId(id) || !positiveId(width) || Number(width) > 86400000)) throw new Error("Unsupported resolution");
  async function hasRaw(task: number, entities: string[]): Promise<boolean> {
    for (let offset = 0; offset < entities.length; offset += 40) {
      const result = await rpc.call<{ series: any[]; count: number }>("public:queryMetrics", {
        metric_keys: ["ping.latency_ms", "ping.loss"], entity_ids: entities.slice(offset, offset + 40), tags: { task_id: String(task) },
        start: new Date(now - 10 * 60000).toISOString(), end: new Date(now).toISOString(), fill_empty: false, max_points: 4000,
      });
      if (!Array.isArray(result.series) || result.count !== result.series.length) throw new Error("Unsupported raw metric response");
      for (const s of result.series) {
        if (!s || !["ping.latency_ms", "ping.loss"].includes(s.metric_key) || s.downsampled !== false || (s.points !== null && !Array.isArray(s.points)) || s.count !== (s.points?.length ?? 0)) throw new Error("Unsupported raw metric series");
        if (s.points?.length) return true;
      }
    }
    return false;
  }
  const collected: number[] = [];
  for (const [key, entry] of candidates) {
    const task = Number(key), hash = createHash("sha256").update(JSON.stringify({ task_id: key })).digest("hex");
    const condition = `metric_name IN ('ping.latency_ms', 'ping.loss') AND tags_hash = ${placeholders(1)[0]}`;
    const rows = await query(`SELECT id, tags, entity_id FROM ${series} WHERE ${condition}`, [hash], ["id", "tags", "entity_id"]);
    const ids = rows.map(([id, raw, entity]) => {
      const tags = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!positiveId(id) || typeof entity !== "string" || !tags || typeof tags !== "object" || Object.keys(tags).length !== 1 || tags.task_id !== key) throw new Error("Unowned retired metric series");
      return id;
    });
    const entities = [...new Set([...clients, ...rows.map(row => row[2] as string)])];
    if (await hasRaw(task, entities)) { entry.deletedAt = now; continue; }
    // Recheck task identity immediately before writes. Never use a historical ID
    // as permission to delete a live task, even if it still has our marker.
    if ((await readPingTasks(rpc)).some(t => t.id === task)) continue;
    for (let offset = 0; offset < ids.length; offset += 250) {
      const batch = ids.slice(offset, offset + 250);
      const p = placeholders(batch.length + 1);
      const keys = "series_id, resolution_id, label_id, bucket_milli";
      const filter = `series_id IN (${p.slice(0, batch.length).join(", ")}) AND bucket_milli <= ${p[batch.length]}`;
      // Leave recent/unfinished data protected. Native deletion normally leaves
      // only dictionary rows; this bounded pass handles old late-arriving rollups.
      const args = [...batch, now - RETIRED_PROTECTION_MS - 86400000];
      if ((await query(`SELECT series_id FROM ${rollups} WHERE ${filter} LIMIT 1`, args, ["series_id"])).length) {
        await rpc.call("admin:dbExec", { database: "metrics", sql: `DELETE FROM ${rollups} WHERE (${keys}) IN (SELECT ${keys} FROM (SELECT ${keys} FROM ${rollups} WHERE ${filter} ORDER BY bucket_milli LIMIT 10000) AS expired)`, args });
      }
      const q = placeholders(batch.length + 1);
      await rpc.call("admin:dbExec", { database: "metrics", sql: `DELETE FROM ${series} WHERE id IN (${q.slice(0, batch.length).join(", ")}) AND metric_name IN ('ping.latency_ms', 'ping.loss') AND tags_hash = ${q[batch.length]} AND NOT EXISTS (SELECT 1 FROM ${rollups} WHERE series_id = ${series}.id)`, args: [...batch, hash] });
    }
    if ((await query(`SELECT id, tags, entity_id FROM ${series} WHERE ${condition}`, [hash], ["id", "tags", "entity_id"])).length) continue;
    if (await hasRaw(task, entities)) { entry.deletedAt = now; continue; }
    if (!(await readPingTasks(rpc)).some(t => t.id === task)) collected.push(task);
  }
  return collected;
}
