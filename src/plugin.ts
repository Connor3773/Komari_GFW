import type { Rpc, State } from "./types.ts";
import { validateConfig } from "./config.ts";
import { Service, initialState } from "./service.ts";
import { UserError } from "./errors.ts";
import { JournalStore } from "./storage.ts";
import { PingResponseFilter, type HookServer } from "./visibility.ts";

declare const __storageDir__: string;
const fs = require("fs") as typeof import("node:fs");
const path = require("path") as typeof import("node:path");
const crypto = require("crypto") as typeof import("node:crypto");
interface Request { body: string; headers: Record<string, string>; context: { principal?: { roles?: string[] } } }
interface Response { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void }
const server = require("server") as Rpc & HookServer & { route(method: string, path: string, callback: (req: Request, res: Response) => Promise<void>): void; cron(expression: string, callback: () => void): void };
let service: Service;
let queue: Promise<unknown> = Promise.resolve();
let stopping = false;
let polling = false;

function exclusive<T>(action: () => Promise<T>): Promise<T> {
  const next = queue.then(action);
  queue = next.catch(() => undefined);
  return next;
}
function json(res: Response, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(data));
}
function route(method: string, name: string, action: (body: Record<string, unknown>) => Promise<unknown>) {
  server.route(method, `/api/admin/plugins/komari-gfw/${name}`, async (req, res) => {
    if (!req.context?.principal?.roles?.includes("admin")) return json(res, 403, { error: "需要管理员身份" });
    if (stopping) return json(res, 503, { error: "插件正在停止" });
    if (method === "POST" && (req.headers["x-komari-gfw"] !== "1" || !req.headers["content-type"]?.startsWith("application/json"))) return json(res, 403, { error: "无效写入请求" });
    if (req.headers["sec-fetch-site"] === "cross-site") return json(res, 403, { error: "拒绝跨站请求" });
    if ((req.body ?? "").length > 200000) return json(res, 413, { error: "请求过大" });
    try {
      const body = req.body ? JSON.parse(req.body) : {};
      const result = await exclusive(() => action(body));
      json(res, 200, result ?? { ok: true });
    } catch (error) {
      // RPC errors can contain channel URLs or credentials. Never return them verbatim.
      const message = error instanceof UserError ? error.message : "操作失败，请检查插件权限、宿主服务或通知渠道";
      json(res, 400, { error: message.slice(0, 200) });
    }
  });
}

async function load() {
  fs.mkdirSync(__storageDir__, { recursive: true });
  const store = new JournalStore(fs, [path.join(__storageDir__, "state-0.json"), path.join(__storageDir__, "state-1.json")], text => crypto.createHash("sha256").update(text).digest("hex"));
  let state: State;
  const saved = store.load();
  if (saved) {
    state = saved;
    if (state.schema !== 1 || !/^[a-f0-9]{24}$/.test(state.instance) || !Array.isArray(state.events) || !state.tasks || !state.monitors) throw new Error("持久化状态损坏，请先备份并检查状态文件");
    state.config = validateConfig(state.config);
    state.sources ??= {};
  } else state = initialState(crypto.randomBytes(12).toString("hex"));
  service = new Service(state, server, store);
  new PingResponseFilter(service.visibility, crypto.randomBytes(16).toString("hex")).register(server);
  service.persist();
  route("GET", "overview", async () => service.snapshot());
  route("GET", "settings", async () => { await service.refreshClients(); await service.refreshNotification(); return service.settings(); });
  route("POST", "settings", async body => { await service.saveConfig(body.config, body.revision); return service.settings(); });
  route("POST", "test-notification", async () => { await service.testNotification(); return { ok: true }; });
  route("POST", "cleanup", async body => { if (body.confirm !== "DELETE_PLUGIN_TASKS") throw new UserError("请确认删除插件任务和探测历史"); await service.cleanup(); return { ok: true }; });
  route("POST", "refresh", async () => { await service.tick(); return service.snapshot(); });
  server.cron("@every 10s", () => {
    if (stopping || polling) return;
    polling = true;
    exclusive(() => service.tick()).catch(() => console.error("被墙检测状态持久化失败")).finally(() => { polling = false; });
  });
  await service.tick();
  console.log("被墙检测已加载");
}

async function unload() {
  stopping = true;
  await exclusive(async () => {
    if (service) { await service.reconcile(true); service.persist(); }
  });
}

Object.assign(globalThis, { load, unload });
