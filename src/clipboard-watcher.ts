import { spawn } from "node:child_process";
import os from "node:os";

// Standalone script, run natively on the Windows desktop where PoE2 and
// Ctrl+C actually happen -- NOT part of src/serve.ts and never run inside
// the Docker container (a container can't see the Windows clipboard even
// under Docker Desktop's WSL2 backend). Polls the clipboard the same way
// src/advisory/dispatch.ts already shells out to Windows tools
// (powershell/msg.exe) for notifications/TTS, so no new dependency is
// needed just to read the clipboard.

const SERVE_URL = (process.env.POE2_SERVE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const WEB_TOKEN = process.env.POE2_WEB_TOKEN;
const POLL_MS = 750;
// PoE2's clipboard item-text format (Ctrl+C in-game, or copied from a trade
// site) always starts with this line -- same "verify against reality, keep
// the heuristic simple" approach as client-log.ts's PATTERNS.
const ITEM_MARKER = /^Item Class:/m;

function readClipboard(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(out.replace(/\r\n/g, "\n"));
      else reject(new Error(err.trim() || `Get-Clipboard exited ${code}`));
    });
  });
}

async function postClipboardItem(text: string): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (WEB_TOKEN) headers["X-POE2-Token"] = WEB_TOKEN;
  const res = await fetch(`${SERVE_URL}/api/clipboard-item`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/clipboard-item failed: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  if (os.platform() !== "win32") {
    console.error(
      "[poe2-clipboard-watcher] only supports Windows (reads the clipboard via PowerShell's Get-Clipboard). " +
        "Not running on this platform."
    );
    process.exit(1);
  }

  console.error(`[poe2-clipboard-watcher] watching clipboard, posting matches to ${SERVE_URL}/api/clipboard-item`);

  let last = "";
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      let text: string;
      try {
        text = await readClipboard();
      } catch {
        // Clipboard holds non-text content (e.g. an image), or PowerShell
        // isn't reachable this tick -- ignore and try again next poll.
        return;
      }
      if (text === last) return;
      last = text;
      if (!ITEM_MARKER.test(text)) return;
      try {
        await postClipboardItem(text);
        console.error(`[poe2-clipboard-watcher] pushed item text (${text.length} chars)`);
      } catch (err) {
        console.error(
          "[poe2-clipboard-watcher] failed to push clipboard item:",
          err instanceof Error ? err.message : err
        );
      }
    } finally {
      busy = false;
    }
  }, POLL_MS);
}

main();
