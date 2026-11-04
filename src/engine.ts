import { monitorKeys } from "./config.ts";
import type { BlockDirection, Config, Evidence, Monitor, Sample, Transition } from "./types.ts";

export function newMonitor(now: number, previous?: Monitor): Monitor {
  return {
    health: "initializing", alarm: previous?.alarm ?? false,
    alarmDirection: previous?.alarm ? previous.alarmDirection ?? null : null, candidateDirection: null,
    blockedSince: previous?.blockedSince ?? null, suspectSince: null,
    failureStreak: 0, recoveryStreak: 0, after: {}, latest: {}, lastRoundAt: null, effectiveSince: now,
  };
}
export function resetStreaks(state: Monitor): void {
  state.failureStreak = 0;
  state.recoveryStreak = 0;
  state.suspectSince = null;
  state.candidateDirection = null;
}
export function staleAfter(config: Config): number { return config.intervalSeconds * 2000 + 15000; }

export function evaluate(state: Monitor, samples: Record<string, Sample[]>, config: Config, uuid: string, now: number): Transition[] {
  // Pre-0.1.5 strict alarms could only be bidirectional. Keep them without replay.
  state.alarmDirection = state.alarm ? state.alarmDirection ?? (config.strict ? "both" : "basic") : null;
  const keys = monitorKeys(config, uuid);
  const events: Transition[] = [];
  const skew = Math.min(15000, config.intervalSeconds * 450);
  const freshness = staleAfter(config);
  const queues: Record<string, Sample[]> = {};
  for (const key of keys) {
    const unique = new Map<number, Sample>();
    for (const s of samples[key] ?? []) {
      if (Number.isFinite(s.at) && Number.isFinite(s.value) && s.at >= state.effectiveSince && s.at <= now && now - s.at <= freshness) unique.set(s.at, s);
    }
    const sorted = [...unique.values()].sort((a, b) => a.at - b.at);
    const latest = sorted.at(-1);
    if (latest && latest.at > (state.latest[key]?.at ?? 0)) state.latest[key] = latest;
    queues[key] = sorted.filter(s => s.at > (state.after[key] ?? 0));
  }
  while (keys.every(k => queues[k].length)) {
    const times = keys.map(k => queues[k][0].at);
    const min = Math.min(...times), max = Math.max(...times);
    if (max - min > skew) {
      for (const key of keys.filter(k => queues[k][0].at === min)) state.after[key] = queues[key].shift()!.at;
      resetStreaks(state);
      continue;
    }
    const round: Record<string, Sample> = {};
    for (const key of keys) {
      round[key] = queues[key].shift()!;
      state.after[key] = round[key].at;
    }
    if (state.lastRoundAt !== null && max - state.lastRoundAt > config.intervalSeconds * 1600) resetStreaks(state);
    state.lastRoundAt = max;
    const evidence: Evidence = {
      mainland: ["cn1", "cn2", "cn3"].filter(k => round[k].value >= 0).length,
      overseas: ["global1", "global2"].filter(k => round[k].value >= 0).length,
      reverse: keys.filter(k => k.startsWith("reverse:") && round[k].value >= 0).length,
      reverseTotal: keys.filter(k => k.startsWith("reverse:")).length,
    };
    let direction: BlockDirection | null = null;
    if (evidence.overseas >= config.overseasRequired) {
      if (!config.strict) direction = evidence.mainland === 0 ? "basic" : null;
      else if (evidence.reverseTotal > 0) {
        if (evidence.mainland === 0 && evidence.reverse === 0) direction = "both";
        else if (evidence.mainland === 0 && evidence.reverse === evidence.reverseTotal) direction = "reverse";
        else if (evidence.mainland === 3 && evidence.reverse === 0) direction = "forward";
      }
    }
    const healthy = evidence.mainland === 3 && evidence.overseas === 2 && evidence.reverse === evidence.reverseTotal;
    if (direction) {
      state.health = "suspect";
      if (state.candidateDirection !== direction) { state.failureStreak = 0; state.suspectSince = null; }
      state.candidateDirection = direction;
      state.failureStreak++;
      state.recoveryStreak = 0;
      state.suspectSince ??= min;
      if ((!state.alarm || state.alarmDirection !== direction) && state.failureStreak >= config.failureThreshold) {
        const previousDirection = state.alarm ? state.alarmDirection! : undefined;
        state.alarm = true;
        state.alarmDirection = direction;
        state.blockedSince ??= state.suspectSince;
        events.push({ ...evidence, type: "blocked", direction, ...(previousDirection ? { previousDirection } : {}), at: max, since: state.blockedSince });
      }
    } else if (healthy) {
      state.health = "healthy";
      state.failureStreak = 0;
      state.suspectSince = null;
      state.candidateDirection = null;
      state.recoveryStreak++;
      if (state.alarm && state.recoveryStreak >= config.recoveryThreshold) {
        events.push({ ...evidence, type: "recovered", direction: state.alarmDirection!, at: max, since: state.blockedSince ?? max });
        state.alarm = false;
        state.alarmDirection = null;
        state.blockedSince = null;
      }
    } else {
      state.health = evidence.mainland === 0 && evidence.overseas === 0 && evidence.reverse === 0 ? "outage" : "degraded";
      resetStreaks(state);
    }
    state.failureStreak = Math.min(state.failureStreak, config.failureThreshold);
    state.recoveryStreak = Math.min(state.recoveryStreak, config.recoveryThreshold);
  }
  if (keys.some(k => !state.latest[k] || now - state.latest[k].at > freshness) || (state.lastRoundAt !== null && now - state.lastRoundAt > freshness)) {
    state.health = now - state.effectiveSince <= freshness && state.lastRoundAt === null ? "initializing" : "unknown";
    resetStreaks(state);
  }
  return events;
}
