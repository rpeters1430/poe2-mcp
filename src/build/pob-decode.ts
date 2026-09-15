import zlib from "node:zlib";

export const MAX_POB_INPUT_BYTES = 5 * 1024 * 1024;
export const MAX_POB_XML_BYTES = 20 * 1024 * 1024;
const MAX_REMOTE_BYTES = 5 * 1024 * 1024;
const MAX_RESOLUTION_DEPTH = 3;
const FETCH_TIMEOUT_MS = 10_000;
const ALLOWED_REMOTE_HOSTS = new Set(["pobb.in", "www.pobb.in", "pastebin.com", "www.pastebin.com", "poe.ninja", "www.poe.ninja"]);

function assertSize(text: string, maxBytes: number, label: string): void {
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes} byte safety limit.`);
  }
}

function assertAllowedRemote(url: URL): void {
  if (url.protocol !== "https:" || !ALLOWED_REMOTE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`Remote PoB imports are not allowed from ${url.hostname || url.toString()}.`);
  }
  if (url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("Remote PoB import URLs may not contain credentials or nonstandard ports.");
  }
}

async function fetchTextLimited(input: string, redirectsLeft = 3): Promise<string> {
  const url = new URL(input);
  assertAllowedRemote(url);
  const resp = await fetch(url, {
    headers: { "User-Agent": "poe2-mcp-server/0.1.0" },
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (resp.status >= 300 && resp.status < 400) {
    if (redirectsLeft <= 0) throw new Error("Remote PoB import exceeded the redirect limit.");
    const location = resp.headers.get("location");
    if (!location) throw new Error(`Remote PoB import returned HTTP ${resp.status} without a redirect location.`);
    return fetchTextLimited(new URL(location, url).toString(), redirectsLeft - 1);
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

  const declaredLength = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_BYTES) {
    throw new Error(`Remote PoB import exceeds the ${MAX_REMOTE_BYTES} byte safety limit.`);
  }
  if (!resp.body) return "";

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REMOTE_BYTES) {
      await reader.cancel();
      throw new Error(`Remote PoB import exceeds the ${MAX_REMOTE_BYTES} byte safety limit.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Decodes a PoB2 "Generate POB Code" share code into its build XML.
 * Confirmed from PoB2 source (Classes/ImportTab.lua): URL-safe base64
 * ('+'/'/' -> '-'/'_', no padding) wrapping a Deflate-compressed XML string.
 * Tries raw DEFLATE, zlib-wrapped, and gzip.
 */
export function decodePobCode(code: string): string {
  assertSize(code, MAX_POB_INPUT_BYTES, "PoB share code");
  let normalized = code.trim().replace(/\s+/g, "");
  // Remove wrapping quotes if present
  if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1).trim();
  }

  const standardBase64 = normalized.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standardBase64 + "=".repeat((4 - (standardBase64.length % 4)) % 4);
  const compressed = Buffer.from(padded, "base64");

  try {
    return zlib.inflateRawSync(compressed, { maxOutputLength: MAX_POB_XML_BYTES }).toString("utf8");
  } catch {
    try {
      return zlib.inflateSync(compressed, { maxOutputLength: MAX_POB_XML_BYTES }).toString("utf8");
    } catch {
      try {
        return zlib.gunzipSync(compressed, { maxOutputLength: MAX_POB_XML_BYTES }).toString("utf8");
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
export async function resolvePobXml(input: string, depth = 0): Promise<string> {
  if (depth > MAX_RESOLUTION_DEPTH) {
    throw new Error("PoB import exceeded the maximum nested resolution depth.");
  }
  assertSize(input, MAX_POB_XML_BYTES, "PoB input");
  let trimmed = stripMarkdownFences(input).replace(/^\uFEFF/, "").trim();

  // 1. Raw build XML
  if (trimmed.startsWith("<")) return trimmed;

  // 3. pobb.in URL (e.g. https://pobb.in/XYZ or pobb.in/XYZ)
  const pobbMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?pobb\.in\/([a-zA-Z0-9_-]+)(?:\/raw)?/i);
  if (pobbMatch && !trimmed.startsWith("<?xml")) {
    const id = pobbMatch[1];
    const url = `https://pobb.in/${id}/raw`;
    try {
      const body = (await fetchTextLimited(url)).trim();
      return resolvePobXml(body, depth + 1);
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
      const data = JSON.parse(await fetchTextLimited(url)) as any;
      if (!data.charModel?.pathOfBuildingExport) {
        throw new Error("poe.ninja character profile did not contain a Path of Building export");
      }
      return resolvePobXml(data.charModel.pathOfBuildingExport, depth + 1);
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
      const body = (await fetchTextLimited(url)).trim();
      return resolvePobXml(body, depth + 1);
    } catch (err: any) {
      throw new Error(`Failed to fetch build from pastebin (${url}): ${err.message ?? err}`);
    }
  }

  // 6. Reject generic URLs. Only the explicitly supported hosts above are
  // allowed, so an MCP caller cannot use this tool to probe local services.
  if (/^https?:\/\//i.test(trimmed)) {
    throw new Error("Generic URL imports are disabled. Use a pobb.in, pastebin.com, or poe.ninja URL.");
  }

  // 7. Base64 share code
  return decodePobCode(trimmed);
}
