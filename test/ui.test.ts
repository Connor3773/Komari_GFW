import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

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
    assert.equal(context.observationText({ health: "suspect", candidateDirection: direction }), `${text}条件`);
  }
  assert.equal(context.eventText({ type: "blocked", direction: "forward", previousDirection: "reverse" }), "方向变化：疑似反向墙 → 疑似正向墙");
  assert.equal(context.eventText({ type: "blocked", reverseTotal: 2 }), "疑似双向墙");
  assert.equal(context.eventText({ type: "blocked", reverseTotal: 0 }), "疑似被墙");
  assert.equal(context.eventText({ type: "recovered", direction: "both" }), "解除被墙状态");
  assert.equal(context.observationText({ health: "unknown", candidateDirection: "reverse" }), "数据不足");
});

test("administrator diagnostics retain last failure even after recovery, rendered as text", () => {
  const f = fixture();
  const details = { hidden: true };
  let rows: any[] = [];
  const failures = { replaceChildren(...items: any[]) { rows = items; } };
  (f.document as any).getElementById = (id: string) => id === "visibility-diagnostics" ? details : failures;
  f.context.node = (_tag: string, text: string) => ({ textContent: text });
  f.context.renderVisibilityDiagnostics({ visibilityDiagnostics: [{ entry: "WS /api/rpc2 public:getPingRecords", check: "Unsupported pagination", lastFailedAt: 1700000000000, occurrences: 3, recoveredAt: null }] });
  assert.equal(details.hidden, false);
  assert.match(rows[0].textContent, /未恢复.*WS \/api\/rpc2 public:getPingRecords.*Unsupported pagination.*3 次/);
  f.context.renderVisibilityDiagnostics({ visibilityDiagnostics: [{ entry: "POST /api/rpc2", check: "<script>", lastFailedAt: 1700000000000, occurrences: 1, recoveredAt: 1700000000001 }] });
  assert.match(rows[0].textContent, /已恢复/);
  assert.match(rows[0].textContent, /<script>/);
  f.context.renderVisibilityDiagnostics({ visibilityDiagnostics: [] });
  assert.equal(details.hidden, true);
});

test("global forward off hides every per-server control without losing choices or drafts", () => {
  class Element {
    dataset: Record<string, string> = {};
    children: Element[] = [];
    attributes: Record<string, string> = {};
    value = "";
    checked = false;
    hidden = false;
    scrollTop = 0;
    append(...children: Element[]) { this.children.push(...children); }
    replaceChildren(...children: Element[]) { this.children = children; }
    setAttribute(name: string, value: string) { this.attributes[name] = value; }
    addEventListener() {}
    querySelector() { return null; }
  }
  const elements = Object.fromEntries(["clients", "observers", "strict", "strict-options", "selected-count", "client-search", "observer-search"].map(id => [id, new Element()]));
  const config = { clients: ["a", "b"], observers: ["c"], strict: false, reverse: { a: { enabled: true, port: 443, host: "probe.example.com" }, b: { enabled: false, port: 0, host: "unfinished/" } } };
  const before = structuredClone(config);
  const context = createContext({ document: { getElementById: (id: string) => elements[id], createElement: () => new Element(), activeElement: null }, fixture: { config, clients: ["a", "b", "c"].map(uuid => ({ uuid, name: uuid, group: "", ipv4: "", ipv6: "" })) } });
  runInContext(source.replace(/\nstart\(\);\s*$/, "\nmodel = fixture;"), context);
  const descendants = (root: Element): Element[] => root.children.flatMap(child => [child, ...descendants(child)]);
  for (const globalEnabled of [false, true, false, true]) {
    elements.strict.checked = globalEnabled;
    context.renderServerSelection();
    const controls = descendants(elements.clients);
    const toggles = controls.filter(el => el.dataset.forwardClient);
    const fields = controls.filter(el => /测试端口|测试地址/.test(el.attributes["aria-label"] ?? ""));
    assert.equal(toggles.length, globalEnabled ? 2 : 0);
    assert.equal(fields.length, globalEnabled ? 2 : 0);
    assert.equal(elements["strict-options"].hidden, !globalEnabled);
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
