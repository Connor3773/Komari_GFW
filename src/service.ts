import { cleanText, defaultConfig, detectionSignature, monitorKeys, reverseAddress, validateConfig } from "./config.ts";
import { evaluate, newMonitor, resetStreaks, staleAfter } from "./engine.ts";
import { notificationEvent, safeClient } from "./privacy.ts";
import type { Client, Config, MetricSeries, Monitor, Notice, NotificationStatus, PingTask, Rpc, Sample, State } from "./types.ts";
import { UserError } from "./errors.ts";

export interface Store { save(state: State): void }
export const PREFIX = "[Komari GFW:";
export function initialState(instance: string): State {
  return { schema: 1, instance, config: defaultConfig(), revision: 0, tasks: {}, sources: {}, monitors: {}, events: [] };
}

export function notificationReadiness(settings: Record<string, unknown>): NotificationStatus {
  const channel = typeof settings.notification_method === "string" ? settings.notification_method : "";
  if (settings.notification_enabled !== true) return { ready: false, reason: "系统通知总开关未开启", channel };
  if (!channel || channel === "none") return { ready: false, reason: "系统未选择通知渠道", channel };
  if (typeof settings.notification_template !== "string" || !settings.notification_template.includes("{{message}}")) {
    return { ready: false, reason: "系统通知模板必须包含 {{message}}", channel };
  }
  return { ready: true, reason: "系统通知配置已就绪，实际投递请用测试通知验证", channel };
}

export class Service {
  state: State;
  clients: Client[] = [];
  lastError = "";
  lastPoll: number | null = null;
  notification: NotificationStatus = { ready: false, reason: "尚未检查通知配置", channel: "" };
  private rpc: Rpc;
  private store: Store;
  private clock: () => number;

  constructor(state: State, rpc: Rpc, store: Store, clock = Date.now) {
    this.state = state;
    this.rpc = rpc;
    this.store = store;
    this.clock = clock;
  }

  persist() { this.store.save(this.state); }

  async refreshClients(): Promise<void> {
    const result = await this.rpc.call<Record<string, unknown>[] | null>("admin:listClients");
    if (result !== null && !Array.isArray(result)) throw new Error("服务器列表响应格式不兼容");
    this.clients = (result ?? []).map(c => ({
      uuid: String(c.uuid ?? ""), name: cleanText(c.name) || "未命名服务器",
      ipv4: cleanText(c.ipv4, 100), ipv6: cleanText(c.ipv6, 100), group: cleanText(c.group),
    })).filter(c => /^[a-zA-Z0-9_-]{1,80}$/.test(c.uuid));
  }

  async refreshNotification(): Promise<void> {
    const settings = await this.rpc.call<Record<string, unknown>>("admin:getSettings");
    this.notification = notificationReadiness(settings);
  }

  private taskName(key: string): string { return `${PREFIX}${this.state.instance}:${key}]`; }
  private owns(task: PingTask): boolean { return task.name.startsWith(`${PREFIX}${this.state.instance}:`) && task.name.endsWith("]"); }

