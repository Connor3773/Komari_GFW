import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { JournalStore } from "../src/storage.ts";
import { initialState } from "../src/service.ts";

function fixture() {
  const files = new Map<string, string>();
  const io = { existsSync: (name: string) => files.has(name), readFileSync: (name: string) => files.get(name)!, writeFileSync: (name: string, text: string) => { files.set(name, text); } };
  const make = () => new JournalStore(io, ["0", "1"], text => createHash("sha256").update(text).digest("hex"));
  return { files, make };
}
test("journal chooses newest valid generation and survives truncated write", () => {
  const f = fixture(), store = f.make(), state = initialState("00112233445566778899aabb");
  assert.equal(store.load(), null);
  store.save(state); state.revision = 1; store.save(state);
  assert.equal(f.make().load()?.revision, 1);
  f.files.set("0", '{"sequence":');
  assert.equal(f.make().load()?.revision, 0);
});
test("journal refuses silent reset when both slots are corrupt", () => {
  const f = fixture(); f.files.set("0", "broken"); f.files.set("1", "broken");
  assert.throws(() => f.make().load(), /invalid/);
});
test("journal checks content integrity, not just JSON syntax", () => {
  const f = fixture(), store = f.make(), state = initialState("00112233445566778899aabb");
  store.save(state); state.revision = 1; store.save(state);
  const envelope = JSON.parse(f.files.get("0")!); envelope.payload = envelope.payload.replace('"revision":1', '"revision":9'); f.files.set("0", JSON.stringify(envelope));
  assert.equal(f.make().load()?.revision, 0);
});

test("unchanged polling state does not rewrite journal files", () => {
  const f = fixture(), store = f.make(), state = initialState("00112233445566778899aabb");
  store.save(state); store.save(state);
  assert.equal(f.files.size, 1);
  assert.equal(JSON.parse(f.files.get("1")!).sequence, 1);
});
