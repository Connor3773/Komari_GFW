"use strict";
const $ = id => document.getElementById(id);
const API = "/api/admin/plugins/komari-gfw/";
const healthText = { initializing: "等待采样", healthy: "正常", suspect: "疑似被墙条件", degraded: "部分异常", outage: "全部失败", unknown: "数据不足", paused: "已暂停" };
const blockText = direction => ({ basic: "疑似被墙", forward: "疑似正向墙", reverse: "疑似反向墙", both: "疑似双向墙" }[direction] || "疑似被墙");
function eventText(event) {
  if (event.type === "recovered") return "解除被墙状态";
  const direction = event.direction || (event.reverseTotal ? "both" : "basic");
  return event.previousDirection && event.previousDirection !== direction ? `方向变化：${blockText(event.previousDirection)} → ${blockText(direction)}` : blockText(direction);
}
function observationText(row) {
  return row.health === "suspect" && row.candidateDirection ? `${blockText(row.candidateDirection)}条件` : healthText[row.health];
}
const deliveryText = { pending: "等待投递", sent: "已交给通知渠道", failed: "投递失败", superseded: "已取消旧通知" };
let view;
let model;
let dirty = false;
let busy = false;
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
function showMessage(text, success = false) {
  $("message").textContent = text;
  $("message").hidden = !text;
  $("message").className = "message" + (success ? " success" : "");
}
function time(at) { return at ? new Date(at).toLocaleString(undefined, { hour12: false }) : "等待采样"; }
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
function noticeStatus(info) {
  $("notification-status").textContent = info ? `${info.ready ? "通知就绪" : "通知未就绪"} · ${info.reason}` : "通知状态未知";
}
function sampleText(sample) { return sample?.value == null ? "无数据" : sample.value < 0 ? "不通" : `${sample.value} ms`; }
function sampleClass(sample) { return sample?.value == null ? "sample-unknown" : sample.value < 0 ? "sample-bad" : "sample-ok"; }

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
  const forwardCount = data.rows.filter(row => row.forwardEnabled).length;
  $("mode").textContent = !data.enabled ? "监测已暂停" : data.strict ? `反向检测 · 正向 ${forwardCount}/${data.rows.length} 台` : "仅反向检测 · 正向全局关闭";
  $("mode").className = "pill " + (data.enabled ? "good" : "");
  $("schedule").textContent = `每 ${data.intervalSeconds} 秒 · 告警 ${data.failureThreshold} 次 / 恢复 ${data.recoveryThreshold} 次`;
  $("last-poll").textContent = "上次采集 " + time(data.lastPoll);
  const count = predicate => data.rows.filter(predicate).length;
  const stats = [["监测服务器", data.rows.length, ""], ["未解除告警", count(r => r.alarm), "alarm"], ["正常", count(r => r.health === "healthy" && !r.alarm), "ok"], ["异常 / 待确认", count(r => !r.alarm && ["suspect", "degraded", "outage"].includes(r.health)), ""], ["数据不足 / 暂停", count(r => ["unknown", "initializing", "paused"].includes(r.health)), ""]];
  $("stats").replaceChildren(...stats.map(([label, value, cls]) => { const el = node("div", undefined, "stat " + cls); el.append(node("strong", String(value)), node("span", label)); return el; }));
  noticeStatus(data.notification);
  showMessage([data.lastError, data.retentionError, data.visibilityError].filter(Boolean).join(" "));
  renderSelectionNotice(data);
  renderRows();
  $("events").replaceChildren(...data.events.map(event => {
    const el = node("div", undefined, "event");
    const detail = node("div");
    const title = node("strong", `${event.name} · ${eventText(event)}`);
    title.className = event.type === "blocked" ? "sample-bad" : "sample-ok";
    detail.append(title, node("p", `${deliveryText[event.delivery]}${event.attempts ? ` · 尝试 ${event.attempts} 次` : ""}${event.lastError ? " · " + event.lastError : ""}`));
    el.append(detail, node("time", time(event.at)));
    return el;
  }));
  if (!data.events.length) $("events").append(node("p", "还没有状态变更。首次正常不会发送恢复通知。", "note"));
}