  async reconcile(forcePause = false): Promise<void> {
    const cfg = this.state.config;
    const active = cfg.enabled && !forcePause;
    const all = await this.rpc.call<PingTask[] | null>("admin:getAllPingTasks") ?? [];
    const owned = all.filter(t => this.owns(t));
    const desired = new Map<string, Omit<PingTask, "id">>();
    if (active) {
      for (const uuid of [...cfg.clients, ...(cfg.strict ? cfg.observers : [])]) {
        if (!this.clients.some(c => c.uuid === uuid)) throw new Error("配置中有服务器已被删除，请重新选择服务器");
      }
      for (const target of cfg.targets) desired.set(`forward:${target.id}`, {
        name: this.taskName(`forward:${target.id}`), target: target.address, type: "tcp",
        interval: cfg.intervalSeconds, clients: cfg.clients, default_on: false,
      });
      if (cfg.strict) for (const uuid of cfg.clients) {
        const client = this.clients.find(c => c.uuid === uuid)!;
        desired.set(`reverse:${uuid}`, {
          name: this.taskName(`reverse:${uuid}`), target: reverseAddress(cfg, client), type: "tcp",
          interval: cfg.intervalSeconds, clients: cfg.observers.filter(id => id !== uuid), default_on: false,
        });
      }
    }
    let sourcesChanged = false;
    const nextSources: Record<string, string> = {};
    const used = new Set<number>();
    for (const [key, want] of desired) {
      nextSources[key] = JSON.stringify({ target: want.target, clients: [...want.clients].sort(), interval: want.interval });
      if (nextSources[key] !== this.state.sources[key]) sourcesChanged = true;
      const matches = owned.filter(t => t.name === want.name).sort((a, b) => a.id - b.id);
      let task = matches.find(t => t.id === this.state.tasks[key]) ?? matches[0];
      if (!task) {
        const result = await this.rpc.call<{ task_id: number }>("admin:addPingTask", want);
        if (!Number.isInteger(result.task_id) || result.task_id <= 0) throw new Error("创建探测任务返回无效 ID");
        task = { ...want, id: result.task_id };
        sourcesChanged = true;
      } else if (task.target !== want.target || task.type !== "tcp" || task.interval !== want.interval || task.default_on || JSON.stringify([...(task.clients ?? [])].sort()) !== JSON.stringify([...want.clients].sort())) {
        await this.rpc.call("admin:editPingTask", { tasks: [{ ...task, ...want }] });
        sourcesChanged = true;
      }
      if (this.state.tasks[key] !== task.id) sourcesChanged = true;
      const mappingChanged = this.state.tasks[key] !== task.id;
      this.state.tasks[key] = task.id;
      used.add(task.id);
      // Persist each creation so an interrupted reconciliation can safely resume.
      if (mappingChanged) this.persist();
    }
    const pause = owned.filter(t => !used.has(t.id) && ((t.clients ?? []).length || t.default_on));
    if (pause.length) await this.rpc.call("admin:editPingTask", { tasks: pause.map(t => ({ ...t, clients: [], default_on: false })) });
    if (sourcesChanged) {
      this.resetMonitors();
      for (const event of this.state.events) if (event.delivery === "pending") {
        event.delivery = "superseded";
        event.lastError = "探测源变化，旧通知已取消";
      }
    }
    this.state.sources = nextSources;
    if (!active) for (const monitor of Object.values(this.state.monitors)) { monitor.health = "paused"; resetStreaks(monitor); }
    this.persist();
  }

  private resetMonitors(): void {
    const previous = this.state.monitors;
    this.state.monitors = Object.fromEntries(this.state.config.clients.map(uuid => [uuid, newMonitor(this.clock(), previous[uuid])]));
  }

  async saveConfig(raw: unknown, revision: unknown): Promise<void> {
    if (revision !== this.state.revision) throw new UserError("配置已在其它页面修改，请刷新后重试");
    const cfg = validateConfig(raw);
    await this.refreshClients();
    for (const uuid of [...cfg.clients, ...cfg.observers]) if (!this.clients.some(c => c.uuid === uuid)) throw new UserError("服务器选择包含不存在的项目");
    if (cfg.strict) for (const uuid of cfg.clients) reverseAddress(cfg, this.clients.find(c => c.uuid === uuid)!);
    const changed = detectionSignature(cfg) !== detectionSignature(this.state.config);
    this.state.config = cfg;
    this.state.revision++;
    if (changed) {
      this.resetMonitors();
      for (const event of this.state.events) if (event.delivery === "pending") { event.delivery = "superseded"; event.lastError = "检测配置变更，旧通知已取消"; }
    }
    this.persist();
    try { await this.reconcile(); this.lastError = ""; }
    catch { this.lastError = "配置已保存，但探测任务同步失败；会自动重试，请检查宿主日志与插件权限"; }
  }

