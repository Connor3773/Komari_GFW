import type { State } from "./types.ts";

interface IO {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string, options: { encoding: "utf8"; mode: number }): void;
}

// Komari 1.6.1's sandboxed renameSync fails on Windows. Alternate checksummed
// slots instead: a torn write cannot overwrite the other last-good generation.
export class JournalStore {
  private io: IO;
  private files: string[];
  private hash: (text: string) => string;
  private sequence = 0;
  private lastPayload = "";

  constructor(io: IO, files: [string, string], hash: (text: string) => string) {
    this.io = io; this.files = files; this.hash = hash;
  }
  load(): State | null {
    let state: State | null = null;
    let exists = false;
    for (const file of this.files) {
      if (!this.io.existsSync(file)) continue;
      exists = true;
      try {
        const envelope = JSON.parse(this.io.readFileSync(file, "utf8"));
        if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence <= this.sequence || typeof envelope.payload !== "string" || this.hash(envelope.payload) !== envelope.sha256) continue;
        const value = JSON.parse(envelope.payload);
        if (!value || value.schema !== 1) continue;
        state = value;
        this.sequence = envelope.sequence;
        this.lastPayload = envelope.payload;
      } catch { /* A truncated slot is ignored only when the other slot is valid. */ }
    }
    if (exists && state === null) throw new Error("Both plugin state slots are invalid; back up and inspect before recovery");
    return state;
  }
  save(state: State): void {
    const sequence = this.sequence + 1;
    const payload = JSON.stringify(state);
    if (payload === this.lastPayload) return;
    const envelope = JSON.stringify({ sequence, payload, sha256: this.hash(payload) });
    this.io.writeFileSync(this.files[sequence % 2], envelope, { encoding: "utf8", mode: 0o600 });
    this.sequence = sequence;
    this.lastPayload = payload;
  }
}
