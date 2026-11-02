import type { Client, Config, Notice } from "./types.ts";

export function maskAddress(ip: string, enabled: boolean): string {
  if (!ip) return "未登记";
  if (!enabled) return ip;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return ip.split(".").slice(0, 2).join(".") + ".*.*";
  if (ip.includes(":")) {
    const parts = ip.replace(/^\[|\]$/g, "").split("::");
    const left = parts[0] ? parts[0].split(":") : [];
    const right = parts[1] ? parts[1].split(":") : [];
    const full = parts.length === 2 ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
    return full.slice(0, 4).join(":") + ":*:*:*:*";
  }
  return "[已隐藏]";
}

export function safeClient(client: Client, mask: boolean): Client {
  let name = client.name;
  let group = client.group;
  if (mask) {
    for (const ip of [client.ipv4, client.ipv6].filter(Boolean)) {
      name = name.split(ip).join(maskAddress(ip, true));
      group = group.split(ip).join(maskAddress(ip, true));
    }
  }
  return { uuid: client.uuid, name, group, ipv4: maskAddress(client.ipv4, mask), ipv6: client.ipv6 ? maskAddress(client.ipv6, mask) : "" };
}

export function notificationEvent(event: Notice, client: Client, config: Config) {
  const safe = safeClient(client, config.maskIp);
  const blocked = event.type === "blocked";
  const lines = [
    `服务器：${safe.name}`,
    `IP：${client.ipv4 ? safe.ipv4 : safe.ipv6 || "未登记"}`,
    `被墙状态：${blocked ? "疑似被墙" : "已解除"}`,
    `探测结果：大陆 ${event.mainland}/3 可达，非大陆 ${event.overseas}/2 可达`,
    ...(event.reverseTotal ? [`严格模式：反向 ${event.reverse}/${event.reverseTotal} 可达`] : []),
    ...(!blocked ? [`异常持续：${Math.max(0, Math.round((event.at - event.since) / 60000))} 分钟`] : []),
    `检测时间：${new Date(event.at).toISOString()}`,
    "说明：TCP 连通性推断，不代表封锁原因已确证。",
  ];
  return {
    event: blocked ? "GFW 疑似被墙" : "GFW 解除被墙状态",
    clients: [], time: new Date(event.at).toISOString(), message: lines.join("\n"), emoji: "",
  };
}