  private async samples(now: number): Promise<Record<string, Record<string, Sample[]>>> {
    const cfg = this.state.config;
    const data: Record<string, Record<string, Sample[]>> = Object.fromEntries(cfg.clients.map(id => [id, {}]));
    const entities = [...new Set([...cfg.clients, ...(cfg.strict ? cfg.observers : [])])];
    const forward = new Map(cfg.targets.map(t => [String(this.state.tasks[`forward:${t.id}`]), t.id]));
    const reverse = new Map(cfg.clients.map(id => [String(this.state.tasks[`reverse:${id}`]), id]));
    for (let offset = 0; offset < entities.length; offset += 40) {
      const result = await this.rpc.call<{ series: MetricSeries[] }>("public:queryMetrics", {
        metric_keys: ["ping.latency_ms"], entity_ids: entities.slice(offset, offset + 40),
        start: new Date(now - 8 * 60000).toISOString(), end: new Date(now).toISOString(),
        fill_empty: false, max_points: 4000,
      });
      if (!Array.isArray(result.series)) throw new Error("指标查询响应不兼容");
      for (const series of result.series) {
        if (series.metric_key !== "ping.latency_ms") continue;
        for (const point of series.points ?? []) {
          const task = point.tags?.task_id ?? series.tags?.task_id ?? "";
          let uuid = series.entity_id;
          let key: string | undefined = data[uuid] ? forward.get(task) : undefined;
          if (!key && cfg.strict && reverse.has(task) && cfg.observers.includes(series.entity_id)) {
            uuid = reverse.get(task)!;
            if (uuid !== series.entity_id) key = `reverse:${series.entity_id}`;
          }
          if (!key || !data[uuid]) continue;
          if (series.downsampled !== false || (point.count !== undefined && point.count !== 1)) throw new Error("宿主返回聚合指标，等待原始采样");
          if (typeof point.value !== "number") continue;
          (data[uuid][key] ??= []).push({ at: Date.parse(point.time), value: point.value });
        }
      }
    }
    return data;
  }

  async tick(): Promise<void> {
    const now = this.clock();
    let stage = "服务器列表";
    try {
      await this.refreshClients();
      stage = "任务同步";
      await this.reconcile();
      stage = "通知配置";
      await this.refreshNotification();
      if (!this.state.config.enabled) { this.lastError = ""; return; }
      stage = "原始指标查询";
      const data = await this.samples(now);
      stage = "状态判定";
      for (const uuid of this.state.config.clients) {
        const monitor = this.state.monitors[uuid] ??= newMonitor(now);
        for (const transition of evaluate(monitor, data[uuid] ?? {}, this.state.config, uuid, now)) {
          for (const old of this.state.events) if (old.client === uuid && old.delivery === "pending") old.delivery = "superseded";
          const event: Notice = { ...transition, id: `${uuid}:${transition.type}:${transition.at}`, client: uuid, delivery: "pending", attempts: 0, nextAttemptAt: now, lastError: "" };
          if (!this.state.events.some(e => e.id === event.id)) this.state.events.push(event);
        }
      }
      this.trimHistory();
      this.lastPoll = now;
      this.lastError = "";
      this.persist();
      await this.deliver();
    } catch (error) {
      const kind = error instanceof TypeError ? "TypeError" : "Error";
      this.lastError = `${stage}失败 (${kind})，已停止连续计数；检查数据可用性、服务器选择和插件权限`;
      for (const m of Object.values(this.state.monitors)) { m.health = "unknown"; resetStreaks(m); }
      this.persist();
    }
  }

  private trimHistory(): void {
    const pending = this.state.events.filter(e => e.delivery === "pending");
    const settled = this.state.events.filter(e => e.delivery !== "pending").slice(-200);
    this.state.events = [...settled, ...pending].sort((a, b) => a.at - b.at);
  }

