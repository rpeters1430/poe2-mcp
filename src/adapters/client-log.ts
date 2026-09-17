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
  // PoE 2 loading screen pattern (emitted on every zone change)
  {
    type: "area_entered",
    regex: /^\[LOADING SCREEN\] \((.+?)\) Duration =/,
    extract: (m) => ({ area: m[1].trim() }),
  },
  // PoE 2 scene source change (e.g. [SCENE] Set Source [Kingsmarch])
  {
    type: "area_entered",
    regex: /^\[SCENE\] Set Source \[(?!\(null\)|\(unknown\)|Act \d+)(.+?)\]$/,
    extract: (m) => ({ area: m[1].trim() }),
  },
  // PoE 1 classic pattern
  {
    type: "area_entered",
    regex: /^You have entered (.+?)\.$/,
    extract: (m) => ({ area: m[1].trim() }),
  },
  {
    type: "level_up",
    regex: /^(.+?) \(.+?\) is now level (\d+)$/,
    extract: (m) => ({ character: m[1].trim(), level: Number(m[2]) }),
  },
  {
    type: "level_up",
    regex: /^(.+?) has reached level (\d+)$/,
    extract: (m) => ({ character: m[1].trim(), level: Number(m[2]) }),
  },
  // PoE 2 character death log (: <character> has been slain.)
  {
    type: "death",
    regex: /^(.+?) has been slain\.?$/,
    extract: (m) => ({ character: m[1].trim() }),
  },
  // Fallback death screen context layer (local player died)
  {
    type: "death",
    regex: /ID: DeathScreen/,
    extract: () => ({ character: "Character" }),
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
  private listeners: ((event: GameEvent) => void)[] = [];

  constructor(logPathOverride?: string) {
    this.logPath = logPathOverride ?? resolveClientLogPath();
  }

  getLogPath(): string | null {
    return this.logPath;
  }

  onEvent(listener: (event: GameEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Starts polling the log file for new lines. Safe to call once. */
  start(pollIntervalMs = 500): void {
    if (this.logPath) {
      try {
        const stat = fs.statSync(this.logPath);
        // Rather than starting at EOF and ignoring recent session events (deaths, zone entries),
        // read the recent window (up to 1MB) so the dashboard and AI have immediate context.
        const INITIAL_READ_BYTES = 1024 * 1024;
        this.offset = Math.max(0, stat.size - INITIAL_READ_BYTES);
        this.readChunk(true);
      } catch {
        this.offset = 0;
      }
    }
    this.pollHandle = setInterval(
      () => this.pollOnce().catch((e) => console.error("[poe2-mcp-server] log poll error:", e)),
      pollIntervalMs
    );
    this.pollHandle.unref();
  }

  stop(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }

  private async pollOnce(): Promise<void> {
    if (!this.logPath) {
      const discovered = resolveClientLogPath();
      if (discovered) {
        this.logPath = discovered;
        try {
          const stat = fs.statSync(this.logPath);
          const INITIAL_READ_BYTES = 1024 * 1024;
          this.offset = Math.max(0, stat.size - INITIAL_READ_BYTES);
          this.readChunk(true);
        } catch {
          this.offset = 0;
        }
      } else {
        return;
      }
    }

    this.readChunk(false);
  }

  private readChunk(isInitial = false): void {
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

    const bytesToRead = stat.size - this.offset;
    if (bytesToRead <= 0) return;

    try {
      const fd = fs.openSync(this.logPath, "r");
      let buffer: Buffer;
      try {
        buffer = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buffer, 0, bytesToRead, this.offset);
      } finally {
        fs.closeSync(fd);
      }

      // Find the last newline in the buffer to avoid splitting mid-line writes
      let lastNewline = -1;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i] === 0x0a) {
          lastNewline = i;
          break;
        }
      }

      // If no newline character found at all, wait for the full line to be written
      if (lastNewline === -1) {
        return;
      }

      let startIdx = 0;
      if (isInitial && this.offset > 0) {
        const firstNewline = buffer.indexOf(0x0a);
        if (firstNewline !== -1 && firstNewline < lastNewline) {
          startIdx = firstNewline + 1;
        }
      }

      const chunk = buffer.subarray(startIdx, lastNewline + 1).toString("utf8");
      const lines = chunk.split(/\r?\n/);
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const event = parseLine(line);
        if (event.type === "raw_unmatched") {
          this.rawEvents.push(event);
          if (this.rawEvents.length > RING_BUFFER_SIZE) this.rawEvents.shift();
          continue;
        }

        // Deduplication & enrichment
        if (event.type === "area_entered") {
          const last = this.events[this.events.length - 1];
          if (last && last.type === "area_entered" && last.data.area === event.data.area) {
            continue;
          }
        } else if (event.type === "death") {
          const last = this.events[this.events.length - 1];
          if (last && last.type === "death") {
            const dt = Math.abs(new Date(event.timestamp).getTime() - new Date(last.timestamp).getTime());
            if (dt < 3000) continue;
          }
          if (!event.data.area) {
            const current = this.getCurrentArea();
            if (current.area) event.data.area = current.area;
          }
        }

        this.events.push(event);
        if (this.events.length > RING_BUFFER_SIZE) this.events.shift();

        if (!isInitial) {
          for (const listener of this.listeners) {
            try {
              listener(event);
            } catch {}
          }
        }
      }

      this.offset += lastNewline + 1;
      if (isInitial && this.events.length > 0) {
        this.sessionStartedAt = this.events[0].timestamp;
      }
    } catch {
      // Handle temporary file lock during game write
      return;
    }
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
