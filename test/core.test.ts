import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, monitorKeys, normalizeAddress, validateConfig, reverseAddress } from "../src/config.ts";
import { evaluate, newMonitor } from "../src/engine.ts";
import { maskAddress, notificationEvent } from "../src/privacy.ts";
import type { Config, Monitor, Notice, Sample } from "../src/types.ts";

function config(): Config { return { ...defaultConfig(), enabled: true, clients: ["server-a"] }; }
const epoch = Date.parse("2026-01-01T00:00:00Z");
function round(state: Monitor, cfg: Config, cycle: number, values: number[]) {
  const now = epoch + cycle * 60000;
  const data: Record<string, Sample[]> = {};
  monitorKeys(cfg, "server-a").forEach((key, i) => { if (values[i] !== undefined) data[key] = [{ at: now - 1000 + i * 5, value: values[i] }]; });
  return evaluate(state, data, cfg, "server-a", now);
}

test("confirmed defaults, no unsolicited monitoring", () => {
  const cfg = defaultConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.strict, false);
  assert.equal(cfg.targets[0].address, "gd-ct-v4.ip.zstaticcdn.com:80");
  assert.equal(cfg.targets[4].address, "9.9.9.9:443");
  assert.deepEqual(validateConfig(cfg), cfg);
});
for (const address of ["probe.example.com:443", "203.0.113.10:443", "[2001:db8::1]:443", "xn--fiqs8s.example:80"]) {
  test(`valid address ${address}`, () => assert.equal(normalizeAddress(address), address));
}
for (const address of ["https://example.com:443", "a/b:443", "a:0", "a:65536", "a:-1", "example.com", "a@b:80", "127.1:80", "012.0.0.1:80", "256.1.1.1:80", "a\\b:80", "2001:db8::1:443", "[gg::]:80", "a:80?x", "a\nb:80", "-bad.example:80"]) {
  test(`reject invalid target ${JSON.stringify(address)}`, () => assert.throws(() => normalizeAddress(address)));
}
test("normalize host case and canonical duplicate detection", () => {
  assert.equal(normalizeAddress(" Example.COM.:080 "), "example.com:80");
  const cfg = config(); cfg.targets[1].address = cfg.targets[0].address.toUpperCase();
  assert.throws(() => validateConfig(cfg), /重复/);
});
test("strict config requires a different observer and test ports", () => {
  const cfg = { ...config(), strict: true, observers: ["server-a"] };
  assert.throws(() => validateConfig(cfg), /端口/);
  cfg.reverse["server-a"] = { port: 443, host: "" };
  assert.throws(() => validateConfig(cfg), /自身/);
  cfg.observers.push("probe-a");
  assert.equal(validateConfig(cfg).strict, true);
  assert.equal(reverseAddress(cfg, { uuid: "server-a", name: "A", ipv4: "203.0.113.1", ipv6: "", group: "" }), "203.0.113.1:443");
});
test("cannot enable empty server selection", () => assert.throws(() => validateConfig({ ...defaultConfig(), enabled: true })));
test("live inventory removes stale selections before strict port validation without mutating input", () => {
  const raw = { ...config(), clients: ["server-a", "deleted"], strict: true, observers: ["deleted-probe"], reverse: { "server-a": { port: 443, host: "" }, deleted: { port: 0, host: "" } } };
  const copy = structuredClone(raw);
  const cfg = validateConfig(raw, new Set(["server-a", "new-server"]));
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.strict, false);
  assert.deepEqual(cfg.clients, ["server-a"]);
  assert.deepEqual(cfg.observers, []);
  assert.deepEqual(Object.keys(cfg.reverse), ["server-a"]);
  assert.deepEqual(raw, copy);
  assert.throws(() => validateConfig({ ...raw, clients: "invalid" }, new Set()), /服务器列表无效/);
  assert.throws(() => validateConfig({ ...defaultConfig(), enabled: true }, new Set()), /选择服务器/);
});
test("mask exactly the final two IPv4 octets", () => {
  assert.equal(maskAddress("203.0.113.123", true), "203.0.*.*");
  assert.equal(maskAddress("203.0.113.123", false), "203.0.113.123");
  assert.equal(maskAddress("2001:db8::abcd", true), "2001:db8:0:0:*:*:*:*");
});
test("initial healthy never emits recovered", () => {
  const cfg = config(), s = newMonitor(epoch);
  for (let i = 1; i <= 5; i++) assert.deepEqual(round(s, cfg, i, [1, 2, 3, 4, 5]), []);
  assert.equal(s.health, "healthy"); assert.equal(s.alarm, false);
});
test("block only at threshold, never repeat, recover only after 5/5 threshold", () => {
  const cfg = config(), s = newMonitor(epoch);
  assert.equal(round(s, cfg, 1, [-1, -1, -1, 20, -1]).length, 0);
  assert.equal(round(s, cfg, 2, [-1, -1, -1, 20, -1]).length, 0);
  assert.equal(round(s, cfg, 3, [-1, -1, -1, 20, -1])[0].type, "blocked");
  assert.equal(round(s, cfg, 4, [-1, -1, -1, 20, -1]).length, 0);
  round(s, cfg, 5, [10, -1, -1, 20, 20]); assert.equal(s.alarm, true);
  round(s, cfg, 6, [-1, -1, -1, -1, -1]); assert.equal(s.alarm, true);
  round(s, cfg, 7, [1, 1, 1, 1, 1]); round(s, cfg, 8, [1, 1, 1, 1, 1]);
  assert.equal(round(s, cfg, 9, [1, 1, 1, 1, 1])[0].type, "recovered");
  assert.equal(s.alarm, false);
});
test("all failed means outage, not blocking", () => {
  const cfg = config(), s = newMonitor(epoch);
  for (let i = 1; i < 5; i++) assert.equal(round(s, cfg, i, [-1, -1, -1, -1, -1]).length, 0);
  assert.equal(s.health, "outage");
});
test("overseas quorum is configurable", () => {
  const cfg = { ...config(), overseasRequired: 2, failureThreshold: 1 }, s = newMonitor(epoch);
  assert.equal(round(s, cfg, 1, [-1, -1, -1, 1, -1]).length, 0);
  assert.equal(round(s, cfg, 2, [-1, -1, -1, 1, 1])[0].type, "blocked");
});
test("repeat poll and replay after reload do not increment counters", () => {
  const cfg = config(); let s = newMonitor(epoch);
  round(s, cfg, 1, [-1, -1, -1, 1, 1]);
  s = JSON.parse(JSON.stringify(s));
  for (let i = 0; i < 5; i++) round(s, cfg, 1, [-1, -1, -1, 1, 1]);
  assert.equal(s.failureStreak, 1); assert.equal(s.alarm, false);
});
test("gaps interrupt confirmation; no old evidence is reused", () => {
  const cfg = config(), s = newMonitor(epoch);
  round(s, cfg, 1, [-1, -1, -1, 1, 1]); round(s, cfg, 2, [-1, -1, -1, 1, 1]);
  round(s, cfg, 5, [-1, -1, -1, 1, 1]);
  assert.equal(s.failureStreak, 1); assert.equal(s.alarm, false);
});
test("missing, future or badly aligned samples cannot form a round", () => {
  const cfg = { ...config(), failureThreshold: 1 }, s = newMonitor(epoch);
  round(s, cfg, 1, [-1, -1, -1, 1]); assert.equal(s.alarm, false);
  const data = Object.fromEntries(monitorKeys(cfg, "server-a").map((k, i) => [k, [{ at: epoch + 119000 + i * 20000, value: i < 3 ? -1 : 1 }]]));
  evaluate(s, data, cfg, "server-a", epoch + 120000);
  assert.equal(s.alarm, false);
  evaluate(s, {}, cfg, "server-a", epoch + 1000000);
  assert.equal(s.health, "unknown"); assert.equal(s.failureStreak, 0);
});
test("strict mode requires every mainland-to-server observer to fail and all to recover", () => {
  const cfg = { ...config(), strict: true, observers: ["probe-a", "probe-b"], failureThreshold: 1, recoveryThreshold: 1 }, s = newMonitor(epoch);
  assert.equal(round(s, cfg, 1, [-1, -1, -1, 1, 1, -1, 10]).length, 0);
  assert.equal(round(s, cfg, 2, [-1, -1, -1, 1, 1, -1, -1])[0].type, "blocked");
  assert.equal(round(s, cfg, 3, [1, 1, 1, 1, 1, -1, 1]).length, 0);
  assert.equal(round(s, cfg, 4, [1, 1, 1, 1, 1, 1]).length, 0);
  assert.equal(s.alarm, true);
  assert.equal(round(s, cfg, 5, [1, 1, 1, 1, 1, 1, 1])[0].type, "recovered");
});
test("strict mode excludes self but not other observers", () => {
  assert.deepEqual(monitorKeys({ ...config(), strict: true, observers: ["server-a", "probe-a"] }, "server-a").slice(5), ["reverse:probe-a"]);
});
test("outage or missing data must retain active alarm", () => {
  const cfg = { ...config(), failureThreshold: 1 }, s = newMonitor(epoch);
  round(s, cfg, 1, [-1, -1, -1, 1, 1]);
  evaluate(s, {}, cfg, "server-a", epoch + 999999);
  assert.equal(s.health, "unknown"); assert.equal(s.alarm, true);
  const restart = newMonitor(epoch + 1000000, s); assert.equal(restart.alarm, true);
});
test("event is redacted and never asks host to hydrate Client records", () => {
  const event = { type: "blocked", at: epoch, since: epoch, mainland: 0, overseas: 2, reverse: 0, reverseTotal: 2 } as Notice;
  const result = notificationEvent(event, { uuid: "server-a", name: "server 203.0.113.123", ipv4: "203.0.113.123", ipv6: "", group: "" }, config());
  assert.deepEqual(result.clients, []);
  assert.ok(!JSON.stringify(result).includes("203.0.113.123"));
  assert.ok(result.message.includes("203.0.*.*"));
});