  async deliver(): Promise<void> {
    if (!this.notification.ready || !this.state.config.enabled) return;
    const now = this.clock();
    const due = this.state.events.filter(e => e.delivery === "pending" && e.nextAttemptAt <= now).slice(0, 5);
    for (const event of due) {
      if (event.attempts >= 5) { event.delivery = "failed"; event.lastError = "已达到发送尝试上限；上次投递结果可能未知"; this.persist(); continue; }
      const client = this.clients.find(c => c.uuid === event.client);
      if (!client || now - event.at > 86400000) { event.delivery = "failed"; event.lastError = "通知过期或服务器已删除"; this.persist(); continue; }
      event.attempts++;
      event.nextAttemptAt = now + Math.min(1800000, 30000 * 2 ** (event.attempts - 1));
      this.persist();
      try {
        await this.rpc.call("admin:sendNotification", { event: notificationEvent(event, client, this.state.config) });
        event.delivery = "sent"; event.sentAt = this.clock(); event.lastError = "";
      } catch {
        event.lastError = "系统通知发送失败，请检查渠道；网络超时后的重试可能重复投递";
        if (event.attempts >= 5) event.delivery = "failed";
      }
      this.persist();
    }
  }

  async testNotification(): Promise<void> {
    await this.refreshNotification();
    if (!this.notification.ready) throw new UserError(this.notification.reason);
    await this.rpc.call("admin:sendNotification", { event: {
      event: "GFW 测试通知", clients: [], time: new Date(this.clock()).toISOString(), emoji: "",
      message: "Komari GFW 通知通道测试。此消息不包含服务器资料，不代表发生被墙事件。",
    } });
  }

  async cleanup(): Promise<void> {
    if (this.state.config.enabled) throw new UserError("请先关闭监测再清理任务");
    const all = await this.rpc.call<PingTask[] | null>("admin:getAllPingTasks") ?? [];
    const id = all.filter(t => this.owns(t)).map(t => t.id);
    if (id.length) await this.rpc.call("admin:deletePingTask", { id });
    this.state.tasks = {};
    this.state.sources = {};
    this.persist();
  }

  settings() {
    return { config: this.state.config, revision: this.state.revision, clients: this.clients.map(c => safeClient(c, this.state.config.maskIp)), notification: this.notification, lastError: this.lastError };
  }

  snapshot() {
    const cfg = this.state.config, now = this.clock();
    const rows = cfg.clients.map(uuid => {
      const client = this.clients.find(c => c.uuid === uuid) ?? { uuid, name: "服务器已删除", ipv4: "", ipv6: "", group: "" };
      const m: Monitor = this.state.monitors[uuid] ?? newMonitor(now);
      const keys = monitorKeys(cfg, uuid);
      const stale = keys.some(k => !m.latest[k] || now - m.latest[k].at > staleAfter(cfg));
      return {
        ...safeClient(client, cfg.maskIp), alarm: m.alarm, blockedSince: m.blockedSince,
        health: !cfg.enabled ? "paused" : stale && m.health !== "initializing" ? "unknown" : m.health,
        failureStreak: m.failureStreak, recoveryStreak: m.recoveryStreak, lastRoundAt: m.lastRoundAt,
        samples: keys.map(key => {
          const sample = m.latest[key];
          return { key, name: key.startsWith("reverse:") ? safeClient(this.clients.find(c => c.uuid === key.slice(8)) ?? { uuid: "", name: "已删除探针", ipv4: "", ipv6: "", group: "" }, cfg.maskIp).name : cfg.targets.find(t => t.id === key)!.name,
            at: sample?.at ?? null, value: sample && now - sample.at <= staleAfter(cfg) ? sample.value : null };
        }),
      };
    });
    return {
      now, enabled: cfg.enabled, strict: cfg.strict, intervalSeconds: cfg.intervalSeconds,
      failureThreshold: cfg.failureThreshold, recoveryThreshold: cfg.recoveryThreshold,
      rows, targets: cfg.targets, lastPoll: this.lastPoll, lastError: this.lastError, notification: this.notification,
      events: this.state.events.slice(-100).reverse().map(e => ({ ...e, name: safeClient(this.clients.find(c => c.uuid === e.client) ?? { uuid: e.client, name: "已删除服务器", ipv4: "", ipv6: "", group: "" }, cfg.maskIp).name })),
    };
  }
}
