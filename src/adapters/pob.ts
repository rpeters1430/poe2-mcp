import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * I/O side of the Path of Building 2 integration: is it running, what builds
 * has it saved recently, and reading a build file's raw bytes. No parsing
 * here -- see build/pob-decode.ts and build/pob-parser.ts for that.
 *
 * There is no supported live IPC into a running PoB2 window (no API exposes
 * "the build currently open in the UI"), so this is deliberately limited to
 * process presence and on-disk saved builds -- same reasoning as this
 * project's stance on PoE2's own process memory (see adapters/memory-adapter.ts).
 */

/**
 * Candidate process names for a running PoB2 instance. NOT verified against
 * a real install (only installer/portable download asset names were found,
 * not the running executable's name) -- if this misses your install, check
 * Task Manager for the real process name and add it here.
 */
const CANDIDATE_PROCESS_NAMES = [
  "PathOfBuildingCommunity-PoE2",
  "PathOfBuilding-PoE2",
  "PathOfBuildingCommunity",
  "PathOfBuilding",
];

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(`${cmd} exited ${code}`))));
  });
}

export interface PobRunningStatus {
  running: boolean;
  checkedNames: string[];
}

export async function isPobRunning(): Promise<PobRunningStatus> {
  const platform = os.platform();
  let output: string;
  try {
    output = platform === "win32" ? await runCommand("tasklist", []) : await runCommand("ps", ["-A"]);
  } catch {
    return { running: false, checkedNames: CANDIDATE_PROCESS_NAMES };
  }
  const lower = output.toLowerCase();
  const running = CANDIDATE_PROCESS_NAMES.some((name) => lower.includes(name.toLowerCase()));
  return { running, checkedNames: CANDIDATE_PROCESS_NAMES };
}

export interface PobBuildFileInfo {
  path: string;
  name: string;
  modifiedAt: string;
}

export const MAX_POB_FILE_BYTES = 5 * 1024 * 1024;

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Resolve a build path without allowing the MCP caller to escape the
 * configured PoB Builds directory through `..` segments or symlinks.
 */
export function validatePobBuildFile(filePath: string, buildsDir: string): string {
  const root = fs.realpathSync(buildsDir);
  const candidate = fs.realpathSync(filePath);
  if (!isWithinRoot(candidate, root)) {
    throw new Error("PoB build files must be inside the configured Path of Building Builds directory.");
  }
  if (path.extname(candidate).toLowerCase() !== ".xml") {
    throw new Error("PoB build files must use the .xml extension.");
  }
  const stat = fs.statSync(candidate);
  if (!stat.isFile()) throw new Error("PoB build path must refer to a regular file.");
  if (stat.size > MAX_POB_FILE_BYTES) {
    throw new Error(`PoB build file exceeds the ${MAX_POB_FILE_BYTES} byte safety limit.`);
  }
  return candidate;
}

/** Lists .xml files in a PoB Builds directory, most-recently-modified first. Metadata only, no parsing. */
export function listRecentPobBuilds(dir: string): PobBuildFileInfo[] {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".xml"));

  return entries
    .map((entry) => {
      const fullPath = path.join(dir, entry.name);
      const stat = fs.statSync(fullPath);
      return { path: fullPath, name: entry.name, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function readPobBuildFile(filePath: string, buildsDir: string): string {
  const root = fs.realpathSync(buildsDir);
  const candidate = path.resolve(filePath);
  if (!isWithinRoot(candidate, root)) {
    throw new Error("PoB build files must be inside the configured Path of Building Builds directory.");
  }
  if (path.extname(candidate).toLowerCase() !== ".xml") {
    throw new Error("PoB build files must use the .xml extension.");
  }

  // Open the file itself before validating its identity. Reading from this
  // descriptor prevents a path replacement after validation from changing
  // which file is read. O_NOFOLLOW rejects a symlink at the final path.
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number | null = null;
  try {
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error("PoB build path must refer to a regular file.");
    if (opened.size > MAX_POB_FILE_BYTES) {
      throw new Error(`PoB build file exceeds the ${MAX_POB_FILE_BYTES} byte safety limit.`);
    }

    const resolved = fs.realpathSync(candidate);
    if (!isWithinRoot(resolved, root)) {
      throw new Error("PoB build files must be inside the configured Path of Building Builds directory.");
    }
    const current = fs.statSync(candidate);
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error("PoB build file changed while it was being opened; retry the import.");
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