function renderRows() {
  if (!view) return;
  const query = $("search").value.trim().toLowerCase();
  const filter = $("filter").value;
  const rows = view.rows.filter(row => {
    if (!`${row.name} ${row.group} ${row.ipv4} ${row.ipv6}`.toLowerCase().includes(query)) return false;
    if (filter === "alarm") return row.alarm;
    if (filter === "healthy") return row.health === "healthy" && !row.alarm;
    if (filter === "abnormal") return ["suspect", "degraded", "outage"].includes(row.health);
    if (filter === "unknown") return ["unknown", "initializing"].includes(row.health);
    return true;
  });
  const header = node("tr");
  for (const name of ["服务器", "当前状态", ...view.targets.map(t => `${t.id.startsWith("cn") ? "反向" : "对照"} · ${t.name}`), ...(view.strict ? ["正向探针（大陆出发）"] : []), "完整采样时间"]) header.append(node("th", name));
  $("matrix-head").replaceChildren(header);
  $("matrix").replaceChildren(...rows.map(row => {
    const tr = node("tr");
    const server = node("td", undefined, "server");
    server.append(node("strong", row.name), node("small", row.ipv4 !== "未登记" ? row.ipv4 : row.ipv6 || "未登记", "mono"));
    if (row.group) server.append(node("small", row.group));
    server.append(node("small", row.forwardEnabled ? "反向 + 正向" : "仅反向检测"));
    const status = node("td");
    status.append(node("span", row.alarm ? blockText(row.alarmDirection) : observationText(row), "pill " + (row.alarm ? "bad" : row.health === "healthy" ? "good" : ["suspect", "outage", "degraded"].includes(row.health) ? "warn" : "")));
    if (row.alarm) status.append(node("div", row.health === "suspect" && row.candidateDirection === row.alarmDirection ? "告警未解除" : `告警未解除 · ${observationText(row)}`, "small muted"));
    if (row.health === "suspect" && (!row.alarm || row.candidateDirection !== row.alarmDirection)) status.append(node("div", `${row.alarm ? "方向变更" : "告警"}确认 ${row.failureStreak}/${view.failureThreshold}`, "small muted"));
    if (row.alarm && row.health === "healthy") status.append(node("div", `恢复确认 ${row.recoveryStreak}/${view.recoveryThreshold}`, "small muted"));
    tr.append(server, status);
    for (const target of view.targets) {
      const sample = row.samples.find(s => s.key === target.id);
      const td = node("td", sampleText(sample), "sample mono " + sampleClass(sample));
      td.title = sample?.at ? time(sample.at) : "没有新鲜采样";
      tr.append(td);
    }
    if (view.strict) {
      const td = node("td");
      const probes = node("div", undefined, "reverse-samples");
      if (!row.forwardEnabled) probes.append(node("span", "未启用", "muted"));
      for (const sample of row.samples.filter(s => s.key.startsWith("reverse:"))) {
        const chip = node("span", `${sample.name} ${sampleText(sample)}`, sampleClass(sample));
        chip.title = time(sample.at); probes.append(chip);
      }
      td.append(probes); tr.append(td);
    }
    tr.append(node("td", time(row.lastRoundAt), "muted"));
    return tr;
  }));
  $("empty").hidden = rows.length > 0;
  $("empty").querySelector("h3").textContent = view.rows.length ? "没有匹配的服务器" : "还没有监测数据";
}

