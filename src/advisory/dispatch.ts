import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdvisoryAction, AdvisoryResult } from "../types.js";
import { broadcastAdvisory } from "../web/ws.js";

/**
 * Fulfills an AdvisoryAction from the AI. Every branch here is a side
 * channel that reaches the PLAYER, never the game process: a log line, an OS
 * notification, spoken audio, or an overlay message file a separate overlay
 * UI can watch and render. None of this sends input to PoE2 or reads/writes
 * its memory -- see PROTOCOL.md "Why advisory-only".
 */

function logFilePath(): string {
  const dir = path.join(os.homedir(), ".local", "state", "poe2-mcp-server");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "advisory.log");
}

function overlayFilePath(): string {
  const dir = path.join(os.homedir(), ".local", "state", "poe2-mcp-server");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "overlay-latest.json");
}

async function runCommand(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

/**
 * Escapes a string for embedding inside an AppleScript double-quoted string
 * literal. Backslashes MUST be escaped before quotes -- escaping quotes
 * first (a bug this project used to have) leaves a raw trailing backslash
 * in front of the newly-inserted `\"`, which AppleScript then reads as an
 * escaped backslash followed by an unescaped quote, closing the string
 * early and letting anything after it (e.g. `& do shell script "..."`) run
 * as a new statement. `message` here can contain untrusted third-party text
 * an AI relayed through emit_advisory (chat/trade whispers are explicitly
 * labeled `untrusted` by client-log.ts), so this isn't just theoretical.
 */
export function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}

async function sendDesktopNotification(title: string, body: string): Promise<void> {
  const platform = os.platform();
  if (platform === "linux") {
    await runCommand("notify-send", [title, body]);
  } else if (platform === "darwin") {
    const script = `display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(title)}"`;
    await runCommand("osascript", ["-e", script]);
  } else if (platform === "win32") {
    // BurntToast or similar isn't guaranteed installed; msg.exe is a
    // reasonable zero-dependency fallback for a local notification.
    await runCommand("msg.exe", ["*", `${title}: ${body}`]);
  } else {
    throw new Error(`No notification method wired up for platform ${platform}`);
  }
}

let lastTtsTimestamp = 0;
const TTS_MIN_COOLDOWN_MS = 1500;

async function speak(rawText: string): Promise<void> {
  const sanitized = rawText.replace(/[\r\n\t]+/g, " ").trim().slice(0, 300);
  if (!sanitized) return;

  const now = Date.now();
  const elapsed = now - lastTtsTimestamp;
  if (elapsed < TTS_MIN_COOLDOWN_MS) {
    await new Promise((resolve) => setTimeout(resolve, TTS_MIN_COOLDOWN_MS - elapsed));
  }
  lastTtsTimestamp = Date.now();

  const platform = os.platform();
  if (platform === "linux") {
    // Requires `espeak-ng` or similar TTS to be installed; adjust as needed.
    await runCommand("espeak-ng", [sanitized]);
  } else if (platform === "darwin") {
    await runCommand("say", [sanitized]);
  } else if (platform === "win32") {
    const psCommand = `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${sanitized.replace(/'/g, "''")}')`;
    await runCommand("powershell", ["-Command", psCommand]);
  } else {
    throw new Error(`No TTS method wired up for platform ${platform}`);
  }
}

export async function dispatchAdvisory(action: AdvisoryAction): Promise<AdvisoryResult> {
  const dispatchedAt = new Date().toISOString();
  let wsBroadcasted = false;
  try {
    broadcastAdvisory(action);
    wsBroadcasted = true;
  } catch {}

  try {
    switch (action.type) {
      case "log_note": {
        fs.appendFileSync(
          logFilePath(),
          `${dispatchedAt} [${action.urgency}]${action.reason ? ` (${action.reason})` : ""} ${action.message}\n`
        );
        break;
      }
      case "overlay_message": {
        // A separate lightweight overlay UI (not included here) can watch
        // this file and render it -- this server never draws pixels itself.
        fs.writeFileSync(
          overlayFilePath(),
          JSON.stringify({ ...action, dispatchedAt }, null, 2)
        );
        break;
      }
      case "desktop_notification": {
        await sendDesktopNotification(
          action.urgency === "critical" ? "PoE2 Advisor (!)" : "PoE2 Advisor",
          action.message
        );
        break;
      }
      case "tts_callout": {
        await speak(action.message);
        break;
      }
      default: {
        const _exhaustive: never = action.type;
        throw new Error(`Unknown advisory type: ${_exhaustive}`);
      }
    }
    return { delivered: true, dispatchedVia: action.type, dispatchedAt };
  } catch (err) {
    if (wsBroadcasted) {
      return {
        delivered: true,
        dispatchedVia: action.type,
        dispatchedAt,
        error: `Local OS command failed (${err instanceof Error ? err.message : String(err)}), but advisory was broadcast to connected dashboard/watcher clients via WebSocket.`,
      };
    }
    return {
      delivered: false,
      dispatchedVia: action.type,
      dispatchedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
