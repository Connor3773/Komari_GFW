"use strict";
const $ = id => document.getElementById(id);
const API = "/api/admin/plugins/komari-gfw/";

// The Komari admin lets the user pick light/dark and an accent colour at runtime.
// Both pages are same-origin iframes, so copy the live theme instead of guessing
// from the operating system preference.
const THEME_TOKENS = [
  ...[2, 3, 4, 6, 8, 9, 10, 11].map(step => `--accent-${step}`), "--accent-contrast",
  ...Array.from({ length: 12 }, (_, index) => `--gray-${index + 1}`),
  ...["red", "amber", "green"].flatMap(color => [3, 6, 9, 11].map(step => `--${color}-${step}`)),
  "--color-background", "--color-panel-solid",
];
let themeSignature = "";
function syncTheme() {
  const root = document.documentElement;
  const prefersDark = () => !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  let frame = null, style = null;
  try { frame = window.frameElement; style = frame && frame.ownerDocument.defaultView.getComputedStyle(frame); } catch { /* cross-origin embedding */ }
  if (!frame || !style) { root.dataset.theme = prefersDark() ? "dark" : "light"; return; }
  const scheme = String(style.colorScheme || "");
  const dark = /\bdark\b/.test(scheme) !== /\blight\b/.test(scheme) ? /\bdark\b/.test(scheme)
    : frame.closest(".dark, .dark-theme") ? true : frame.closest(".light, .light-theme") ? false : prefersDark();
  const values = THEME_TOKENS.map(name => style.getPropertyValue(name).trim());
  const signature = `${dark}|${values.join("|")}`;
  if (signature === themeSignature) return;
  themeSignature = signature;
  root.dataset.embedded = "true";
  root.dataset.theme = dark ? "dark" : "light";
  THEME_TOKENS.forEach((name, index) => values[index] ? root.style.setProperty(name, values[index]) : root.style.removeProperty(name));
}
function watchTheme() {
  syncTheme();
  const later = () => { setTimeout(syncTheme, 60); setTimeout(syncTheme, 400); };
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", later);
  // The host persists appearance changes; other same-origin documents get this event.
  window.addEventListener("storage", later);
  // Timers die with this document. An observer on host nodes would outlive it.
  setInterval(syncTheme, 1500);
}

