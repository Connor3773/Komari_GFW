export const SLOTS = ["cn1", "cn2", "cn3", "global1", "global2"] as const;
export type Slot = (typeof SLOTS)[number];
export interface Target { id: Slot; name: string; address: string }
// Legacy reverse fields mean mainland-to-server (forward) probes; retain schema 1 compatibility.
export interface ReverseTarget { port: number; host: string }
export interface Config {
  enabled: boolean;
  intervalSeconds: number;
  failureThreshold: number;
  recoveryThreshold: number;
  overseasRequired: number;
  maskIp: boolean;
  clients: string[];
  targets: Target[];
  strict: boolean;
  observers: string[];
  reverse: Record<string, ReverseTarget>;
}
export interface Client { uuid: string; name: string; ipv4: string; ipv6: string; group: string }
export interface PingTask {
  id: number; name: string; target: string; type: string; interval: number;
  clients: string[]; default_on: boolean; weight?: number;
}
export interface Sample { at: number; value: number }
export type Health = "initializing" | "healthy" | "suspect" | "degraded" | "outage" | "unknown" | "paused";
export type BlockDirection = "basic" | "forward" | "reverse" | "both";
export interface Monitor {
  health: Health;
  alarm: boolean;
  alarmDirection?: BlockDirection | null;
  candidateDirection?: BlockDirection | null;
  blockedSince: number | null;
  suspectSince: number | null;
  failureStreak: number;
  recoveryStreak: number;
  after: Record<string, number>;
  latest: Record<string, Sample>;
  lastRoundAt: number | null;
  effectiveSince: number;
}
export interface Evidence { mainland: number; overseas: number; reverse: number; reverseTotal: number }
export interface Transition extends Evidence {
  type: "blocked" | "recovered"; at: number; since: number;
  direction?: BlockDirection; previousDirection?: BlockDirection;
}
export interface Notice extends Transition {
  id: string; client: string; attempts: number; nextAttemptAt: number;
  delivery: "pending" | "sent" | "failed" | "superseded";
  lastError: string; sentAt?: number;
}
export interface State {
  schema: 1; instance: string; config: Config; revision: number;
  tasks: Record<string, number>; sources: Record<string, string>; monitors: Record<string, Monitor>;
  events: Notice[];
  hiddenTaskIds?: number[];
  selectionNotice?: string;
}
export interface MetricSeries {
  metric_key: string; entity_id: string; tags?: Record<string, string>;
  downsampled: boolean;
  points: { time: string; value: number | null; tags?: Record<string, string>; count?: number }[] | null;
}
export interface NotificationStatus { ready: boolean; reason: string; channel: string }
export interface Rpc { call<T = unknown>(method: string, params?: unknown): Promise<T> }
