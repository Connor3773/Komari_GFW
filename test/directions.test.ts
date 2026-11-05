import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, detectionSignature, forwardEnabled, monitorKeys, reverseAddress, validateConfig } from "../src/config.ts";
import { evaluate, newMonitor } from "../src/engine.ts";
import type { Config } from "../src/types.ts";

const legacy = (): Config => ({ ...defaultConfig(), enabled: true, strict: true, clients: ["a", "b"], observers: ["probe"], reverse: { a: { port: 443, host: "" }, b: { port: 80, host: "example.com" } } });

test("legacy strict migration enables every selected server and remains idempotent", () => {
  const raw = legacy(), before = structuredClone(raw), cfg = validateConfig(raw);
  assert.deepEqual(raw, before);
  for (const uuid of cfg.clients) {
    assert.equal(cfg.reverse[uuid].enabled, true);
    assert.equal(forwardEnabled(cfg, uuid), true);
    assert.equal(monitorKeys(cfg, uuid).length, 6);
  }
  assert.deepEqual(validateConfig(cfg), cfg);
  const basic = validateConfig({ ...legacy(), strict: false });
  assert.equal(basic.reverse.a.enabled, false);
  assert.equal(basic.reverse.b.host, "example.com");
  assert.equal(forwardEnabled({ ...basic, strict: true }, "a"), false);
});

for (const global of [false, true]) for (const individual of [false, true]) test(`forward switches compose independently (${global}/${individual})`, () => {
  const cfg = validateConfig({ ...legacy(), strict: global, reverse: { a: { enabled: individual, port: 443, host: "" }, b: { enabled: false, port: 0, host: "" } } });
  assert.equal(forwardEnabled(cfg, "a"), global && individual);
  assert.equal(forwardEnabled(cfg, "b"), false);
  assert.equal(forwardEnabled(cfg, "not-selected"), false);
  assert.equal(monitorKeys(cfg, "a").length, global && individual ? 6 : 5);
  assert.equal(monitorKeys(cfg, "b").length, 5);
});

test("inactive forward drafts bypass required validation and survive toggles", () => {
  const draft = { enabled: false, port: 0, host: "https://unfinished/" };
  let cfg = validateConfig({ ...legacy(), observers: [], reverse: { a: draft, b: draft } });
  assert.deepEqual(cfg.reverse.a, draft);
  cfg.reverse.a.enabled = true;
  assert.throws(() => validateConfig(cfg), /端口/);
  cfg.strict = false;
  cfg = validateConfig(cfg);
  assert.equal(cfg.reverse.a.enabled, true);
  assert.equal(cfg.reverse.a.host, draft.host);
  cfg.reverse.a.port = 65536;
  assert.equal(validateConfig(cfg).reverse.a.port, 65536);
  cfg.reverse.a = { enabled: true, port: 443, host: "probe.example.com" };
  cfg.observers = ["probe"];
  const on = validateConfig({ ...cfg, strict: true });
  assert.deepEqual(on.reverse.a, cfg.reverse.a);
  assert.deepEqual(validateConfig({ ...on, strict: false }).reverse, cfg.reverse);
});

test("inactive nodes need no probe; active nodes cannot probe themselves", () => {
  const cfg = validateConfig({ ...legacy(), observers: [], reverse: { a: { enabled: false }, b: { enabled: false } } });
  assert.equal(cfg.strict, true);
  assert.throws(() => validateConfig({ ...cfg, observers: ["a"], reverse: { ...cfg.reverse, a: { enabled: true, port: 443, host: "" } } }), /自身/);
});

test("effective target uses manual host then IPv4 then IPv6, never a stored masked IP", () => {
  const cfg = validateConfig(legacy());
  const client = { uuid: "a", name: "A", group: "", ipv4: "203.0.113.9", ipv6: "2001:db8::9" };
  assert.equal(reverseAddress(cfg, client), "203.0.113.9:443");
  assert.equal(reverseAddress(cfg, { ...client, ipv4: "" }), "[2001:db8::9]:443");
  cfg.reverse.a.host = "PROBE.EXAMPLE.COM";
  assert.equal(reverseAddress(cfg, client), "probe.example.com:443");
});

test("signatures isolate effective per-node configuration from unrelated or inactive drafts", () => {
  const cfg = validateConfig(legacy()), updated = structuredClone(cfg);
  updated.reverse.b.port = 8443;
  assert.equal(detectionSignature(cfg, "a"), detectionSignature(updated, "a"));
  assert.notEqual(detectionSignature(cfg, "b"), detectionSignature(updated, "b"));
  cfg.reverse.a.enabled = false;
  const off = structuredClone(cfg);
  off.reverse.a.host = "unfinished/"; off.reverse.a.port = 0; off.observers = [];
  assert.equal(detectionSignature(cfg, "a"), detectionSignature(off, "a"));
  assert.equal(detectionSignature(cfg, "a"), detectionSignature({ ...cfg, strict: false }, "a"));
});

test("mixed nodes confirm and recover without waiting for disabled forward samples", () => {
  const cfg = validateConfig({ ...legacy(), failureThreshold: 2, recoveryThreshold: 2 });
  cfg.reverse.b.enabled = false;
  const states = { a: newMonitor(0), b: newMonitor(0) };
  function round(uuid: "a" | "b", cycle: number, healthy = false) {
    const now = cycle * 60000;
    const samples = Object.fromEntries(monitorKeys(cfg, uuid).map(key => [key, [{ at: now, value: healthy || key.startsWith("global") ? 1 : -1 }]]));
    return evaluate(states[uuid], samples, cfg, uuid, now);
  }
  for (const uuid of ["a", "b"] as const) {
    assert.equal(round(uuid, 1).length, 0);
    const event = round(uuid, 2)[0];
    assert.equal(event.direction, uuid === "a" ? "both" : "basic");
    assert.equal(event.reverseTotal, uuid === "a" ? 1 : 0);
    assert.equal(round(uuid, 3, true).length, 0);
    assert.equal(round(uuid, 4, true)[0].type, "recovered");
    assert.equal(states[uuid].health, "healthy");
  }
});
