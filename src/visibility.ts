import type { State } from "./types.ts";

// This is an output filter, not an authorization boundary. See docs/ARCHITECTURE.md.
export const PREFIX = "[Komari GFW:";
type Obj = Record<string, any>;
const object = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): string => typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v) : typeof v === "string" && /^[1-9]\d*$/.test(v) ? v : "";
const failureLead = "被墙检测无法安全过滤此响应";
const failureTail = "请缩小查询范围并检查宿主兼容性；未返回该项数据";
const failure = `${failureLead}，${failureTail}`;

export class TaskVisibility {
  private ids: Set<string>;
  lastError = "";
  constructor(privateState: State) {
    this.state = privateState;
    this.ids = new Set((privateState.hiddenTaskIds ?? Object.values(privateState.tasks)).map(id).filter(Boolean));
  }
  private state: State;
  owns(name: unknown): boolean {
    if (typeof name !== "string") return false;
    const start = `${PREFIX}${this.state.instance}:`;
    return name.startsWith(start) && /^(forward:(cn[123]|global[12])|reverse:[a-zA-Z0-9_-]{1,80})\]$/.test(name.slice(start.length));
  }
  has(value: unknown): boolean { return this.ids.has(id(value)); }
  observe(tasks: unknown[]): void {
    for (const task of tasks) {
      if (!object(task) || !id(task.id) || typeof task.name !== "string") continue;
      if (this.owns(task.name)) this.ids.add(id(task.id));
      else {
        this.ids.delete(id(task.id)); // A live, renamed/reused ID is no longer ours.
        if (this.state.retiredTasks) delete this.state.retiredTasks[id(task.id)];
      }
    }
    // Keep only ownership evidence, not latency history. Retired IDs cover cached/raw
    // results after deletion and survive upgrades. Live user-owned IDs revoke it.
    this.state.hiddenTaskIds = [...this.ids].map(Number);
  }
  forget(verifiedIds: number[]): void {
    for (const value of verifiedIds) this.ids.delete(id(value));
    this.state.hiddenTaskIds = [...this.ids].map(Number);
  }
  warn(message = failure): void { this.lastError = message; }
  clear(): void { this.lastError = ""; }
}

export type FilterKind = "tasks" | "records" | "metrics" | "stats" | "latest";
export interface Selection { kind: FilterKind; limit?: number; method?: string }

function list(value: unknown): Obj[] {
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every(object)) throw new Error("Unsupported list");
  return value;
}
const PAGINATION_KEYS = ["total", "total_count", "next_cursor", "has_more", "offset", "page", "pagination"];
function countShape(value: Obj, field: string, rows: Obj[]): void {
  if (!Number.isSafeInteger(value.count) || value.count !== rows.length) throw new Error(`Unsupported ${field} count/pagination`);
  // 1.6.1 and main (62af910) still have no cursor/offset pagination on these
  // payloads. Per-item fields such as stats.total are not collection metadata.
  // Do not invent a global total from one page.
  if (PAGINATION_KEYS.some(k => Object.prototype.hasOwnProperty.call(value, k))) throw new Error("Unsupported pagination");
}

