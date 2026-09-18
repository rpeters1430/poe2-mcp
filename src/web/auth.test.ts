import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { checkWebToken, isWebTokenValid } from "./auth.js";

function fakeReq(opts: { headers?: Record<string, string>; url?: string }): IncomingMessage {
  return {
    headers: opts.headers ?? {},
    url: opts.url ?? "/",
  } as unknown as IncomingMessage;
}

function fakeRes() {
  const calls: { status?: number; body?: string } = {};
  return {
    writeHead(status: number) {
      calls.status = status;
      return this;
    },
    end(body?: string) {
      calls.body = body;
    },
    calls,
  } as any;
}

function withToken<T>(token: string | undefined, fn: () => T): T {
  const previous = process.env.POE2_WEB_TOKEN;
  if (token === undefined) delete process.env.POE2_WEB_TOKEN;
  else process.env.POE2_WEB_TOKEN = token;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.POE2_WEB_TOKEN;
    else process.env.POE2_WEB_TOKEN = previous;
  }
}

test("checkWebToken allows every request when POE2_WEB_TOKEN is unset", () => {
  withToken(undefined, () => {
    const res = fakeRes();
    assert.equal(checkWebToken(fakeReq({}), res), true);
    assert.equal(res.calls.status, undefined);
  });
});

test("checkWebToken accepts a matching X-POE2-Token header and rejects a wrong one", () => {
  withToken("secret-token", () => {
    const okRes = fakeRes();
    assert.equal(checkWebToken(fakeReq({ headers: { "x-poe2-token": "secret-token" } }), okRes), true);

    const badRes = fakeRes();
    assert.equal(checkWebToken(fakeReq({ headers: { "x-poe2-token": "wrong" } }), badRes), false);
    assert.equal(badRes.calls.status, 401);
  });
});

test("checkWebToken accepts a matching ?token= query param", () => {
  withToken("secret-token", () => {
    const res = fakeRes();
    assert.equal(checkWebToken(fakeReq({ url: "/api/status?token=secret-token" }), res), true);
  });
});

test("checkWebToken rejects a missing token and a different-length token", () => {
  withToken("secret-token", () => {
    const missing = fakeRes();
    assert.equal(checkWebToken(fakeReq({}), missing), false);
    assert.equal(missing.calls.status, 401);

    const shortRes = fakeRes();
    assert.equal(checkWebToken(fakeReq({ headers: { "x-poe2-token": "short" } }), shortRes), false);
  });
});

test("isWebTokenValid mirrors checkWebToken's accept/reject decisions for the websocket handshake", () => {
  withToken("secret-token", () => {
    assert.equal(isWebTokenValid(fakeReq({ url: "/ws?token=secret-token" })), true);
    assert.equal(isWebTokenValid(fakeReq({ url: "/ws?token=wrong" })), false);
    assert.equal(isWebTokenValid(fakeReq({ url: "/ws" })), false);
  });
  withToken(undefined, () => {
    assert.equal(isWebTokenValid(fakeReq({ url: "/ws" })), true);
  });
});
