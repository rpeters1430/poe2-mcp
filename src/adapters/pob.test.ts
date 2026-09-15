import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPobBuildFile, validatePobBuildFile } from "./pob.js";

function fixtureDirs(): { root: string; outside: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "poe2-mcp-pob-test-"));
  const root = path.join(parent, "Builds");
  const outside = path.join(parent, "Outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  return { root, outside };
}

test("reads XML files inside the configured PoB Builds directory", () => {
  const { root } = fixtureDirs();
  const file = path.join(root, "safe.xml");
  fs.writeFileSync(file, "<PathOfBuilding2 />");
  assert.equal(readPobBuildFile(file, root), "<PathOfBuilding2 />");
});

test("rejects files outside the configured PoB Builds directory", () => {
  const { root, outside } = fixtureDirs();
  const file = path.join(outside, "secret.xml");
  fs.writeFileSync(file, "secret");
  assert.throws(() => validatePobBuildFile(file, root), /must be inside/);
});

test("rejects symlink escapes and non-XML files", () => {
  const { root, outside } = fixtureDirs();
  const target = path.join(outside, "secret.xml");
  const link = path.join(root, "linked.xml");
  fs.writeFileSync(target, "secret");
  fs.symlinkSync(target, link);
  assert.throws(() => validatePobBuildFile(link, root), /must be inside/);

  const textFile = path.join(root, "notes.txt");
  fs.writeFileSync(textFile, "not a build");
  assert.throws(() => validatePobBuildFile(textFile, root), /\.xml extension/);
});