function sample(records: Obj[], limit: number): Obj[] {
  if (limit <= 0 || records.length <= limit) return records;
  const groups = new Map<string, Obj[]>();
  for (const row of records) {
    const key = id(row.task_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  const allocations = [...groups].map(([key, rows]) => {
    rows.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const share = rows.length * limit / records.length;
    return { key, rows, size: Math.floor(share), fraction: share % 1 };
  });
  let remaining = limit - allocations.reduce((n, g) => n + g.size, 0);
  for (const g of [...allocations].sort((a, b) => b.fraction - a.fraction || Number(a.key) - Number(b.key))) {
    if (remaining-- <= 0) break;
    g.size++;
  }
  return allocations.flatMap(({ rows, size }) => Array.from({ length: size }, (_, n) => rows[size === 1 ? rows.length - 1 : Math.round(n * (rows.length - 1) / (size - 1))]))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function basicInfo(records: Obj[]): Obj[] {
  const clients = new Map<string, { total: number; lost: number; min: number; max: number }>();
  for (const row of records) {
    const key = row.client ?? "";
    const s = clients.get(key) ?? { total: 0, lost: 0, min: 0, max: 0 };
    s.total++;
    if (row.value < 0) s.lost++;
    else { if (s.min === 0 || row.value < s.min) s.min = row.value; s.max = Math.max(s.max, row.value); }
    clients.set(key, s);
  }
  return [...clients].map(([client, s]) => ({ client, loss: s.lost / s.total * 100, min: s.min, max: s.max }));
}

export function filterResult(value: unknown, selection: Selection, visibility: TaskVisibility): unknown {
  if (selection.kind === "tasks") {
    const tasks = list(value);
    visibility.observe(tasks);
    const visible = tasks.filter(t => !visibility.has(t.id));
    return visible.length === tasks.length ? value : visible;
  }
  if (!object(value)) throw new Error("Unsupported result");
  if (selection.kind === "records") {
    const records = list(value.records);
    countShape(value, "records", records);
    const tasks = value.tasks == null ? [] : list(value.tasks);
    visibility.observe(tasks);
    for (const r of records) if (!id(r.task_id) || typeof r.value !== "number" || !Number.isFinite(r.value) || !Number.isFinite(Date.parse(r.time)) || (r.client !== undefined && typeof r.client !== "string")) throw new Error("Unsupported ping record");
    const kept = records.filter(r => !visibility.has(r.task_id));
    const visibleTasks = tasks.filter(t => !visibility.has(t.id));
    const output: Obj = { ...value, records: sample(kept, selection.limit ?? 0) };
    output.count = output.records.length;
    if ("tasks" in value) output.tasks = value.tasks === null ? null : visibleTasks;
    if (kept.length !== records.length || visibleTasks.length !== tasks.length) {
      if (kept.length) output.basic_info = basicInfo(kept);
      else delete output.basic_info;
    }
    return output;
  }
  if (selection.kind === "metrics") {
    const series = list(value.series);
    countShape(value, "series", series);
    const kept: Obj[] = [];
    for (const s of series) {
      if (typeof s.metric_key !== "string") throw new Error("Unsupported metric key");
      if (!s.metric_key.startsWith("ping.")) { kept.push(s); continue; }
      if (visibility.has(s.tags?.task_id) || visibility.has(s.labels?.task_id)) continue;
      // Point count is the number of raw samples in a bucket, not the series length.
      const points = s.points == null && s.count === 0 ? [] : list(s.points);
      countShape(s, "points", points);
      const visible = points.filter(p => !visibility.has(p.tags?.task_id) && !visibility.has(p.labels?.task_id));
      if (visible.length === points.length) kept.push(s);
      else if (visible.length) kept.push({ ...s, points: visible, count: visible.length });
    }
    return { ...value, series: kept, count: kept.length };
  }
  if (selection.kind === "stats") {
    const stats = list(value.stats);
    countShape(value, "stats", stats);
    visibility.observe(stats.map(s => ({ id: s.task_id, name: s.name })));
    const kept = stats.filter(s => !visibility.has(s.task_id) && !visibility.has(s.tags?.task_id) && !visibility.has(s.labels?.task_id));
    return { ...value, stats: kept, count: kept.length };
  }
  const cleanNode = (node: Obj): Obj => {
    // A missing or null ping dictionary has no task keys to leak.
    if (!("ping" in node) || node.ping === null) return node;
    if (!object(node.ping)) throw new Error("Unsupported node ping summary");
    return { ...node, ping: Object.fromEntries(Object.entries(node.ping).filter(([key]) => !visibility.has(key))) };
  };
  // common:getNodesLatestStatus returns one record or a uuid → record map.
  const singleNode = typeof value.client === "string" && ("ping" in value || "cpu" in value || "time" in value || "online" in value);
  if (singleNode) return cleanNode(value);
  return Object.fromEntries(Object.entries(value).flatMap(([key, node]) => {
    if (node === null) return [];
    if (!object(node)) throw new Error("Unsupported node map");
    return [[key, cleanNode(node)]];
  }));
}

// Go encoding/json accepts case-insensitive tagged fields; the last spelling wins.
// Unicode SimpleFold also equates long-s / Kelvin-sign to ASCII s / k.
const foldField = (key: string): string => key.replace(/\u017f/g, "s").replace(/\u212a/g, "k").toLowerCase();
function field(obj: Obj, name: string, ignoreNull = false): any {
  let value;
  for (const key of Object.keys(obj)) if (foldField(key) === foldField(name) && (!ignoreNull || obj[key] !== null)) value = obj[key];
  return value;
}
function setField(obj: Obj, name: string, value: unknown): void {
  for (const key of Object.keys(obj)) if (foldField(key) === foldField(name)) delete obj[key];
  obj[name] = value;
}
function param(params: unknown, name: string, position: number): unknown {
  if (Array.isArray(params)) return params[position];
  // BindParams marshals a Go map before decoding the struct, sorting keys.
  if (object(params)) return field(Object.fromEntries(Object.keys(params).sort().map(k => [k, params[k]])), name, ["type", "metric_key", "maxCount", "max_count"].includes(name));
  return position === 0 ? params : undefined;
}
function unlimit(params: unknown, name: string, position: number, unlimited: number): unknown {
  if (Array.isArray(params)) {
    const result = [...params];
    // Zero values for omitted struct fields: strings for public, pointers/ints for common.
    const defaults = name === "max_count" ? ["", "", "", 0] : ["", "", 0, null, null, "", 0, 0];
    while (result.length <= position) result.push(defaults[result.length]);
    result[position] = unlimited;
    return result;
  }
  const result = object(params) ? { ...params } : params == null ? {} : { [name === "max_count" ? "uuid" : "type"]: params };
  setField(result, name, unlimited);
  return result;
}

interface RpcSelection extends Selection { originalId: unknown }
interface Correlation { selections: Map<string, RpcSelection>; untouchedIds: Set<string> }
interface Prepared extends Correlation { body: string }
export interface HookRequest { body: string; headers: Record<string, string | string[]>; url: string; method: string }
export interface HookResponse { statusCode: number; headers: Record<string, string | string[]>; body: string }
export interface HookServer { hook(kind: string, matcher: string, callback: (...args: any[]) => unknown): void }
const HEADER = "x-komari-gfw-filter";
const MAX_PENDING = 256;
const MAX_BATCH = 1000;
const TTL = 120000;

// Go decodes a repeated string field followed by null differently from JSON.parse.
// Reject ambiguous duplicate keys rather than accidentally miss a Ping method.
function uniqueKeys(body: string): void {
  const stack: { keys?: Set<string>; key: boolean }[] = [];
  const tokens = /"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(body))) {
    const token = match[0], top = stack[stack.length - 1];
    if (token === "{") stack.push({ keys: new Set(), key: true });
    else if (token === "[") stack.push({ key: false });
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && top?.keys) top.key = true;
    else if (token[0] === '"' && top?.keys && top.key) {
      const key = JSON.parse(token);
      if (top.keys.has(key)) throw new Error("Ambiguous duplicate JSON key");
      top.keys.add(key);
      top.key = false;
    }
  }
}

export class PingResponseFilter {
  private sequence = 0;
  private pending = new Map<string, { at: number; prepared: Correlation }>();
  private sockets = new Map<number, Correlation>();
  private visibility: TaskVisibility;
  private nonce: string;
  private clock: () => number;
  constructor(visibility: TaskVisibility, nonce: string, clock = Date.now) { this.visibility = visibility; this.nonce = nonce; this.clock = clock; }
  private token(): string { return `km-filter-${this.nonce}-${++this.sequence}`; }
  private checkOf(error: unknown): string { return error instanceof Error && error.message ? error.message : "filter"; }
  private report(where: string, check: string): string {
    const message = `${failureLead}（${where} / ${check}）；${failureTail}`;
    this.visibility.warn(message);
    return message;
  }
  private ownsToken(id: unknown): boolean { return typeof id === "string" && id.startsWith(`km-filter-${this.nonce}-`); }
  private prepare(body: string): Prepared | undefined {
    let data: unknown;
    try { data = JSON.parse(body); } catch { return; }
    uniqueKeys(body);
    const messages = Array.isArray(data) ? data : [data];
    const selections = new Map<string, RpcSelection>();
    const originalIds = new Set(messages.filter(object).map(req => JSON.stringify(field(req, "id") ?? null)));
    const untouchedIds = new Set<string>();
    for (const req of messages) {
      if (!object(req) || field(req, "jsonrpc", true) !== "2.0") continue;
      const method = field(req, "method", true);
      const params = field(req, "params");
      let selection: Selection | undefined;
      if (method === "public:getPublicPingTasks" || method === "admin:getAllPingTasks") selection = { kind: "tasks" };
      else if (method === "public:queryMetrics") {
        const keys = [param(params, "metric_key", 0), param(params, "metric_keys", 1), param(params, "metrics", 2)].flat();
        if (keys.some(key => typeof key === "string" && key.trim().startsWith("ping."))) selection = { kind: "metrics" };
      }
      else if (method === "public:getPingMetricStats") selection = { kind: "stats" };
      else if (method === "common:getNodesLatestStatus") selection = { kind: "latest" };
      else if (method === "public:getPingRecords" || (method === "common:getRecords" && param(params, "type", 0) === "ping")) {
        const common = method !== "public:getPingRecords";
        const name = common ? "maxCount" : "max_count", position = common ? 7 : 3;
        const rawLimit = param(params, name, position);
        if (common && rawLimit != null && !Number.isSafeInteger(rawLimit)) { untouchedIds.add(JSON.stringify(field(req, "id") ?? null)); continue; }
        const limit = typeof rawLimit === "number" && Number.isSafeInteger(rawLimit) && rawLimit !== 0 ? rawLimit : common ? 4000 : 0;
        selection = { kind: "records", limit };
        setField(req, "params", unlimit(params, name, position, common ? -1 : 0));
      }
      if (!selection) { untouchedIds.add(JSON.stringify(field(req, "id") ?? null)); continue; }
      if (messages.length > MAX_BATCH) throw new Error("Ping filter batch limit exceeded");
      let token = this.token();
      while (originalIds.has(JSON.stringify(token))) token = this.token();
      selections.set(token, { ...selection, method: typeof method === "string" ? method : undefined, originalId: field(req, "id") ?? null });
      setField(req, "id", token);
    }
    if (!selections.size) return;
    if ([...originalIds].reduce((n, key) => n + key.length, 0) > 65536) throw new Error("Ping filter correlation limit exceeded");
    return { selections, untouchedIds, body: JSON.stringify(data) };
  }
  private rpcResponse(body: string, prepared: Correlation, transport: string): string {
    let data: unknown;
    try { data = JSON.parse(body); }
    catch { throw new Error("Unsupported RPC envelope"); }
    uniqueKeys(body);
    const messages = Array.isArray(data) ? data : [data];
    let failed = false;
    let filtered = false;
    for (const res of messages) {
      if (!object(res) || res.jsonrpc !== "2.0") throw new Error("Unsupported RPC envelope");
      const selection = prepared.selections.get(res.id);
      if (!selection) {
        if (!("error" in res) && !prepared.untouchedIds.has(JSON.stringify(res.id ?? null))) throw new Error("Uncorrelated RPC response");
        continue;
      }
      res.id = selection.originalId;
      if ("error" in res) {
        if ("result" in res) throw new Error("Ambiguous RPC response");
        continue;
      }
      const where = `${transport} ${selection.method ?? selection.kind}`;
      try {
        res.result = filterResult(res.result, selection, this.visibility);
        filtered = true;
      } catch (error) {
        failed = true;
        delete res.result;
        res.error = { code: -32603, message: this.report(where, this.checkOf(error)) };
      }
    }
    if (filtered && !failed) this.visibility.clear();
    return JSON.stringify(data);
  }
  private sweep(): void {
    const cutoff = this.clock() - TTL;
    for (const [key, value] of this.pending) if (value.at < cutoff) this.pending.delete(key);
  }
  private fail(res: HookResponse, where: string, check: string): void {
    const message = this.report(where, check);
    res.statusCode = 502;
    res.headers["content-type"] = "application/json; charset=utf-8";
    res.headers["x-content-type-options"] = "nosniff";
    res.body = JSON.stringify({ status: "error", message });
  }
  private headers(res: HookResponse): void {
    res.headers["cache-control"] = "no-store";
    delete res.headers["etag"];
    delete res.headers["content-length"];
  }
  register(server: HookServer): void {
    // Only these paths are buffered. server.call() never traverses HTTP/WS hooks.
    server.hook("response", "GET /api/task/ping", (_req: HookRequest, res: HookResponse) => this.rest(res, { kind: "tasks", method: "public:getPublicPingTasks" }, "GET /api/task/ping"));
    // 1.6.1 and current main serve the admin list at /ping/ but strip trailing
    // slashes from exact hook matchers. Use a GET-only subtree matcher and guard
    // the actual list URL.
    server.hook("response", "GET /api/admin/ping/*", (req: HookRequest, res: HookResponse) => {
      if (/^\/api\/admin\/ping\/?(?:\?|$)/i.test(req.url)) this.rest(res, { kind: "tasks", method: "admin:getAllPingTasks" }, "GET /api/admin/ping");
    });
    server.hook("request", "GET /api/records/ping", (req: HookRequest) => {
      delete req.headers[HEADER];
      // The REST bridge accepts a JSON GET body. Normal requests have no sample cap.
      if (!req.body) return;
      let params;
      try { params = JSON.parse(req.body); } catch { return; }
      if (!object(params)) return;
      const prepared = this.prepare(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "public:getPingRecords", params }));
      if (prepared) {
        this.remember(req, prepared, "GET /api/records/ping");
        req.body = JSON.stringify(JSON.parse(prepared.body).params);
      }
    });
    server.hook("response", "GET /api/records/ping", (req: HookRequest, res: HookResponse) => {
      const entry = this.take(req);
      if (req.headers[HEADER] && !entry) { this.headers(res); return this.fail(res, "GET /api/records/ping", "Uncorrelated RPC response"); }
      this.rest(res, entry ? [...entry.selections.values()][0] : { kind: "records", method: "public:getPingRecords" }, "GET /api/records/ping");
    });
    server.hook("request", "POST /api/rpc2", (req: HookRequest) => {
      delete req.headers[HEADER];
      const prepared = this.prepare(req.body);
      if (prepared) { this.remember(req, prepared, "POST /api/rpc2"); req.body = prepared.body; }
    });
    server.hook("response", "POST /api/rpc2", (req: HookRequest, res: HookResponse) => {
      if (!req.headers[HEADER]) return;
      const prepared = this.take(req);
      this.headers(res);
      if (!prepared) return this.fail(res, "POST /api/rpc2", "Uncorrelated RPC response");
      try { res.body = this.rpcResponse(res.body, prepared, "POST /api/rpc2"); }
      catch (error) { this.fail(res, "POST /api/rpc2", this.checkOf(error)); }
    });
    server.hook("wsMessage", "/api/rpc2", (ctx: { connId: number }, msg: { data: unknown }) => {
      // 1.6.1 and current main read one request and write its response before the
      // next read. A heartbeat or other method must not drop a filtered request
      // that is still waiting, and must not be recorded as a filter failure.
      try {
        const body = frameText(msg.data);
        const prepared = this.prepare(body);
        if (!prepared) return;
        if (this.sockets.size >= MAX_PENDING && !this.sockets.has(ctx.connId)) {
          this.report("WS /api/rpc2", "Too many pending connections");
          return { data: "{", type: 1 };
        }
        this.sockets.set(ctx.connId, { selections: prepared.selections, untouchedIds: prepared.untouchedIds });
        return { data: prepared.body, type: 1 };
      } catch (error) {
        this.report("WS /api/rpc2", this.checkOf(error));
        // A frame hook exception would pass through. Invalid JSON invokes a native
        // protocol error instead; never drop silently or leave the client hanging.
        return { data: "{", type: 1 };
      }
    });
    server.hook("wsSend", "/api/rpc2", (ctx: { connId: number }, msg: { data: unknown }) => {
      const prepared = this.sockets.get(ctx.connId);
      const reject = (check: string) => {
        const message = this.report("WS /api/rpc2", check);
        return { data: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message } }), type: 1 };
      };
      let text: string;
      try { text = frameText(msg.data); }
      catch (error) {
        if (!prepared) return;
        this.sockets.delete(ctx.connId);
        return reject(this.checkOf(error));
      }
      // Heartbeats and other methods do not carry our wire id. Skip them without
      // dropping a filtered request that is still waiting for its own response.
      if (!prepared && !text.includes(`km-filter-${this.nonce}-`)) return;
      let parsed: unknown;
      try { parsed = JSON.parse(text); }
      catch {
        if (!prepared && !text.includes(`km-filter-${this.nonce}-`)) return;
        if (prepared) this.sockets.delete(ctx.connId);
        return reject("Unsupported RPC envelope");
      }
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const matched = !!prepared && messages.some(message => object(message) && prepared.selections.has(message.id));
      if (!matched) {
        // A frame that still uses our wire id is unfiltered until we can correlate
        // it. Reject that frame. Keep a different in-flight selection so its real
        // response can still be filtered.
        if (messages.some(message => object(message) && this.ownsToken(message.id))) return reject("Uncorrelated RPC response");
        return;
      }
      this.sockets.delete(ctx.connId);
      try { return { data: this.rpcResponse(text, prepared, "WS /api/rpc2"), type: 1 }; }
      catch (error) { return reject(this.checkOf(error)); }
    });
    server.hook("wsClose", "/api/rpc2", (ctx: { connId: number }) => this.sockets.delete(ctx.connId));
  }
  private remember(req: HookRequest, prepared: Prepared, where: string): void {
    this.sweep();
    if (this.pending.size >= MAX_PENDING) { this.report(where, "Too many pending Ping requests"); throw new Error("Too many pending Ping requests"); }
    const token = this.token();
    this.pending.set(token, { at: this.clock(), prepared: { selections: prepared.selections, untouchedIds: prepared.untouchedIds } });
    req.headers[HEADER] = token;
  }
  private take(req: HookRequest): Correlation | undefined {
    const token = req.headers[HEADER];
    if (typeof token !== "string") return;
    const entry = this.pending.get(token);
    this.pending.delete(token);
    return entry?.prepared;
  }
  private rest(res: HookResponse, selection: Selection, where: string): void {
    this.headers(res);
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    try {
      const body = JSON.parse(res.body);
      if (body.status === "error") return;
      if (body.status !== "success") throw new Error("Unsupported REST envelope");
      // Standard bridge omits a nil result's data.
      if (!("data" in body) && selection.kind === "tasks") { this.visibility.clear(); return; }
      body.data = filterResult(body.data, selection, this.visibility);
      res.body = JSON.stringify(body);
      this.visibility.clear();
    } catch (error) {
      const check = error instanceof SyntaxError ? "Unsupported REST envelope" : this.checkOf(error);
      this.fail(res, where, check);
    }
  }
}

function frameText(data: unknown): string {
  if (typeof data === "string") return data;
  // MoeJS exposes binary frames as ArrayBuffer; Buffer is provided by node permission.
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  throw new Error("Unsupported WebSocket frame");
}