const healthText = { initializing: "等待采样", healthy: "正常", suspect: "疑似被墙 · 待确认", degraded: "部分不通", outage: "全部不通", unknown: "数据不足", paused: "已暂停" };
const blockText = direction => ({ basic: "疑似被墙", forward: "疑似正向墙", reverse: "疑似反向墙", both: "疑似双向墙" }[direction] || "疑似被墙");
function eventText(event) {
  if (event.type === "recovered") return "解除被墙状态";
  const direction = event.direction || (event.reverseTotal ? "both" : "basic");
  return event.previousDirection && event.previousDirection !== direction ? `方向变化：${blockText(event.previousDirection)} → ${blockText(direction)}` : blockText(direction);
}
function observationText(row) {
  return row.health === "suspect" && row.candidateDirection ? `${blockText(row.candidateDirection)} · 待确认` : healthText[row.health];
}
const deliveryText = { pending: "通知待发送", sent: "通知已发出", failed: "通知发送失败", superseded: "通知已取消" };
// Shown next to the raw check so the entry can still be searched in docs and logs.
const checkText = {
  "Unsupported RPC envelope": "宿主返回的不是 JSON-RPC 响应",
  "Unsupported REST envelope": "宿主返回的 REST 响应格式无法识别",
  "Unsupported response JSON": "宿主返回的内容不是有效 JSON",
  "Unsupported result": "响应结构与已适配的 Komari 版本不一致",
  "Unsupported list": "响应中的列表结构无法识别",
  "Unsupported pagination": "响应带有未知的分页字段",
  "Unsupported records count/pagination": "延迟记录的数量与计数字段不一致",
  "Unsupported series count/pagination": "指标序列的数量与计数字段不一致",
  "Unsupported points count/pagination": "指标数据点的数量与计数字段不一致",
  "Unsupported stats count/pagination": "延迟统计的数量与计数字段不一致",
  "Unsupported ping record": "延迟记录的字段无法识别",
  "Unsupported task identity": "任务缺少可核对的 ID 或名称",
  "Unsupported metric key": "指标序列缺少指标名",
  "Unsupported node ping summary": "节点状态中的延迟摘要无法识别",
  "Unsupported node map": "节点状态列表的结构无法识别",
  "Ambiguous duplicate JSON key": "请求中有重复的 JSON 键，已拒绝",
  "Ambiguous RPC response": "响应同时包含结果和错误",
  "Uncorrelated RPC response": "响应无法对应到发出的请求",
  "Incomplete RPC response": "批量响应缺少部分结果",
  "Duplicate RPC response": "批量响应中有重复的 ID",
  "Ping filter batch limit exceeded": "批量请求超过可过滤的上限",
  "Ping filter correlation limit exceeded": "请求 ID 总长度超过可过滤的上限",
  "Too many pending connections": "同时等待过滤的连接过多",
  "Too many pending Ping requests": "同时等待过滤的请求过多",
  "Overlapping Ping request": "同一连接上有尚未返回的延迟请求",
  "Unsupported WebSocket frame": "无法读取的 WebSocket 消息",
};
// Problems first: the rows that need attention never hide below healthy ones.
const severity = row => row.alarm ? 0 : ({ suspect: 1, outage: 2, degraded: 3, unknown: 4, initializing: 5, healthy: 6, paused: 7 }[row.health] ?? 4);
const statusFilters = [
  ["all", "受检服务器", () => true],
  ["alarm", "告警中", row => row.alarm],
  ["healthy", "正常", row => row.health === "healthy" && !row.alarm],
  ["abnormal", "异常待确认", row => !row.alarm && ["suspect", "degraded", "outage"].includes(row.health)],
  ["unknown", "数据不足", row => !row.alarm && ["unknown", "initializing", "paused"].includes(row.health)],
];

