import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeAppleScriptString } from "./dispatch.js";

// Regression test for a real AppleScript-injection bug: escaping quotes
// without first escaping backslashes lets a raw backslash immediately
// before the (now-escaped) quote read as an escaped backslash followed by
// an unescaped quote, closing the string literal early. `message` in
// emit_advisory can carry untrusted third-party text (chat/trade whispers
// are explicitly labeled `untrusted` by client-log.ts), so this matters.

test("escapeAppleScriptString escapes backslashes before quotes", () => {
  // A naive `.replace(/"/g, '\\"')` on this input produces `a\\"` --
  // read by AppleScript as an escaped backslash followed by an unescaped
  // quote, closing the string literal early.
  const malicious = 'a\\" & do shell script "touch /tmp/pwned" & "';
  const escaped = escapeAppleScriptString(malicious);

  // Every backslash in the output must be doubled, and every quote must be
  // preceded by an odd number of backslashes (i.e. actually escaped).
  const quoteIndices = [...escaped.matchAll(/"/g)].map((m) => m.index!);
  for (const idx of quoteIndices) {
    let backslashes = 0;
    let i = idx - 1;
    while (i >= 0 && escaped[i] === "\\") {
      backslashes++;
      i--;
    }
    assert.equal(backslashes % 2, 1, `quote at index ${idx} in ${JSON.stringify(escaped)} is not escaped`);
  }
});

test("escapeAppleScriptString round-trips plain text unchanged apart from escaping", () => {
  assert.equal(escapeAppleScriptString("low flask charges"), "low flask charges");
});

test("escapeAppleScriptString collapses embedded newlines", () => {
  assert.equal(escapeAppleScriptString("line one\nline two\r\nline three"), "line one line two line three");
});

test("escapeAppleScriptString escapes a simple trailing quote correctly", () => {
  assert.equal(escapeAppleScriptString('say "hi"'), 'say \\"hi\\"');
});
