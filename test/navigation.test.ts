import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sdk from "@komari-monitor/plugin-sdk";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("komari-plugin.json"));

test("only overview is registered under plugin features", () => {
  sdk.assertValidManifest(manifest);
  assert.ok(manifest.pages);
  assert.deepEqual(manifest.pages.map(page => page.file), ["pages/overview.html"]);
  assert.equal(manifest.pages[0].visibility, "admin");
});

test("plugin and feature display names match the requested names", () => {
  assert.equal(manifest.name.zh_CN, "被墙检测");
  assert.equal(manifest.pages[0].title.zh_CN, "被墙检测总览");
  assert.match(read("pages/overview.html"), /<title>被墙检测总览<\/title>/);
  assert.match(read("pages/overview.html"), /<h1>被墙检测总览<\/h1>/);
  assert.match(read("pages/settings.html"), /<h1>被墙检测配置<\/h1>/);
  assert.match(read("pages/settings.html"), /隐藏服务器 IP 后两段/);
  assert.doesNotMatch(read("pages/settings.html"), /隐藏服务器 IPv4 后两段/);
  for (const page of ["overview", "settings"]) assert.doesNotMatch(read(`pages/${page}.html`), /GFW/);
});

test("configuration registers a trusted same-origin form in the host config page", () => {
  const config = manifest.configuration;
  assert.equal(config.type, "managed");
  assert.equal(config.data.length, 1);
  const item = config.data[0];
  // Textbox-only configurations hide the host's unrelated managed-value Save button.
  assert.equal(item.type, "textbox");
  assert.equal(item.key, undefined);
  assert.match(item.name, /src="\/api\/admin\/plugin\/komari-gfw\/pages\/settings\.html"/);
  assert.match(item.name, /title="被墙检测配置"/);
  assert.ok(!/<script|\son\w+=|https?:\/\//i.test(item.name));
});

test("page headers have no duplicate navigation; empty-state config opens the unified page", () => {
  const html = read("pages/overview.html");
  const links = html.match(/<a\b[^>]*href="\/admin\/plugins\/config\?short=komari-gfw"[^>]*>/g) ?? [];
  assert.equal(links.length, 1);
  for (const link of links) {
    assert.match(link, /target="_blank"/);
    assert.match(link, /rel="noopener"/);
  }
  assert.ok(!html.includes('href="./settings.html"'));
  assert.ok(!read("pages/settings.html").includes('target="_top"'));
  for (const page of ["overview", "settings"]) {
    const content = read(`pages/${page}.html`);
    assert.doesNotMatch(content, /<nav\b/);
    assert.doesNotMatch(content.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0] ?? "", /<a\b/);
  }
});

test("direction copy uses mainland-to-server as forward and server-to-mainland as reverse", () => {
  const overview = read("pages/overview.html");
  const settings = read("pages/settings.html");
  const app = read("pages/app.js");
  assert.match(overview, /反向：受检服务器 → 大陆目标；正向：境内探针 → 受检服务器/);
  assert.match(settings, /由受检服务器主动连接。反向：3 个大陆目标；对照：2 个非大陆目标/);
  assert.match(settings, /由境内探针主动连接受检服务器/);
  assert.match(settings, /解除要求反向 3\/3、非大陆对照 2\/2 和全部正向探针成功/);
  assert.match(app, /监测中 · 仅反向检测/);
  assert.match(app, /反向 · 服务器 → 大陆目标/);
  assert.match(app, /正向 · 境内探针 → 服务器/);
  assert.doesNotMatch(overview + settings + app, /境内反向探针|正向 5\/5|基础模式 · 正向检测/);
});

test("pages apply the host theme before first paint and ship no inline script or style", () => {
  for (const page of ["overview", "settings"]) {
    const html = read(`pages/${page}.html`);
    // A blocking script in <head> sets the theme before the body renders.
    assert.match(html.match(/<head>[\s\S]*<\/head>/)![0], /<script src="\.\/app\.js"><\/script>/);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)|\sstyle=|\son\w+=/i);
  }
  const app = read("pages/app.js");
  assert.match(app, /frameElement/);
  // An observer on host nodes would keep a closed plugin page alive.
  assert.doesNotMatch(app, /MutationObserver/);
});

test("manifest and package versions match the page footer", () => {
  assert.equal(manifest.version, JSON.parse(read("package.json")).version);
  assert.equal(manifest.version, JSON.parse(read("package-lock.json")).version);
  for (const page of ["overview", "settings"]) assert.ok(read(`pages/${page}.html`).includes(`被墙检测 ${manifest.version}`));
});

test("manifest declares the minimum host version and approved hook permission", () => {
  assert.equal(manifest.komari, ">=1.6.1");
  assert.equal(manifest.permissions.allowHooks, true);
  assert.equal(manifest.short, "komari-gfw");
  assert.equal(manifest.version, "0.1.9");
});
