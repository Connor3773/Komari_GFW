import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { CHECKS } from "../src/visibility.ts";

const source = readFileSync(new URL("../pages/app.js", import.meta.url), "utf8");
assert.match(source, /\nstart\(\);\s*$/);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const data = (revision = 1) => ({ selectionNotice: "Selection adjusted", selectionNoticeRevision: revision });

function fixture() {
  const banner = { hidden: true, textContent: "" };
  const error = { hidden: false, textContent: "Real synchronization error" };
  const calls: { path: string; body: unknown }[] = [];
  const timers = new Map<number, { fn: () => void; delay: number }>();
  let timerId = 0, fail = false;
  const document = { hidden: false, getElementById: (id: string) => id === "selection-notice" ? banner : error };
  const context = createContext({ document,
    setTimeout(fn: () => void, delay: number) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  // Execute the shipped UI functions, but leave startup/network/DOM rendering to the host test.
  runInContext(source.replace(/\nstart\(\);\s*$/, "\n"), context);
  context.api = async (path: string, body: unknown) => {
    calls.push({ path, body: JSON.parse(JSON.stringify(body)) });
    if (fail) throw new Error("Network unavailable");
    return { ok: true };
  };
  return { banner, error, calls, timers, document, context, render: (value: unknown) => context.renderSelectionNotice(value),
    fail: (value: boolean) => { fail = value; },
    expire: () => { const jobs = [...timers.values()]; timers.clear(); for (const timer of jobs) timer.fn(); },
  };
}

test("overview distinguishes directional, pending and legacy event labels", () => {
  const { context } = fixture();
  for (const [direction, text] of [["forward", "疑似正向墙"], ["reverse", "疑似反向墙"], ["both", "疑似双向墙"], ["basic", "疑似被墙"]]) {
    assert.equal(context.eventText({ type: "blocked", direction }), text);
    assert.equal(context.observationText({ health: "suspect", candidateDirection: direction }), `${text} · 待确认`);
  }
  assert.equal(context.eventText({ type: "blocked", direction: "forward", previousDirection: "reverse" }), "方向变化：疑似反向墙 → 疑似正向墙");
  assert.equal(context.eventText({ type: "blocked", reverseTotal: 2 }), "疑似双向墙");
  assert.equal(context.eventText({ type: "blocked", reverseTotal: 0 }), "疑似被墙");
  assert.equal(context.eventText({ type: "recovered", direction: "both" }), "解除被墙状态");
  assert.equal(context.observationText({ health: "unknown", candidateDirection: "reverse" }), "数据不足");
});

// Minimal DOM: enough to run the shipped render functions and read back what they built.
class Element {
  dataset: Record<string, string> = {};
  children: Element[] = [];
  attributes: Record<string, string> = {};
  textContent = "";
  className = "";
  value: unknown = "";
  checked = false;
  hidden = false;
  scrollTop = 0;
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener() {}
  querySelector() { return null; }
  get text(): string { return [this.textContent, ...this.children.map(child => child.text)].filter(Boolean).join(" | "); }
}
const descendants = (root: Element): Element[] => root.children.flatMap(child => [child, ...descendants(child)]);
function dom(ids: string[], extra: Record<string, unknown> = {}) {
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const context = createContext({ document: { getElementById: (id: string) => elements[id], createElement: () => new Element(), activeElement: null }, ...extra });
  return { elements, context };
}

test("administrator diagnostics explain each check, keep the raw entry and stay after recovery", () => {
  const { elements, context } = dom(["visibility-diagnostics", "visibility-count", "visibility-failures"]);
  runInContext(source.replace(/\nstart\(\);\s*$/, "\n"), context);
  const rows = () => elements["visibility-failures"].children.map(row => row.text);
  context.renderVisibilityDiagnostics({ visibilityDiagnostics: [{ entry: "WS /api/rpc2 public:getPingRecords", check: "Unsupported pagination", lastFailedAt: new Date(2026, 10, 17, 9, 15, 13).getTime(), occurrences: 3, recoveredAt: null }] });
  assert.equal(elements["visibility-diagnostics"].hidden, false);
  assert.match(rows()[0], /未恢复.*响应带有未知的分页字段.*WS \/api\/rpc2 public:getPingRecords · Unsupported pagination.*2026-11-17 09:15:13.*累计 3 次/);
  assert.match(elements["visibility-count"].textContent, /1 项未恢复/);
  // Unknown checks are shown verbatim as text; the page never builds markup from server strings.
  context.renderVisibilityDiagnostics({ visibilityDiagnostics: [{ entry: "POST /api/rpc2", check: "<script>", lastFailedAt: 1700000000000, occurrences: 1, recoveredAt: 1700000000001 }] });
  assert.match(rows()[0], /已恢复.*无法安全过滤该响应.*POST \/api\/rpc2 · <script>/);
  assert.match(elements["visibility-count"].textContent, /均已恢复/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  context.renderVisibilityDiagnostics({ visibilityDiagnostics: [] });
  assert.equal(elements["visibility-diagnostics"].hidden, true);
});

test("every filter check the service can report has a plain-language explanation", () => {
  const { context } = dom([]);
  runInContext(source.replace(/\nstart\(\);\s*$/, "\nglobalThis.checks = checkText;"), context);
  for (const check of [...CHECKS, "Unsupported response JSON"]) assert.ok(context.checks[check], check);
});

test("times use one locale-independent format; durations and ages read naturally", () => {
  const { context } = dom([]);
  runInContext(source.replace(/\nstart\(\);\s*$/, "\n"), context);
  const at = new Date(2026, 10, 7, 9, 5, 3).getTime();
  assert.equal(context.dateTime(at), "2026-11-07 09:05:03");
  assert.equal(context.dateTime(null), "—");
  assert.deepEqual([2, 42, 150, 7300, 200000].map(seconds => context.ago(at - seconds * 1000, at)), ["刚刚", "42 秒前", "2 分钟前", "2 小时前", "2 天前"]);
  assert.equal(context.ago(at + 5000, at), "刚刚");
  assert.deepEqual([20, 47 * 60, 126 * 60, 26 * 3600].map(seconds => context.duration(seconds * 1000)), ["不到 1 分钟", "47 分钟", "2 小时 6 分钟", "1 天 2 小时"]);
});

test("the overview lists problems first and the status tiles partition every server", () => {
  const { context } = dom([]);
  runInContext(source.replace(/\nstart\(\);\s*$/, "\nglobalThis.filters = statusFilters; globalThis.severity = severity;"), context);
  const rows = [{ health: "healthy" }, { health: "paused" }, { health: "unknown" }, { health: "degraded" }, { health: "suspect" }, { health: "healthy", alarm: true }, { health: "initializing" }, { health: "outage" }];
  assert.deepEqual([...rows].sort((a, b) => context.severity(a) - context.severity(b)).map(row => row.alarm ? "alarm" : row.health),
    ["alarm", "suspect", "outage", "degraded", "unknown", "initializing", "healthy", "paused"]);
  const buckets = [...context.filters].slice(1).map(([, , test]: [string, string, (row: unknown) => boolean]) => rows.filter(test).length);
  assert.deepEqual(buckets, [1, 1, 3, 3]);
  assert.equal(buckets.reduce((sum: number, count: number) => sum + count, 0), rows.length);
});

test("undoing an edit clears the unsaved-changes state; unselected drafts are not sent", () => {
  const { elements, context } = dom(["enabled", "mask", "strict", "interval", "failure", "recovery", "overseas", "dirty", "discard"]);
  const config = { enabled: true, maskIp: true, strict: true, intervalSeconds: 60, failureThreshold: 3, recoveryThreshold: 3, overseasRequired: 1, targets: [], clients: ["b", "a"], observers: ["c"], reverse: { a: { enabled: true, port: 443, host: "" }, b: { enabled: false, port: 0, host: "" } } };
  Object.assign(elements.enabled, { checked: true }); Object.assign(elements.mask, { checked: true }); Object.assign(elements.strict, { checked: true });
  Object.assign(elements.interval, { value: "60" }); Object.assign(elements.failure, { value: "3" }); Object.assign(elements.recovery, { value: "3" }); Object.assign(elements.overseas, { value: "1" });
  context.fixture = { config, clients: [] };
  runInContext(source.replace(/\nstart\(\);\s*$/, "\nmodel = fixture; baseline = JSON.stringify(collect()); updateDirty();"), context);
  const state = () => [runInContext("dirty", context), elements.dirty.textContent, elements.discard.hidden];
  assert.deepEqual(state(), [false, "所有更改已保存", true]);
  elements.interval.value = "90"; context.updateDirty();
  assert.deepEqual(state(), [true, "有未保存的更改", false]);
  elements.interval.value = "60"; context.updateDirty();
  assert.deepEqual(state(), [false, "所有更改已保存", true]);
  // Ticking and unticking a server leaves a draft behind; it is neither a change nor part of the payload.
  config.clients.push("z"); (config.reverse as any).z = { enabled: false, port: 0, host: "" };
  context.updateDirty(); assert.equal(state()[0], true);
  config.clients.pop(); context.updateDirty();
  assert.equal(state()[0], false);
  const sent = JSON.parse(JSON.stringify(context.collect()));
  assert.deepEqual(sent.clients, ["a", "b"]);
  assert.deepEqual(Object.keys(sent.reverse), ["a", "b"]);
  assert.equal(sent.intervalSeconds, 60);
});

test("global forward off hides every per-server control without losing choices or drafts", () => {
  const { elements, context } = dom(["clients", "observers", "strict", "strict-options", "forward-hint", "selected-count", "observer-count", "client-search", "observer-search"]);
  const config = { clients: ["a", "b"], observers: ["c"], strict: false, reverse: { a: { enabled: true, port: 443, host: "probe.example.com" }, b: { enabled: false, port: 0, host: "unfinished/" } } };
  const before = structuredClone(config);
  context.fixture = { config, clients: ["a", "b", "c"].map(uuid => ({ uuid, name: uuid, group: "", ipv4: "", ipv6: "" })) };
  runInContext(source.replace(/\nstart\(\);\s*$/, "\nmodel = fixture;"), context);
  for (const globalEnabled of [false, true, false, true]) {
    elements.strict.checked = globalEnabled;
    context.renderServerSelection();
    const controls = descendants(elements.clients);
    const toggles = controls.filter(el => el.dataset.forwardClient);
    const fields = controls.filter(el => /测试端口|测试地址/.test(el.attributes["aria-label"] ?? ""));
    assert.equal(toggles.length, globalEnabled ? 2 : 0);
    assert.equal(fields.length, globalEnabled ? 2 : 0);
    assert.equal(elements["strict-options"].hidden, !globalEnabled);
    assert.equal(elements["forward-hint"].hidden, !globalEnabled);
    assert.equal(controls.filter(el => el.dataset.serverId).length, 3);
    assert.equal(controls.filter(el => el.dataset.serverId && el.checked).length, 2);
    if (globalEnabled) {
      assert.deepEqual(toggles.map(el => el.checked), [true, false]);
      assert.deepEqual(fields.map(el => el.value), [443, "probe.example.com"]);
    }
    assert.deepEqual(config, before);
  }
});

test("selection notice is shown once, acknowledged, expires in 8 seconds and does not hide real errors", async () => {
  const f = fixture();
  f.render(data()); await flush();
  assert.equal(f.banner.hidden, false);
  assert.equal(f.banner.textContent, data().selectionNotice);
  assert.equal([...f.timers.values()][0].delay, 8000);
  assert.deepEqual(f.calls, [{ path: "ack-selection", body: { revision: 1, notice: data().selectionNotice } }]);
  f.expire();
  f.render(data()); await flush();
  assert.equal(f.banner.hidden, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.error.hidden, false);
  assert.equal(f.error.textContent, "Real synchronization error");
});

test("hidden pages do not consume a notice before it can be displayed", async () => {
  const f = fixture(); f.document.hidden = true;
  f.render(data()); await flush();
  assert.equal(f.banner.hidden, true);
  assert.equal(f.calls.length, 0);
  f.document.hidden = false;
  f.render(data()); await flush();
  assert.equal(f.banner.hidden, false);
  assert.equal(f.calls.length, 1);
});

test("failed acknowledgements retry without repeatedly displaying the same message", async () => {
  const f = fixture(); f.fail(true);
  f.render(data()); await flush();
  f.expire(); f.fail(false);
  f.render(data()); await flush();
  assert.equal(f.banner.hidden, true);
  assert.equal(f.calls.length, 2);
  f.render(data()); await flush();
  assert.equal(f.calls.length, 2);
});

test("a newer deletion with the same wording receives its own one-time notice", async () => {
  const f = fixture();
  f.render(data()); await flush();
  f.render(data(2)); await flush();
  assert.equal(f.banner.hidden, false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.timers.size, 1);
  f.expire(); f.render(data(2)); await flush();
  assert.equal(f.banner.hidden, true);
});
