import { SLOTS } from "./types.ts";
import type { Client, Config, ReverseTarget, Target } from "./types.ts";
import { UserError as Error } from "./errors.ts";

export function defaultConfig(): Config {
  return {
    enabled: false, intervalSeconds: 60, failureThreshold: 3, recoveryThreshold: 3,
    overseasRequired: 1, maskIp: true, clients: [], strict: false, observers: [], reverse: {},
    targets: [
      { id: "cn1", name: "广东电信", address: "gd-ct-v4.ip.zstaticcdn.com:80" },
      { id: "cn2", name: "广东联通", address: "gd-cu-v4.ip.zstaticcdn.com:80" },
      { id: "cn3", name: "广东移动", address: "gd-cm-v4.ip.zstaticcdn.com:80" },
      { id: "global1", name: "Cloudflare", address: "1.1.1.1:443" },
      { id: "global2", name: "Quad9", address: "9.9.9.9:443" },
    ],
  };
}

export function cleanText(value: unknown, max = 100): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "";
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置格式无效");
  return value as Record<string, unknown>;
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name}必须为开关值`);
  return value;
}
function integer(value: unknown, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name}必须为 ${min} 至 ${max} 的整数`);
  }
  return value as number;
}
function ids(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) {
    throw new Error(`服务器列表无效，最多 ${max} 台`);
  }
  return [...new Set(value as string[])].sort();
}

export function normalizeHost(raw: string): string {
  let host = raw.trim();
  if (!host || /[\s\/@?#\\%]/.test(host)) throw new Error("主机地址不能包含协议、路径、凭据或空格");
  if (host.includes(":")) {
    if (!host.startsWith("[")) host = `[${host}]`;
    try {
      const url = new URL(`http://${host}/`);
      if (!url.hostname.startsWith("[") || url.port) throw new Error();
      return url.hostname.toLowerCase();
    } catch { throw new Error("IPv6 地址无效"); }
  }
  if (/^[0-9.]+$/.test(host)) {
    const parts = host.split(".");
    if (parts.length !== 4 || parts.some(p => !/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255)) throw new Error("IPv4 地址无效");
    return host;
  }
  try { host = new URL(`http://${host}/`).hostname.toLowerCase().replace(/\.$/, ""); }
  catch { throw new Error("域名无效"); }
  if (host.length > 253 || host.split(".").some(p => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))) throw new Error("域名无效");
  return host;
}

export function normalizeAddress(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 300) throw new Error("请输入 IP 或域名加端口");
  const value = raw.trim();
  const match = /^(\[[^\]]+\]|[^:]+):([0-9]+)$/.exec(value);
  if (!match) throw new Error("目标格式应为域名:端口、IPv4:端口或 [IPv6]:端口");
  const port = integer(Number(match[2]), 1, 65535, "端口");
  return `${normalizeHost(match[1])}:${port}`;
}

export function validateConfig(raw: unknown, available?: ReadonlySet<string>): Config {
  const v = object(raw);
  if (!Array.isArray(v.targets) || v.targets.length !== 5) throw new Error("必须配置 3 个大陆和 2 个非大陆目标");
  const targets: Target[] = SLOTS.map(id => {
    const item = object((v.targets as unknown[]).find(t => (t as Target)?.id === id));
    const name = cleanText(item.name, 40).trim();
    if (!name) throw new Error("目标名称不能为空");
    return { id, name, address: normalizeAddress(item.address) };
  });
  if (new Set(targets.map(t => t.address)).size !== 5) throw new Error("5 个探测目标不能重复");
  let clients = ids(v.clients, 200);
  let observers = ids(v.observers, 20);
  const legacyStrict = bool(v.strict, "正向检测全局开关");
  let strict = legacyStrict;
  let enabled = bool(v.enabled, "监测总开关");
  if (available) {
    const remaining = clients.filter(id => available.has(id));
    const probes = observers.filter(id => available.has(id));
    // A confirmed deletion changes the selected topology, not the Ping results.
    if (probes.length !== observers.length) strict = false;
    if (clients.length && !remaining.length) enabled = false;
    clients = remaining;
    observers = probes;
  }
  const reverse: Record<string, ReverseTarget> = {};
  const inputs = object(v.reverse);
  for (const uuid of clients) {
    const item = inputs[uuid] === undefined ? {} : object(inputs[uuid]);
    const forward = item.enabled === undefined ? legacyStrict : bool(item.enabled, "服务器正向检测");
    const active = strict && forward;
    const host = typeof item.host === "string" ? item.host.trim() : "";
    if (host.length > 300) throw new Error("测试地址过长");
    const port = item.port == null ? 0 : integer(item.port, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "测试端口");
    reverse[uuid] = { enabled: forward, port: active ? integer(port, 1, 65535, "测试端口") : port, host: active && host ? normalizeHost(host) : host };
    if (active && !observers.some(id => id !== uuid)) throw new Error("开启正向检测的服务器至少需要一个不同于自身的境内探针");
  }
  if (enabled && clients.length === 0) throw new Error("开启监测前请先选择服务器");
  return {
    enabled, strict, clients, observers, reverse, targets,
    intervalSeconds: integer(v.intervalSeconds, 30, 300, "检测间隔"),
    failureThreshold: integer(v.failureThreshold, 1, 10, "告警确认次数"),
    recoveryThreshold: integer(v.recoveryThreshold, 1, 10, "恢复确认次数"),
    overseasRequired: integer(v.overseasRequired, 1, 2, "非大陆成功数"),
    maskIp: bool(v.maskIp, "IP 脱敏"),
  };
}

export function reverseAddress(config: Config, client: Client): string {
  const target = config.reverse[client.uuid];
  if (!target) throw new Error("缺少测试端口");
  const host = target.host || client.ipv4 || client.ipv6;
  if (!host) throw new Error("正向检测需要服务器 IP 或手动填写测试地址");
  return normalizeAddress(`${normalizeHost(host)}:${target.port}`);
}

export function monitorKeys(config: Config, uuid: string): string[] {
  return [...SLOTS, ...(forwardEnabled(config, uuid) ? config.observers.filter(id => id !== uuid).map(id => `reverse:${id}`) : [])];
}

export function forwardEnabled(config: Config, uuid: string): boolean {
  // Missing per-server switches in legacy strict configurations mean enabled.
  return config.strict && config.clients.includes(uuid) && config.reverse[uuid]?.enabled !== false;
}

export function detectionSignature(config: Config, uuid: string): string {
  return JSON.stringify({ enabled: config.enabled, interval: config.intervalSeconds, failure: config.failureThreshold,
    recovery: config.recoveryThreshold, overseas: config.overseasRequired,
    targets: config.targets.map(t => ({ id: t.id, address: t.address })),
    forward: forwardEnabled(config, uuid) ? { target: config.reverse[uuid], observers: config.observers.filter(id => id !== uuid) } : null });
}
