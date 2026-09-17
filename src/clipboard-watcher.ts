import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { WebSocket } from "ws";

// Standalone script, run natively on the Windows desktop where PoE2 and
// Ctrl+C actually happen -- NOT part of src/serve.ts and never run inside
// the Docker container (a container cannot access the Windows clipboard).
//
// Uses a persistent PowerShell STA worker process to poll the clipboard
// every 200ms with near-zero CPU usage, eliminating game stutter/hiccups
// while Path of Exile 2 is running. Also connects to the server's WebSocket
// so the player can receive AI advisories (TTS / speech callouts) through
// desktop headphones/speakers while playing.

// Load .env if present
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {}
}

const SERVE_URL = (process.env.POE2_SERVE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const WEB_TOKEN = process.env.POE2_WEB_TOKEN;
const ITEM_MARKER = /^Item Class:/m;

function extractItemSummary(text: string): { name: string; itemClass: string; rarity: string } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  let itemClass = "Unknown";
  let rarity = "Normal";
  let name = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("Item Class:")) {
      itemClass = line.slice("Item Class:".length).trim();
    } else if (line.startsWith("Rarity:")) {
      rarity = line.slice("Rarity:".length).trim();
      if (rarity === "Rare" || rarity === "Unique") {
        name = lines[i + 1] ?? itemClass;
      } else {
        name = lines[i + 1] ?? itemClass;
      }
    }
  }

  return { name: name || itemClass, itemClass, rarity };
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
    throw new Error(`POST /api/clipboard-item failed (${res.status}): ${await res.text()}`);
  }
}

function speakOnDesktop(text: string): void {
  const clean = text.replace(/'/g, "''").replace(/[\r\n]+/g, " ");
  const psCommand = `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${clean}')`;
  spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", psCommand], {
    stdio: "ignore",
    detached: true,
  }).unref();
}

function connectWebSocket() {
  const wsUrl = `${SERVE_URL.replace(/^http/, "ws")}/ws${
    WEB_TOKEN ? `?token=${encodeURIComponent(WEB_TOKEN)}` : ""
  }`;

  let ws: WebSocket | null = null;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    setTimeout(connectWebSocket, 5000);
    return;
  }

  ws.on("open", () => {
    console.error(`[poe2-clipboard-watcher] Connected to server WebSocket at ${SERVE_URL}/ws`);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "advisory" && msg.action) {
        const action = msg.action;
        console.error(`[poe2-clipboard-watcher] Advisory [${action.urgency}]: ${action.message}`);
        if (action.type === "tts_callout") {
          speakOnDesktop(action.message);
        }
      }
    } catch {}
  });

  ws.on("error", () => {});
  ws.on("close", () => {
    setTimeout(connectWebSocket, 5000);
  });
}

/**
 * Starts a persistent PowerShell worker in STA mode that polls
 * [System.Windows.Forms.Clipboard]::GetText() every 200ms.
 * Emits base64-encoded item text when an "Item Class:" item is detected.
 */
function startPersistentClipboardProcess(
  onItemDetected: (text: string) => Promise<void>
): ChildProcess {
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$last = ""
try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $last = [System.Windows.Forms.Clipboard]::GetText() } } catch {}
[Console]::WriteLine("READY")
while ($true) {
    Start-Sleep -Milliseconds 200
    try {
        if ([System.Windows.Forms.Clipboard]::ContainsText()) {
            $text = [System.Windows.Forms.Clipboard]::GetText()
            if ($text -and $text -ne $last) {
                $last = $text
                if ($text -match "(?m)^Item Class:") {
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
                    $b64 = [Convert]::ToBase64String($bytes)
                    [Console]::WriteLine("POEITEM:" + $b64)
                }
            }
        }
    } catch {}
}
`;

  const child = spawn(
    "powershell",
    ["-Sta", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );

  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line === "READY") {
        console.error("[poe2-clipboard-watcher] Low-overhead clipboard engine active (0% game stutter).");
      } else if (line.startsWith("POEITEM:")) {
        const b64 = line.slice("POEITEM:".length).trim();
        try {
          const text = Buffer.from(b64, "base64").toString("utf8");
          if (ITEM_MARKER.test(text)) {
            onItemDetected(text).catch((err) => {
              console.error(
                "[poe2-clipboard-watcher] Failed to push item:",
                err instanceof Error ? err.message : err
              );
            });
          }
        } catch {}
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const errText = chunk.toString("utf8").trim();
    if (errText) {
      console.error("[poe2-clipboard-watcher] Engine stderr:", errText);
    }
  });

  return child;
}

async function main() {
  if (os.platform() !== "win32") {
    console.error(
      "[poe2-clipboard-watcher] Only supports Windows (runs natively on the gaming PC where PoE2 is played). " +
        "Not running on this platform."
    );
    process.exit(1);
  }

  console.error("===============================================================");
  console.error(" Path of Exile 2 - Live Ctrl+C Clipboard Watcher");
  console.error("===============================================================");
  console.error(` Target Server : ${SERVE_URL}`);
  console.error(` Auth Token    : ${WEB_TOKEN ? "Configured" : "None (LAN open)"}`);
  console.error(" Status        : Watching Windows clipboard for Ctrl+C item copies...");
  console.error("===============================================================");

  // Connect WebSocket for live advisories/TTS
  connectWebSocket();

  let child: ChildProcess | null = null;
  let isShuttingDown = false;

  const handleItem = async (text: string) => {
    const summary = extractItemSummary(text);
    console.error(
      `[poe2-clipboard-watcher] Copied item detected: "${summary.name}" (${summary.itemClass}, ${summary.rarity})`
    );
    try {
      await postClipboardItem(text);
      console.error(`[poe2-clipboard-watcher] -> Successfully sent to server! Available to AI and compare tool.`);
    } catch (err) {
      console.error(
        `[poe2-clipboard-watcher] -> Server unreachable at ${SERVE_URL} (${
          err instanceof Error ? err.message : err
        }). Ensure Docker or 'npm run serve' is running.`
      );
    }
  };

  const startWorker = () => {
    if (isShuttingDown) return;
    child = startPersistentClipboardProcess(handleItem);

    child.on("exit", (code) => {
      if (!isShuttingDown) {
        console.error(`[poe2-clipboard-watcher] Engine exited (code ${code}), restarting in 2 seconds...`);
        setTimeout(startWorker, 2000);
      }
    });

    child.on("error", (err) => {
      console.error("[poe2-clipboard-watcher] Engine spawn error:", err.message);
    });
  };

  startWorker();

  const shutdown = () => {
    isShuttingDown = true;
    if (child) child.kill();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
