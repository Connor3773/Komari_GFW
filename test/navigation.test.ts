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

test("configuration registers a trusted same-origin form in the host config page", () => {
  const config = manifest.configuration;
  assert.equal(config.type, "managed");
  assert.equal(config.data.length, 1);
  const item = config.data[0];
  // Textbox-only configurations hide the host's unrelated managed-value Save button.
  assert.equal(item.type, "textbox");
  assert.equal(item.key, undefined);
  assert.match(item.name, /src="\/api\/admin\/plugin\/komari-gfw\/pages\/settings\.html"/);
  assert.match(item.name, /title="GFW 配置"/);
  assert.ok(!/<script|\son\w+=|https?:\/\//i.test(item.name));
});

test("overview links to the unified configuration without nesting the admin shell", () => {
  const html = read("pages/overview.html");
  const links = html.match(/<a\b[^>]*href="\/admin\/plugins\/config\?short=komari-gfw"[^>]*>/g) ?? [];
  assert.equal(links.length, 2);
  for (const link of links) {
    assert.match(link, /target="_blank"/);
    assert.match(link, /rel="noopener"/);
  }
  assert.ok(!html.includes('href="./settings.html"'));
  assert.ok(!read("pages/settings.html").includes('target="_top"'));
});

test("manifest and package versions match the page footer", () => {
  assert.equal(manifest.version, JSON.parse(read("package.json")).version);
  assert.equal(manifest.version, JSON.parse(read("package-lock.json")).version);
  for (const page of ["overview", "settings"]) assert.ok(read(`pages/${page}.html`).includes(`Komari GFW ${manifest.version}`));
});
