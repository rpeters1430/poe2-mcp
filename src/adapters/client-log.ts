import fs from "node:fs";
import readline from "node:readline";
import { resolveClientLogPath } from "../config.js";
import type { GameEvent, GameEventType, CurrentAreaSnapshot, SessionSummary } from "../types.js";

/**
 * Tails PoE2's Client.txt and parses it into structured GameEvents.
 *
 * IMPORTANT: the line patterns below are best-effort, based on long-standing
 * community knowledge of PoE1's (shared-engine) log format. GGG does not
 * publish a spec for this file, and exact wording can shift between
 * patches/locales. Unmatched lines are retained in a separate diagnostics
 * buffer and surfaced only when explicitly requested -- if you notice a pattern not firing, tail
 * your own Client.txt (`tail -f logs/Client.txt`), find the real line, and
 * adjust the regex below.
 */

interface LinePattern {
  type: GameEventType;
  regex: RegExp;
  extract: (m: RegExpMatchArray) => Record<string, string | number | null>;
}

// Typical PoE line prefix: "2024/01/15 12:34:56 123456789 1a2b3c4d [INFO Client 1234] "
const TIMESTAMP_PREFIX = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/;

const PATTERNS: LinePattern[] = [
  {
    type: "area_entered",
    regex: /^You have entered (.+?)\.$/,
    extract: (m) => ({ area: m[1] }),
  },
  {
    type: "level_up",
    regex: /^(.+?) \(.+?\) is now level (\d+)$/,
    extract: (m) => ({ character: m[1], level: Number(m[2]) }),
  },
  {
    type: "level_up",
    regex: /^(.+?) has reached level (\d+)$/,
    extract: (m) => ({ character: m[1], level: Number(m[2]) }),
  },
  {
    type: "death",
    regex: /^(.+?) has been slain\.?$/,
    extract: (m) => ({ character: m[1] }),
  },
  {
    type: "trade_whisper",
    regex: /^@(From|To) (.+?): (.+)$/,
    extract: (m) => ({ direction: m[1], player: m[2], message: m[3] }),
  },
  {
    type: "instance_created",
    regex: /^Generating level (\d+) area "(.+?)" with seed (\d+)$/,
    extract: (m) => ({ areaLevel: Number(m[1]), areaId: m[2], seed: Number(m[3]) }),
  },
];

const CHAT_PREFIX = /^(?:@(From|To)\s|[#\$&%]|<Guild>\s)/i;

function messageFromLine(line: string): string {
  const closingBracket = line.indexOf("] ");
  const payload = closingBracket >= 0 ? line.slice(closingBracket + 2) : line;
  return payload.trimStart().replace(/^:\s*/, "");
}

export function parseLine(line: string): GameEvent {
  const tsMatch = line.match(TIMESTAMP_PREFIX);
  const timestamp = tsMatch ? new Date(tsMatch[1].replace(/\//g, "-")).toISOString() : new Date().toISOString();
  const message = messageFromLine(line);

  // Chat is third-party, untrusted content. Classify it before game-system
  // patterns so a whisper such as "You have entered ..." cannot spoof state.
  if (CHAT_PREFIX.test(message)) {
    const whisper = message.match(/^@(From|To) (.+?): (.+)$/);
    if (whisper) {
      return {
        type: "trade_whisper",
        timestamp,
        raw: line,
        data: { direction: whisper[1], player: whisper[2], message: whisper[3], untrusted: true },
      };
    }
    return { type: "player_message", timestamp, raw: line, data: { message, untrusted: true } };
  }

  for (const pattern of PATTERNS) {
    const m = message.match(pattern.regex);
    if (m) {
      return { type: pattern.type, timestamp, raw: line, data: pattern.extract(m) };
    }
  }
  return { type: "raw_unmatched", timestamp, raw: line, data: {} };
}

const RING_BUFFER_SIZE = 500;

export class ClientLogTailer {
  private logPath: string | null;
  private offset = 0;
  private events: GameEvent[] = [];
  private rawEvents: GameEvent[] = [];
  private pollHandle: NodeJS.Timeout | null = null;
  private sessionStartedAt = new Date().toISOString();

  constructor(logPathOverride?: string) {
    this.logPath = logPathOverride ?? resolveClientLogPath();
  }

  getLogPath(): string | null {
    return this.logPath;
  }

  /** Starts polling the log file for new lines. Safe to call once. */
  start(pollIntervalMs = 1000): void {
    if (!this.logPath) {
      console.error(
        "[poe2-mcp-server] No Client.txt found. Set POE2_CLIENT_LOG_PATH explicitly -- see README.md."
      );
      return;
    }
    // Start at end of file: we only care about events from now on.
    try {
      this.offset = fs.statSync(this.logPath).size;
    } catch {
      this.offset = 0;
    }
    this.pollHandle = setInterval(() => this.pollOnce().catch((e) => console.error("[poe2-mcp-server] log poll error:", e)), pollIntervalMs);
    this.pollHandle.unref();
  }

  stop(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }

  private async pollOnce(): Promise<void> {
    if (!this.logPath) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.logPath);
    } catch {
      return; // file temporarily unavailable
    }

    if (stat.size < this.offset) {
      // Log was rotated/truncated (e.g. game restarted).
      this.offset = 0;
    }
    if (stat.size === this.offset) return;

    const stream = fs.createReadStream(this.logPath, { start: this.offset, end: stat.size - 1, encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      const event = parseLine(line);
      const buffer = event.type === "raw_unmatched" ? this.rawEvents : this.events;
      buffer.push(event);
      if (buffer.length > RING_BUFFER_SIZE) buffer.shift();
    }
    this.offset = stat.size;
  }

  getRecentEvents(opts: { sinceIso?: string; limit?: number; types?: GameEventType[] } = {}): GameEvent[] {
    const wantsRaw = opts.types?.includes("raw_unmatched") ?? false;
    let filtered = wantsRaw
      ? [...this.events, ...this.rawEvents].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      : this.events;
    if (opts.sinceIso) {
      filtered = filtered.filter((e) => e.timestamp >= opts.sinceIso!);
    }
    if (opts.types && opts.types.length > 0) {
      filtered = filtered.filter((e) => opts.types!.includes(e.type));
    }
    const limit = opts.limit ?? 50;
    return filtered.slice(-limit);
  }

  getCurrentArea(): CurrentAreaSnapshot {
    const last = [...this.events].reverse().find((e) => e.type === "area_entered");
    return {
      source: "client_log",
      queriedAt: new Date().toISOString(),
      area: last ? (last.data.area as string) : null,
      enteredAt: last ? last.timestamp : null,
    };
  }

  getSessionSummary(): SessionSummary {
    const areas = new Set(this.events.filter((e) => e.type === "area_entered").map((e) => e.data.area));
    const deaths = this.events.filter((e) => e.type === "death").length;
    const levelUps = this.events.filter((e) => e.type === "level_up").length;
    const current = this.getCurrentArea();
    return {
      source: "client_log",
      sessionStartedAt: this.sessionStartedAt,
      queriedAt: new Date().toISOString(),
      areasVisited: areas.size,
      deaths,
      levelUps,
      lastKnownArea: current.area,
    };
  }
}