for (const type of ["blocked", "recovered"] as const) test(`notification title and direction evidence (${type})`, () => {
  const recovered = type === "recovered";
  const event = { type, at: epoch, since: epoch, mainland: recovered ? 3 : 0, overseas: 2, reverse: recovered ? 2 : 0, reverseTotal: 2 } as Notice;
  const result = notificationEvent(event, { uuid: "server-a", name: "Test server", ipv4: "203.0.113.123", ipv6: "", group: "" }, config());
  assert.equal(result.event, recovered ? "服务器解除被墙状态" : "服务器疑似被墙");
  assert.ok(result.message.includes(`被墙状态：${recovered ? "已解除" : "疑似被墙"}`));
  assert.ok(result.message.includes(`反向（受检服务器到大陆目标）：${recovered ? 3 : 0}/3 可达`));
  assert.ok(result.message.includes("非大陆对照（受检服务器到非大陆目标）：2/2 可达"));
  assert.ok(result.message.includes(`正向（大陆探针到受检服务器）：${recovered ? 2 : 0}/2 可达（严格模式）`));
  assert.doesNotMatch(result.event + result.message, /GFW/);
});

test("basic notifications do not claim mainland-to-server evidence", () => {
  const event = { type: "blocked", at: epoch, since: epoch, mainland: 0, overseas: 1, reverse: 0, reverseTotal: 0 } as Notice;
  const result = notificationEvent(event, { uuid: "server-a", name: "Test server", ipv4: "203.0.113.123", ipv6: "", group: "" }, config());
  assert.doesNotMatch(result.message, /正向|严格模式/);
  assert.ok(result.message.includes("非大陆对照（受检服务器到非大陆目标）：1/2 可达"));
});

for (const strict of [false, true]) test(`exhaustive connectivity truth table (strict=${strict})`, () => {
  const cfg = { ...config(), strict, observers: ["probe-a", "probe-b"], failureThreshold: 1, recoveryThreshold: 1 };
  const n = strict ? 7 : 5;
  for (let bits = 0; bits < 2 ** n; bits++) {
    const values = Array.from({ length: n }, (_, i) => bits & (1 << i) ? 1 : -1);
    const blocked = values.slice(0, 3).every(x => x < 0) && values.slice(3, 5).some(x => x >= 0) && (!strict || values.slice(5).every(x => x < 0));
    const state = newMonitor(epoch);
    assert.equal(round(state, cfg, 1, values).some(e => e.type === "blocked"), blocked, `bits ${bits}`);
    const alarm = newMonitor(epoch); alarm.alarm = true; alarm.blockedSince = epoch;
    assert.equal(round(alarm, cfg, 1, values).some(e => e.type === "recovered"), values.every(x => x >= 0), `recovery bits ${bits}`);
  }
});
