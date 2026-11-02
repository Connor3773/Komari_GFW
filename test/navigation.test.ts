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
  assert.match(overview, /正向：大陆探针到受检服务器；反向：受检服务器到大陆目标/);
  assert.match(settings, /反向：受检服务器到 3 个大陆目标；对照：受检服务器到 2 个非大陆目标/);
  assert.match(settings, /正向 TCP 探测：大陆探针到受检服务器/);
  assert.match(settings, /解除要求反向 3\/3、非大陆对照 2\/2 和全部正向探针成功/);
  assert.match(app, /基础模式 · 反向检测/);
  assert.match(app, /正向探针（大陆出发）/);
  assert.doesNotMatch(overview + settings + app, /境内反向探针|正向 5\/5|基础模式 · 正向检测/);
});

test("manifest and package versions match the page footer", () => {
  assert.equal(manifest.version, JSON.parse(read("package.json")).version);
  assert.equal(manifest.version, JSON.parse(read("package-lock.json")).version);
  for (const page of ["overview", "settings"]) assert.ok(read(`pages/${page}.html`).includes(`被墙检测 ${manifest.version}`));
});
