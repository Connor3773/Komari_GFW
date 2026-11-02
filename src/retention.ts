import { createHash } from "crypto";
import type { PingTask, Rpc } from "./types.ts";

export const PING_HISTORY_MS = 60 * 60000;
export const EVENT_HISTORY_MS = 7 * 86400000;
export const EVENT_HISTORY_LIMIT = 100;

interface QueryResult { database: string; driver: string; columns: string[]; rows: unknown[][]; truncated: boolean }
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

// Komari 1.6.1 keeps raw samples in memory. Only closed, expired disk rollups are removed.
export async function prunePingHistory(rpc: Rpc, owned: Map<number, string>, prefix: string, now: number): Promise<void> {
  if (!owned.size) return;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(prefix) || !Number.isSafeInteger(now)) throw new Error("Unsupported metric schema");
  const tasks = await rpc.call<PingTask[]>("admin:getAllPingTasks");
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
