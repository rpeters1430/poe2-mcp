import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Where the server keeps its own state: OAuth tokens, and nothing else.
 * Never put game credentials or tokens in the project directory / git repo.
 */
export function configDir(): string {
  const base =
    process.env.POE2_MCP_CONFIG_DIR ??
    path.join(os.homedir(), ".config", "poe2-mcp-server");
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return base;
}

export function tokenStorePath(): string {
  return path.join(configDir(), "tokens.json");
}

/**
 * Best-effort candidate locations for PoE2's Client.txt log file, by
 * platform and launcher. These are community-known defaults, not something
 * GGG documents formally, so they can drift. Always prefer
 * POE2_CLIENT_LOG_PATH if the user has set it explicitly.
 *
 * Linux note: when PoE2 runs under Steam Play (Proton), simple relative
 * writes like "logs/Client.txt" typically still land in the real
 * steamapps/common install directory rather than inside the Proton prefix's
 * virtual C: drive -- but this isn't guaranteed across every Steam/Proton/
 * Lutris configuration, so treat the Linux candidates as a starting point
 * and verify the file actually exists and is growing before relying on it.
 */
export function candidateClientLogPaths(): string[] {
  const home = os.homedir();
  const platform = os.platform();
  const candidates: string[] = [];

  if (platform === "win32") {
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    candidates.push(
      path.join(pf86, "Steam", "steamapps", "common", "Path of Exile 2", "logs", "Client.txt"),
      path.join(pf86, "Grinding Gear Games", "Path of Exile 2", "logs", "Client.txt"),
      path.join(pf, "Epic Games", "PathOfExile2", "logs", "Client.txt")
    );
  } else if (platform === "darwin") {
    // PoE2 has no native macOS client at the time of writing; included for
    // completeness in case of a CrossOver/Parallels install pointed here.
    candidates.push(
      path.join(home, "Library", "Application Support", "Path of Exile 2", "logs", "Client.txt")
    );
  } else {
    // Linux, typically via Steam Play/Proton.
    candidates.push(
      path.join(home, ".local", "share", "Steam", "steamapps", "common", "Path of Exile 2", "logs", "Client.txt"),
      path.join(home, ".steam", "steam", "steamapps", "common", "Path of Exile 2", "logs", "Client.txt"),
      path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam", "steamapps", "common", "Path of Exile 2", "logs", "Client.txt")
    );
  }

  return candidates;
}

export function resolveClientLogPath(): string | null {
  const explicit = process.env.POE2_CLIENT_LOG_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (explicit) {
    // User pointed us somewhere specific -- surface that it's missing rather
    // than silently falling back, since a wrong path fails quietly otherwise.
    console.error(`[poe2-mcp-server] POE2_CLIENT_LOG_PATH is set but does not exist: ${explicit}`);
  }
  for (const candidate of candidateClientLogPaths()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Best-effort candidate locations for Path of Building 2's Builds folder.
 * Verified against PoB2's own resolution logic (Modules/Main.lua): installed
 * mode saves to "<user documents path>/Path of Building (PoE2)/Builds/", with
 * a custom override persisted in that folder's Settings.xml -- see
 * `pobSettingsBuildPathOverride` below. The exact OS-level resolution of PoB's
 * "user path" wasn't independently verified (it's inside the SimpleGraphic
 * engine, not this project's source), so treat these as a starting point:
 * verify the file actually exists before relying on it, same caveat as
 * `candidateClientLogPaths` above.
 */
export function candidatePobBuildsPaths(): string[] {
  const home = os.homedir();
  return [
    path.join(home, "Documents", "Path of Building (PoE2)", "Builds"),
    path.join(home, "OneDrive", "Documents", "Path of Building (PoE2)", "Builds"),
  ];
}

/**
 * PoB persists a custom build save path in a `buildPath` attribute on
 * Settings.xml, next to the default Builds folder. Best-effort: returns null
 * on anything unexpected rather than throwing, since this is a convenience
 * override, not a required input.
 */
function pobSettingsBuildPathOverride(buildsDir: string): string | null {
  const settingsPath = path.join(path.dirname(buildsDir), "Settings.xml");
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const match = raw.match(/buildPath="([^"]+)"/);
    if (match && fs.existsSync(match[1])) return match[1];
  } catch {
    // Settings.xml not present or unreadable -- fall through to the default.
  }
  return null;
}

export function resolvePobBuildsDir(): string | null {
  const explicit = process.env.POE2_POB_BUILDS_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (explicit) {
    console.error(`[poe2-mcp-server] POE2_POB_BUILDS_PATH is set but does not exist: ${explicit}`);
  }
  for (const candidate of candidatePobBuildsPaths()) {
    const override = pobSettingsBuildPathOverride(candidate);
    if (override) return override;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export const GGG_API_BASE = process.env.POE2_GGG_API_BASE ?? "https://api.pathofexile.com";
export const GGG_OAUTH_BASE = process.env.POE2_GGG_OAUTH_BASE ?? "https://www.pathofexile.com/oauth";
export const GGG_REALM = "poe2";

export function resolveAccountName(): string | null {
  const explicit = process.env.POE2_ACCOUNT_NAME;
  if (explicit && explicit.trim()) return explicit.trim();
  const filePath = path.join(configDir(), "account-name.json");
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return data.accountName ?? null;
  } catch {
    return null;
  }
}

export function saveAccountName(accountName: string): void {
  const filePath = path.join(configDir(), "account-name.json");
  fs.writeFileSync(
    filePath,
    JSON.stringify({ accountName: accountName.trim(), setAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

/**
 * GGG requires every OAuth client to send a descriptive User-Agent that
 * identifies the application and a contact, per their API rules. Set
 * POE2_CONTACT_EMAIL to yours before running.
 */
export function userAgent(): string {
  const contact = process.env.POE2_CONTACT_EMAIL ?? "unknown-contact";
  return `poe2-mcp-server/0.1.0 (contact: ${contact})`;
}