let view;
let model;
let baseline = "";
let dirty = false;
let busy = false;
let statusFilter = "all";
let actionError = "";
let feedbackTimer;
let selectionNoticeKey = "";
let selectionAcknowledgedKey = "";
let selectionNoticeTimer;
const pendingSelectionAcknowledgments = new Set();

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
const pad = value => String(value).padStart(2, "0");
// One unambiguous format everywhere, independent of the browser locale.
function dateTime(at) {
  if (!at) return "—";
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function ago(at, now) {
  if (!at) return "—";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
function duration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`;
  return `${Math.floor(hours / 24)} 天${hours % 24 ? ` ${hours % 24} 小时` : ""}`;
}
async function api(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 65000);
  try {
    const response = await fetch(API + path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Komari-GFW": "1" }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    if (response.status === 401 || response.status === 403) throw new Error("需要管理员身份，请重新登录 Komari。");
    let result;
    try { result = await response.json(); } catch { throw new Error("插件接口不可用，请确认插件已启用。"); }
    if (!response.ok) throw new Error(result.error || "操作失败");
    return result;
  } finally { clearTimeout(timer); }
}
const errorText = error => error.name === "AbortError" ? "请求超时，操作结果未知。请刷新页面确认后再试。" : error.message;

// Standing problems reported by the service. They stay until the service clears them.
function renderWarnings(data) {
  const open = (data.visibilityDiagnostics ?? []).filter(item => item.recoveredAt == null).length;
  const lines = [actionError, data.lastError, data.retentionError,
    data.visibilityError ? `有 ${open || 1} 类接口响应暂时无法安全过滤，对应数据已被拦截。详情见页面底部的“接口过滤诊断”。` : ""].filter(Boolean);
  const box = $("message");
  box.replaceChildren(...lines.map(line => node("div", line)));
  box.hidden = !lines.length;
}
// The outcome of the last button press, next to the buttons on the settings page.
function feedback(text, kind = "") {
  const box = $("feedback");
  clearTimeout(feedbackTimer);
  if (!box) { actionError = kind === "error" ? text : ""; renderWarnings(view ?? {}); return; }
  box.textContent = text;
  box.className = "alert" + (kind ? " " + kind : "");
  box.hidden = !text;
  if (text && kind === "success") feedbackTimer = setTimeout(() => { box.hidden = true; }, 6000);
}
function noticeStatus(info) {
  const element = $("notification-status");
  const overview = document.body.dataset.page === "overview";
  element.textContent = !info ? "" : info.ready ? (overview ? "通知就绪" : "通知就绪。能否实际送达，请用测试通知确认。") : `通知未就绪：${info.reason}`;
  if (overview) element.className = info ? "pill " + (info.ready ? "good" : "warn") : "";
}
function renderVisibilityDiagnostics(data) {
  const details = $("visibility-diagnostics");
  if (!details) return;
  const rows = data.visibilityDiagnostics ?? [];
  const open = rows.filter(item => item.recoveredAt == null).length;
  details.hidden = !rows.length;
  const count = $("visibility-count");
  if (count) {
    count.textContent = open ? `${open} 项未恢复` : `${rows.length} 项，均已恢复`;
    count.className = "pill plain" + (open ? " warn" : "");
  }
  $("visibility-failures").replaceChildren(...rows.map(item => {
    const row = node("div", undefined, "diag");
    const body = node("div");
    body.append(node("span", checkText[item.check] ?? "无法安全过滤该响应"), node("code", `${item.entry} · ${item.check}`));
    const recovered = item.recoveredAt != null;
    row.append(node("span", recovered ? "已恢复" : "未恢复", "pill " + (recovered ? "good" : "warn")), body,
      node("span", `最近 ${dateTime(item.lastFailedAt)} · 累计 ${item.occurrences} 次`, "when"));
    return row;
  }));
}
function sampleText(sample) {
  if (sample?.value == null) return "—";
  if (sample.value < 0) return "不通";
  return `${Number.isInteger(sample.value) ? sample.value : sample.value.toFixed(1)} ms`;
}
function sampleClass(sample) { return sample?.value == null ? "none" : sample.value < 0 ? "bad" : "ok"; }
function sampleTitle(sample, now) { return sample?.at ? `${sample.value == null ? "结果已过期，" : ""}采样于 ${dateTime(sample.at)}（${ago(sample.at, now)}）` : "还没有采样结果"; }

function renderSelectionNotice(data) {
  const banner = $("selection-notice");
  if (!banner || !data?.selectionNotice || document.hidden || !Number.isInteger(data.selectionNoticeRevision)) return;
  const key = JSON.stringify([data.selectionNoticeRevision, data.selectionNotice]);
  if (key !== selectionNoticeKey) {
    selectionNoticeKey = key;
    banner.textContent = data.selectionNotice;
    banner.hidden = false;
    clearTimeout(selectionNoticeTimer);
    selectionNoticeTimer = setTimeout(() => { banner.hidden = true; banner.textContent = ""; }, 8000);
  }
  if (key === selectionAcknowledgedKey || pendingSelectionAcknowledgments.has(key)) return;
  pendingSelectionAcknowledgments.add(key);
  // Retry a failed acknowledgement on a later render, without showing the same notice again.
  api("ack-selection", { revision: data.selectionNoticeRevision, notice: data.selectionNotice })
    .then(() => { selectionAcknowledgedKey = key; }).catch(() => {})
    .finally(() => { pendingSelectionAcknowledgments.delete(key); });
}

function renderOverview(data) {
  view = data;
  actionError = "";
  const forwardCount = data.rows.filter(row => row.forwardEnabled).length;
  $("mode").textContent = !data.enabled ? "监测已暂停" : data.strict ? `监测中 · 正向检测 ${forwardCount}/${data.rows.length} 台` : "监测中 · 仅反向检测";
  $("mode").className = "pill " + (data.enabled ? "good" : "");
  $("schedule").textContent = `每 ${data.intervalSeconds} 秒探测 · 连续 ${data.failureThreshold} 轮异常告警，${data.recoveryThreshold} 轮正常解除`;
  $("last-poll").textContent = data.lastPoll ? `数据更新：${ago(data.lastPoll, data.now)}` : "";
  $("last-poll").title = data.lastPoll ? dateTime(data.lastPoll) : "";
  // A filter whose last server left it would show an empty table for no visible reason.
  if (!statusFilters.some(([key, , test]) => key === statusFilter && data.rows.some(test))) statusFilter = "all";
  renderStats();
  noticeStatus(data.notification);
  renderWarnings(data);
  renderVisibilityDiagnostics(data);
  renderSelectionNotice(data);
  renderRows();
  $("events").replaceChildren(...data.events.map(event => {
    const element = node("div", undefined, "event " + (event.type === "blocked" ? "blocked" : "recovered"));
    const detail = node("div");
    const evidence = Number.isInteger(event.mainland) ? `反向 ${event.mainland}/3 · 对照 ${event.overseas}/2${event.reverseTotal ? ` · 正向 ${event.reverse}/${event.reverseTotal}` : ""}` : "";
    const lasted = event.type === "recovered" && event.since ? `异常持续 ${duration(event.at - event.since)}` : "";
    const delivery = `${deliveryText[event.delivery]}${event.attempts > 1 ? `（已尝试 ${event.attempts} 次）` : ""}${event.lastError ? "：" + event.lastError : ""}`;
    detail.append(node("strong", `${event.name} · ${eventText(event)}`), node("p", [evidence, lasted, delivery].filter(Boolean).join(" · ")));
    const when = node("time", dateTime(event.at));
    when.append(node("span", ago(event.at, data.now)));
    element.append(detail, when);
    return element;
  }));
  if (!data.events.length) $("events").append(node("p", "还没有状态变更。服务器首次检测为正常时不会发送恢复通知。", "note"));
}

// The tiles double as the status filter. They are updated in place so a poll never steals focus.
function renderStats() {
  const box = $("stats");
  if (!box.children.length) box.replaceChildren(...statusFilters.map(([key, label]) => {
    const tile = node("button", undefined, "stat " + key);
    tile.type = "button";
    tile.append(node("span", label, "stat-label"), node("strong", "0"));
    tile.addEventListener("click", () => { statusFilter = statusFilter === key ? "all" : key; renderStats(); renderRows(); });
    return tile;
  }));
  for (const [index, [key, , test]] of statusFilters.entries()) {
    const tile = box.children[index], count = view.rows.filter(test).length;
    tile.className = `stat ${key}${count ? " nonzero" : ""}`;
    tile.setAttribute("aria-pressed", String(statusFilter === key));
    tile.lastElementChild.textContent = String(count);
  }
}

function renderRows() {
  if (!view) return;
  const query = $("search").value.trim().toLowerCase();
  const test = statusFilters.find(([key]) => key === statusFilter)[2];
  const rows = view.rows.filter(row => test(row) && `${row.name} ${row.group} ${row.ipv4} ${row.ipv6}`.toLowerCase().includes(query))
    .sort((a, b) => severity(a) - severity(b) || a.name.localeCompare(b.name, "zh-CN"));
  const cell = (tag, text, className, role) => { const element = node(tag, text, className); element.setAttribute("role", role); return element; };
  const reverse = view.targets.filter(target => target.id.startsWith("cn"));
  const control = view.targets.filter(target => !target.id.startsWith("cn"));
  const top = cell("tr", undefined, "", "row"), sub = cell("tr", undefined, "", "row");
  const span = (element, rows, columns) => { element.rowSpan = rows; element.colSpan = columns; return element; };
  top.append(span(cell("th", "服务器", "", "columnheader"), 2, 1), span(cell("th", "状态", "", "columnheader"), 2, 1),
    span(cell("th", "反向 · 服务器 → 大陆目标", "group", "columnheader"), 1, reverse.length),
    span(cell("th", "对照 · 非大陆目标", "group", "columnheader"), 1, control.length));
  if (view.strict) top.append(span(cell("th", "正向 · 境内探针 → 服务器", "probes", "columnheader"), 2, 1));
  top.append(span(cell("th", "最近采样", "", "columnheader"), 2, 1));
  for (const group of [reverse, control]) for (const [index, target] of group.entries()) sub.append(cell("th", target.name, "sub" + (index ? "" : " first"), "columnheader"));
  $("matrix-head").replaceChildren(top, sub);
  $("matrix").replaceChildren(...rows.map(row => {
    const tr = cell("tr", undefined, row.alarm ? "alarm" : "", "row");
    const server = cell("td", undefined, "server", "cell");
    const meta = node("div", undefined, "meta");
    meta.append(node("span", row.ipv4 !== "未登记" ? row.ipv4 : row.ipv6 || "未登记 IP", "mono"));
    if (row.group) meta.append(node("span", row.group));
    server.append(node("strong", row.name), meta);
    const status = cell("td", undefined, "status", "cell");
    const abnormal = ["suspect", "outage", "degraded"].includes(row.health);
    status.append(node("span", row.alarm ? blockText(row.alarmDirection) : observationText(row), "pill " + (row.alarm ? "bad" : row.health === "healthy" ? "good" : abnormal ? "warn" : "")));
    const details = [];
    if (row.alarm && row.blockedSince) details.push(`已持续 ${duration(view.now - row.blockedSince)}`);
    if (row.health === "suspect" && (!row.alarm || row.candidateDirection !== row.alarmDirection)) details.push(`${row.alarm ? `转为${blockText(row.candidateDirection)}，确认` : "告警确认"} ${row.failureStreak}/${view.failureThreshold}`);
    else if (row.alarm && row.health === "healthy") details.push(`恢复确认 ${row.recoveryStreak}/${view.recoveryThreshold}`);
    else if (row.alarm && row.health !== "suspect") details.push(`当前${healthText[row.health]}`);
    for (const text of details) status.append(node("div", text, "detail"));
    tr.append(server, status);
    for (const group of [reverse, control]) for (const [index, target] of group.entries()) {
      const sample = row.samples.find(item => item.key === target.id);
      const td = cell("td", sampleText(sample), `sample ${sampleClass(sample)}${index ? "" : " first"}`, "cell");
      td.dataset.label = `${group === reverse ? "反向" : "对照"} · ${target.name}`;
      td.title = sampleTitle(sample, view.now);
      tr.append(td);
    }
    if (view.strict) {
      const td = cell("td", undefined, "probes", "cell");
      td.dataset.label = "正向 · 境内探针";
      const chips = node("div", undefined, "chips");
      if (!row.forwardEnabled) chips.append(node("span", "未启用", "none"));
      for (const sample of row.samples.filter(item => item.key.startsWith("reverse:"))) {
        const chip = node("span", undefined, "chip");
        chip.append(node("b", sample.name), node("span", sampleText(sample), sampleClass(sample)));
        chip.title = sampleTitle(sample, view.now);
        chips.append(chip);
      }
      td.append(chips); tr.append(td);
    }
    const when = cell("td", row.lastRoundAt ? ago(row.lastRoundAt, view.now) : "等待采样", "when", "cell");
    when.dataset.label = "最近采样";
    when.title = row.lastRoundAt ? `最近一轮完整采样：${dateTime(row.lastRoundAt)}` : "还没有完整的一轮采样";
    tr.append(when);
    return tr;
  }));
  $("matrix").closest(".table-wrap").hidden = !rows.length;
  $("empty").hidden = rows.length > 0;
  $("empty").querySelector("h3").textContent = view.rows.length ? "没有符合条件的服务器" : "还没有受检服务器";
  $("empty").querySelector("p").textContent = view.rows.length ? "换一个关键词，或点击上方的“受检服务器”查看全部。" : "选择服务器并启用监测后，探测结果会显示在这里。";
  $("empty").querySelector("a").hidden = view.rows.length > 0;
}

function labelInput(text, input) { const label = node("label", text); label.append(input); return label; }
function targetEditor(target, index) {
  const row = node("div", undefined, "target-row");
  row.append(node("span", index < 3 ? `反向 · 大陆 ${index + 1}` : `对照 · 非大陆 ${index - 2}`, "slot"));
  const name = node("input"); name.value = target.name; name.required = true; name.maxLength = 40; name.setAttribute("aria-label", `${target.id} 目标名称`);
  const address = node("input"); address.value = target.address; address.required = true; address.maxLength = 300; address.spellcheck = false; address.className = "mono"; address.setAttribute("aria-label", `${target.id} 目标地址`);
  name.addEventListener("input", () => { target.name = name.value; });
  address.addEventListener("input", () => { target.address = address.value; });
  row.append(name, address); return row;
}
const matches = (client, query) => `${client.name} ${client.group} ${client.ipv4} ${client.ipv6}`.toLowerCase().includes(query);
function selection(client, selected, onChange) {
  const label = node("label", undefined, "choice" + (selected ? " selected" : ""));
  const checkbox = node("input"); checkbox.type = "checkbox"; checkbox.checked = selected;
  checkbox.dataset.serverId = client.uuid;
  checkbox.addEventListener("change", () => { label.className = "choice" + (checkbox.checked ? " selected" : ""); onChange(checkbox.checked); });
  const text = node("span", client.name);
  text.append(node("small", [client.group, client.ipv4 !== "未登记" ? client.ipv4 : client.ipv6].filter(Boolean).join(" · ") || "未登记 IP"));
  label.append(checkbox, text); return label;
}
function renderServerSelection() {
  const cfg = model.config;
  const strict = $("strict").checked;
  const scrollTop = $("clients").scrollTop;
  const focus = document.activeElement?.dataset;
  const focusServer = focus?.serverId, focusForward = focus?.forwardClient;
  $("selected-count").textContent = `已选 ${cfg.clients.length} / 共 ${model.clients.length} 台`;
  $("strict-options").hidden = !strict;
  $("forward-hint").hidden = !strict;
  const query = $("client-search").value.trim().toLowerCase();
  $("clients").replaceChildren(...(model.order ?? model.clients).filter(client => matches(client, query)).map(client => {
    const selected = cfg.clients.includes(client.uuid);
    const row = node("div", undefined, "client-row" + (selected ? " selected" : ""));
    row.dataset.client = client.uuid;
    row.append(selection(client, selected, checked => {
      cfg.clients = checked ? [...cfg.clients, client.uuid] : cfg.clients.filter(id => id !== client.uuid);
      if (checked) cfg.reverse[client.uuid] ??= { enabled: false, port: 0, host: "" };
      updateDirty(); renderServerSelection();
    }));
    const current = cfg.reverse[client.uuid] ?? { enabled: false, port: 0, host: "" };
    if (selected && strict) {
      const toggle = node("input"); toggle.type = "checkbox"; toggle.className = "toggle"; toggle.checked = current.enabled === true;
      toggle.dataset.forwardClient = client.uuid;
      toggle.setAttribute("aria-label", `${client.name} 启用正向检测`);
      const label = node("label", undefined, "switch per-forward");
      label.title = "由境内探针检测这台服务器";
      label.append(toggle, node("span", "正向检测")); row.append(label);
      toggle.addEventListener("change", () => {
        cfg.reverse[client.uuid] = { ...current, ...cfg.reverse[client.uuid], enabled: toggle.checked };
        updateDirty(); renderServerSelection();
      });
    }
    if (selected && strict && current.enabled === true) {
      const fields = node("div", undefined, "reverse-fields");
      const port = node("input"); port.type = "number"; port.min = "1"; port.max = "65535"; port.required = true; port.placeholder = "如 443"; port.value = current.port || "";
      const host = node("input"); host.placeholder = "留空使用登记 IP"; host.value = current.host; host.maxLength = 253; host.spellcheck = false;
      port.setAttribute("aria-label", `${client.name} 测试端口`); host.setAttribute("aria-label", `${client.name} 测试地址`);
      port.addEventListener("input", () => { cfg.reverse[client.uuid] = { ...current, ...cfg.reverse[client.uuid], port: Number(port.value) }; });
      host.addEventListener("input", () => { cfg.reverse[client.uuid] = { ...current, ...cfg.reverse[client.uuid], host: host.value }; });
      fields.append(labelInput("测试端口", port), labelInput("测试地址（可选）", host)); row.append(fields);
    }
    return row;
  }));
  if (!model.clients.length) $("clients").append(node("p", "Komari 中还没有服务器。", "note"));
  else if (!$("clients").children.length) $("clients").append(node("p", "没有匹配的服务器", "note"));
  $("clients").scrollTop = scrollTop;
  const focusTarget = focusForward ? $("clients").querySelector(`[data-forward-client="${focusForward}"]`) : focusServer ? $("clients").querySelector(`[data-server-id="${focusServer}"]`) : null;
  focusTarget?.focus({ preventScroll: true });
  renderObserverSelection();
}
function renderObserverSelection() {
  const cfg = model.config;
  const query = $("observer-search").value.trim().toLowerCase();
  const clients = (model.observerOrder ?? model.clients).filter(client => matches(client, query));
  $("observer-count").textContent = `已选 ${cfg.observers.length} 台`;
  $("observers").replaceChildren(...clients.map(client => selection(client, cfg.observers.includes(client.uuid), checked => {
    cfg.observers = checked ? [...cfg.observers, client.uuid] : cfg.observers.filter(id => id !== client.uuid);
    $("observer-count").textContent = `已选 ${cfg.observers.length} 台`;
    updateDirty();
  })));
  if (!clients.length) $("observers").append(node("p", "没有匹配的境内探针", "muted small"));
}
// What "保存配置" sends. Also the basis of the unsaved-changes check, so undoing an edit clears it.
function collect() {
  const cfg = model.config;
  const clients = [...cfg.clients].sort();
  return { ...cfg, clients, observers: [...cfg.observers].sort(),
    reverse: Object.fromEntries(clients.filter(id => cfg.reverse[id]).map(id => [id, cfg.reverse[id]])),
    enabled: $("enabled").checked, maskIp: $("mask").checked, strict: $("strict").checked,
    intervalSeconds: Number($("interval").value), failureThreshold: Number($("failure").value),
    recoveryThreshold: Number($("recovery").value), overseasRequired: Number($("overseas").value) };
}
function updateDirty() {
  if (!model) return;
  dirty = JSON.stringify(collect()) !== baseline;
  $("dirty").textContent = dirty ? "有未保存的更改" : "所有更改已保存";
  $("dirty").className = "state" + (dirty ? " dirty" : "");
  $("discard").hidden = !dirty;
}
function renderSettings(data) {
  model = data;
  const cfg = data.config;
  // Selected servers lead the lists once per load; editing never reorders rows under the pointer.
  const selectedFirst = ids => [...data.clients].sort((a, b) => Number(ids.includes(b.uuid)) - Number(ids.includes(a.uuid)));
  model.order = selectedFirst(cfg.clients);
  model.observerOrder = selectedFirst(cfg.observers);
  $("enabled").checked = cfg.enabled; $("mask").checked = cfg.maskIp; $("strict").checked = cfg.strict;
  $("interval").value = cfg.intervalSeconds; $("failure").value = cfg.failureThreshold; $("recovery").value = cfg.recoveryThreshold; $("overseas").value = cfg.overseasRequired;
  const head = node("div", undefined, "target-row head");
  head.append(node("span", "用途"), node("span", "名称"), node("span", "地址:端口"));
  $("targets").replaceChildren(head, ...cfg.targets.map(targetEditor));
  renderServerSelection(); noticeStatus(data.notification);
  $("settings-fields").disabled = false;
  baseline = JSON.stringify(collect());
  updateDirty();
  renderWarnings(data);
  renderVisibilityDiagnostics(data);
  renderSelectionNotice(data);
}

async function action(button, callback) {
  if (busy) return;
  busy = true; button.disabled = true; button.setAttribute("aria-busy", "true");
  try { await callback(); } catch (error) { feedback(errorText(error), "error"); }
  finally { busy = false; button.disabled = false; button.removeAttribute("aria-busy"); }
}

async function startOverview() {
  $("search").addEventListener("input", renderRows);
  $("refresh").addEventListener("click", () => action($("refresh"), async () => renderOverview(await api("refresh", {}))));
  // Background polling never touches the button, so the page does not flicker every 10 seconds.
  const poll = async () => {
    if (busy || document.hidden) return;
    try { renderOverview(await api("overview")); } catch (error) { feedback(errorText(error), "error"); }
  };
  document.addEventListener("visibilitychange", poll);
  await poll();
  setInterval(poll, 10000);
}
async function startSettings() {
  const form = $("settings-form");
  form.addEventListener("input", updateDirty);
  form.addEventListener("change", updateDirty);
  $("strict").addEventListener("change", renderServerSelection);
  $("client-search").addEventListener("input", renderServerSelection);
  $("observer-search").addEventListener("input", renderObserverSelection);
  for (const id of ["client-search", "observer-search"]) $(id).addEventListener("keydown", event => { if (event.key === "Enter") event.preventDefault(); });
  // Bulk actions follow the current search, so "全选" after filtering by group selects that group.
  const visible = () => { const query = $("client-search").value.trim().toLowerCase(); return model.clients.filter(client => matches(client, query)).map(client => client.uuid); };
  $("select-all").addEventListener("click", () => {
    const cfg = model.config;
    for (const id of visible()) if (!cfg.clients.includes(id)) { cfg.clients.push(id); cfg.reverse[id] ??= { enabled: false, port: 0, host: "" }; }
    updateDirty(); renderServerSelection();
  });
  $("select-none").addEventListener("click", () => {
    const hidden = new Set(visible());
    model.config.clients = model.config.clients.filter(id => !hidden.has(id));
    updateDirty(); renderServerSelection();
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    action($("save"), async () => {
      renderSettings(await api("settings", { config: collect(), revision: model.revision }));
      if (model.lastError) feedback(model.lastError);
      else feedback("配置已保存，探测任务已同步。", "success");
    });
  });
  $("discard").addEventListener("click", () => action($("discard"), async () => {
    renderSettings(await api("settings"));
    feedback("已恢复为上次保存的配置。", "success");
  }));
  $("test-notification").addEventListener("click", () => action($("test-notification"), async () => {
    await api("test-notification", {});
    feedback("测试通知已发出，请到接收端确认是否送达。", "success");
  }));
  // Destructive, so the button asks for a second press instead of a browser dialog.
  const cleanup = $("cleanup"), cleanupLabel = cleanup.textContent;
  let cleanupTimer;
  const disarm = () => { clearTimeout(cleanupTimer); cleanup.classList.remove("armed"); cleanup.textContent = cleanupLabel; };
  cleanup.addEventListener("click", () => {
    if (!cleanup.classList.contains("armed")) {
      cleanup.classList.add("armed"); cleanup.textContent = "再点一次确认清理（不可撤销）";
      cleanupTimer = setTimeout(disarm, 6000);
      return;
    }
    disarm();
    action(cleanup, async () => { await api("cleanup", { confirm: "DELETE_PLUGIN_TASKS" }); feedback("插件任务已清理，其它任务未受影响。", "success"); });
  });
  window.addEventListener("beforeunload", event => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) api("overview").then(renderSelectionNotice).catch(() => {});
  });
  try { renderSettings(await api("settings")); }
  catch (error) { $("dirty").textContent = "配置加载失败"; feedback(errorText(error), "error"); }
  // Keep standing warnings and diagnostics current without touching the form being edited.
  setInterval(() => {
    if (document.hidden || busy || !model) return;
    api("overview").then(data => { renderWarnings(data); renderVisibilityDiagnostics(data); }).catch(() => {});
  }, 10000);
}
function start() {
  watchTheme();
  const run = () => (document.body.dataset.page === "overview" ? startOverview() : startSettings());
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
}
start();