function labelInput(text, input) { const label = node("label", text); label.append(input); return label; }
function markDirty() { dirty = true; $("dirty").textContent = "有未保存的更改"; }
function targetEditor(target, index) {
  const row = node("div", undefined, "target-row");
  row.append(node("span", index < 3 ? `反向 · 大陆 ${index + 1}` : `对照 · 非大陆 ${index - 2}`));
  const name = node("input"); name.value = target.name; name.required = true; name.maxLength = 40; name.setAttribute("aria-label", `${target.id} 目标名称`);
  const address = node("input"); address.value = target.address; address.required = true; address.maxLength = 300; address.spellcheck = false; address.setAttribute("aria-label", `${target.id} 目标地址`);
  name.addEventListener("input", () => { target.name = name.value; });
  address.addEventListener("input", () => { target.address = address.value; });
  row.append(name, address); return row;
}
function selection(client, selected, onChange) {
  const label = node("label", undefined, "choice");
  const checkbox = node("input"); checkbox.type = "checkbox"; checkbox.checked = selected;
  checkbox.dataset.serverId = client.uuid;
  checkbox.addEventListener("change", () => onChange(checkbox.checked));
  const text = node("span", client.name); text.append(node("small", client.group || client.ipv4 || "未分组"));
  label.append(checkbox, text); return label;
}
function renderServerSelection() {
  const cfg = model.config;
  const scrollTop = $("clients").scrollTop;
  const focus = document.activeElement?.dataset;
  const focusServer = focus?.serverId, focusForward = focus?.forwardClient;
  $("selected-count").textContent = `(${cfg.clients.length})`;
  $("strict-options").hidden = !$("strict").checked;
  const query = $("client-search").value.trim().toLowerCase();
  $("clients").replaceChildren(...model.clients.filter(c => `${c.name} ${c.group} ${c.ipv4} ${c.ipv6}`.toLowerCase().includes(query)).map(client => {
    const row = node("div", undefined, "client-row");
    row.dataset.client = client.uuid;
    const selected = cfg.clients.includes(client.uuid);
    row.append(selection(client, selected, checked => {
      cfg.clients = checked ? [...cfg.clients, client.uuid] : cfg.clients.filter(id => id !== client.uuid);
      if (checked) cfg.reverse[client.uuid] ??= { enabled: false, port: 0, host: "" };
      markDirty(); renderServerSelection();
    }));
    const current = cfg.reverse[client.uuid] ?? { enabled: false, port: 0, host: "" };
    if (selected && $("strict").checked) {
      const toggle = node("input"); toggle.type = "checkbox"; toggle.checked = current.enabled === true;
      toggle.dataset.forwardClient = client.uuid;
      toggle.setAttribute("aria-label", `${client.name} 启用正向检测`);
      const label = node("label", undefined, "switch per-forward");
      label.title = "由境内探针检测本服务器";
      label.append(toggle, node("span", "正向检测")); row.append(label);
      toggle.addEventListener("change", () => {
        cfg.reverse[client.uuid] = { ...current, ...cfg.reverse[client.uuid], enabled: toggle.checked };
        markDirty(); renderServerSelection();
      });
    }
    if (selected && $("strict").checked && current.enabled === true) {
      const fields = node("div", undefined, "reverse-fields");
      const port = node("input"); port.type = "number"; port.min = "1"; port.max = "65535"; port.required = true; port.placeholder = "例如 443"; port.value = current.port || "";
      const host = node("input"); host.placeholder = "留空使用登记 IP"; host.value = current.host; host.maxLength = 253; host.spellcheck = false;
      port.setAttribute("aria-label", `${client.name} 测试端口`); host.setAttribute("aria-label", `${client.name} 测试地址`);
      port.addEventListener("input", () => { cfg.reverse[client.uuid] = { ...current, ...cfg.reverse[client.uuid], port: Number(port.value) }; });
      host.addEventListener("input", () => { cfg.reverse[client.uuid] = { ...current, ...cfg.reverse[client.uuid], host: host.value }; });
      fields.append(labelInput("测试端口", port), labelInput("测试地址（可选）", host)); row.append(fields);
    }
    return row;
  }));
  if (!model.clients.length) $("clients").append(node("p", "Komari 中还没有可选择的服务器。", "note"));
  else if (!$("clients").children.length) $("clients").append(node("p", "没有匹配的服务器", "note"));
  $("clients").scrollTop = scrollTop;
  const focusTarget = focusForward ? $("clients").querySelector(`[data-forward-client="${focusForward}"]`) : focusServer ? $("clients").querySelector(`[data-server-id="${focusServer}"]`) : null;
  focusTarget?.focus({ preventScroll: true });
  renderObserverSelection();
}
function renderObserverSelection() {
  const query = $("observer-search").value.trim().toLowerCase();
  const clients = model.clients.filter(c => `${c.name} ${c.group} ${c.ipv4} ${c.ipv6}`.toLowerCase().includes(query));
  $("observers").replaceChildren(...clients.map(client => selection(client, model.config.observers.includes(client.uuid), checked => {
    model.config.observers = checked ? [...model.config.observers, client.uuid] : model.config.observers.filter(id => id !== client.uuid);
    markDirty();
  })));
  if (!clients.length) $("observers").append(node("p", "没有匹配的境内探针", "muted small"));
}
function renderSettings(data) {
  model = data;
  const cfg = data.config;
  $("enabled").checked = cfg.enabled; $("mask").checked = cfg.maskIp; $("strict").checked = cfg.strict;
  $("interval").value = cfg.intervalSeconds; $("failure").value = cfg.failureThreshold; $("recovery").value = cfg.recoveryThreshold; $("overseas").value = cfg.overseasRequired;
  $("targets").replaceChildren(...cfg.targets.map(targetEditor));
  renderServerSelection(); noticeStatus(data.notification);
  $("settings-fields").disabled = false;
  dirty = false; $("dirty").textContent = "所有更改已保存";
  showMessage([data.lastError, data.retentionError, data.visibilityError].filter(Boolean).join(" "));
  renderSelectionNotice(data);
}

