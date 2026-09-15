import fs from "node:fs";
import zlib from "node:zlib";

/**
 * Decodes a PoB2 "Generate POB Code" share code into its build XML.
 * Confirmed from PoB2 source (Classes/ImportTab.lua): URL-safe base64
 * ('+'/'/' -> '-'/'_', no padding) wrapping a Deflate-compressed XML string.
 * Tries raw DEFLATE, zlib-wrapped, and gzip.
 */
export function decodePobCode(code: string): string {
  let normalized = code.trim().replace(/\s+/g, "");
  // Remove wrapping quotes if present
  if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1).trim();
  }

  const standardBase64 = normalized.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standardBase64 + "=".repeat((4 - (standardBase64.length % 4)) % 4);
  const compressed = Buffer.from(padded, "base64");

  try {
    return zlib.inflateRawSync(compressed).toString("utf8");
  } catch {
    try {
      return zlib.inflateSync(compressed).toString("utf8");
    } catch {
      try {
        return zlib.gunzipSync(compressed).toString("utf8");
      } catch {
        if (normalized.length < 150) {
          throw new Error(
            `Could not decompress PoB2 share code (string length is only ${normalized.length} characters). ` +
              "Standard PoB share codes are typically thousands of characters long. " +
              "Check if the code was truncated, or if you meant to provide a file path or a pobb.in URL."
          );
        }
        throw new Error(
          "Could not decompress this as a PoB2 share code (tried raw DEFLATE, zlib-wrapped, and gzip). " +
            "If this was meant to be raw build XML instead, pass it through unchanged; otherwise re-copy " +
            "the code from PoB2's export/share dialog."
        );
      }
    }
  }
}

/**
 * Strips markdown code block wrappers (e.g. ```xml ... ``` or ``` ... ```)
 */
function stripMarkdownFences(input: string): string {
  let text = input.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z0-9_-]*\r?\n?/, "").replace(/\r?\n?```$/, "").trim();
  }
  return text;
}

/**
 * Auto-detects whether `input` is:
 * 1. Raw build XML (starts with '<')
 * 2. A local file path on disk
 * 3. A pobb.in or pastebin URL (fetched automatically)
 * 4. A base64 Deflate share code needing decode
 */
export async function resolvePobXml(input: string): Promise<string> {
  let trimmed = stripMarkdownFences(input).replace(/^\uFEFF/, "").trim();

  // 1. Raw build XML
  if (trimmed.startsWith("<")) return trimmed;

  // 2. Local file path passed to `code` instead of `filePath`
  if (fs.existsSync(trimmed)) {
    try {
      const stat = fs.statSync(trimmed);
      if (stat.isFile()) {
        const fileContent = fs.readFileSync(trimmed, "utf8").trim();
        return resolvePobXml(fileContent);
      }
    } catch {
      // Continue to next handlers if stat or read fails
    }
  }

  // 3. pobb.in URL (e.g. https://pobb.in/XYZ or pobb.in/XYZ)
  const pobbMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?pobb\.in\/([a-zA-Z0-9_-]+)(?:\/raw)?/i);
  if (pobbMatch && !trimmed.startsWith("<?xml")) {
    const id = pobbMatch[1];
    const url = `https://pobb.in/${id}/raw`;
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "poe2-mcp-server/0.1.0" },
      });
      if (!resp.ok) {
        throw new Error(`pobb.in returned HTTP ${resp.status} ${resp.statusText}`);
      }
      const body = (await resp.text()).trim();
      return resolvePobXml(body);
    } catch (err: any) {
      throw new Error(`Failed to fetch build from pobb.in (${url}): ${err.message ?? err}`);
    }
  }

  // 4. poe.ninja profile URL (e.g. https://poe.ninja/poe2/profile/account/league/character/name)
  const ninjaMatch = trimmed.match(
    /(?:https?:\/\/)?(?:www\.)?poe\.ninja\/(?:poe2|poe1)\/profile\/([^\/]+)\/([^\/]+)\/character\/([^\/\?#]+)/i
  );
  if (ninjaMatch) {
    const account = ninjaMatch[1];
    const league = ninjaMatch[2];
    const character = ninjaMatch[3];
    const url = `https://poe.ninja/poe2/api/profile/characters/${encodeURIComponent(account)}/${encodeURIComponent(league)}/${encodeURIComponent(character)}/model/0`;
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "poe2-mcp-server/0.1.0" },
      });
      if (!resp.ok) {
        throw new Error(`poe.ninja returned HTTP ${resp.status} ${resp.statusText}`);
      }
      const data = (await resp.json()) as any;
      if (!data.charModel?.pathOfBuildingExport) {
        throw new Error("poe.ninja character profile did not contain a Path of Building export");
      }
      return resolvePobXml(data.charModel.pathOfBuildingExport);
    } catch (err: any) {
      throw new Error(`Failed to fetch build from poe.ninja (${url}): ${err.message ?? err}`);
    }
  }

  // 5. pastebin.com URL (e.g. https://pastebin.com/XYZ)
  const pbMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?pastebin\.com\/(?:raw\/)?([a-zA-Z0-9]+)/i);
  if (pbMatch) {
    const id = pbMatch[1];
    const url = `https://pastebin.com/raw/${id}`;
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "poe2-mcp-server/0.1.0" },
      });
      if (!resp.ok) {
        throw new Error(`pastebin returned HTTP ${resp.status} ${resp.statusText}`);
      }
      const body = (await resp.text()).trim();
      return resolvePobXml(body);
    } catch (err: any) {
      throw new Error(`Failed to fetch build from pastebin (${url}): ${err.message ?? err}`);
    }
  }

  // 6. Generic HTTP(S) URL
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const resp = await fetch(trimmed, {
        headers: { "User-Agent": "poe2-mcp-server/0.1.0" },
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }
      const body = (await resp.text()).trim();
      return resolvePobXml(body);
    } catch (err: any) {
      throw new Error(`Failed to fetch build from ${trimmed}: ${err.message ?? err}`);
    }
  }

  // 7. Base64 share code
  return decodePobCode(trimmed);
}