async function action(button, callback) {
  if (busy) return;
  busy = true; button.disabled = true;
  try { await callback(); } catch (error) { showMessage(error.name === "AbortError" ? "请求超时，操作结果未知。请刷新确认后再试。" : error.message); }
  finally { busy = false; button.disabled = false; }
}

async function start() {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) api("overview").then(renderSelectionNotice).catch(() => {});
  });
  if (document.body.dataset.page === "overview") {
    $("search").addEventListener("input", renderRows); $("filter").addEventListener("change", renderRows);
    $("refresh").addEventListener("click", () => action($("refresh"), async () => renderOverview(await api("refresh", {}))));
    const refresh = () => action($("refresh"), async () => renderOverview(await api("overview")));
    await refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 10000);
  } else {
    $("settings-form").addEventListener("input", markDirty);
    $("settings-form").addEventListener("change", markDirty);
    $("strict").addEventListener("change", renderServerSelection);
    $("client-search").addEventListener("input", event => { event.stopPropagation(); renderServerSelection(); });
    $("observer-search").addEventListener("input", event => { event.stopPropagation(); renderObserverSelection(); });
    for (const id of ["client-search", "observer-search"]) $(id).addEventListener("change", event => event.stopPropagation());
    for (const id of ["client-search", "observer-search"]) $(id).addEventListener("keydown", event => { if (event.key === "Enter") event.preventDefault(); });
    $("settings-form").addEventListener("submit", event => {
      event.preventDefault();
      action($("save"), async () => {
        const config = { ...model.config, enabled: $("enabled").checked, maskIp: $("mask").checked, strict: $("strict").checked, intervalSeconds: Number($("interval").value), failureThreshold: Number($("failure").value), recoveryThreshold: Number($("recovery").value), overseasRequired: Number($("overseas").value) };
        renderSettings(await api("settings", { config, revision: model.revision }));
        const warning = [model.lastError, model.retentionError, model.visibilityError].filter(Boolean).join(" ");
        showMessage(warning || "配置已保存，探测任务已同步。", !warning);
      });
    });
    $("test-notification").addEventListener("click", () => action($("test-notification"), async () => { await api("test-notification", {}); showMessage("测试消息已交给系统通知渠道，请检查接收端。", true); }));
    $("cleanup").addEventListener("click", () => {
      if (!confirm("删除本插件拥有的所有探测任务和探测历史？请先保存关闭监测。此操作不可撤销。")) return;
      action($("cleanup"), async () => { await api("cleanup", { confirm: "DELETE_PLUGIN_TASKS" }); showMessage("插件任务已清理，其它任务未修改。", true); });
    });
    window.addEventListener("beforeunload", event => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
    try { renderSettings(await api("settings")); } catch (error) { showMessage(error.message); }
  }
}
start();
