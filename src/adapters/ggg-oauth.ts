import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { GGG_OAUTH_BASE, tokenStorePath, userAgent } from "../config.js";

/**
 * PKCE (public client) OAuth flow against GGG's developer API.
 *
 * GGG does not allow "localhost" or bare IP redirect URIs for confidential
 * clients, but DOES allow a local loopback redirect for public clients using
 * PKCE (no client secret). That's what this implements: a one-time,
 * interactive `npm run auth` that opens the consent URL, catches the
 * redirect on a local HTTP server, and exchanges the code for tokens.
 *
 * You must first register a public client at
 * https://www.pathofexile.com/developer -- see README.md "GGG API setup".
 */

interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  scope: string;
}

function base64url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function loadTokens(): TokenSet | null {
  try {
    const raw = fs.readFileSync(tokenStorePath(), "utf8");
    return JSON.parse(raw) as TokenSet;
  } catch {
    return null;
  }
}

function saveTokens(tokens: TokenSet): void {
  fs.writeFileSync(tokenStorePath(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export async function runInteractiveAuth(opts: {
  clientId: string;
  scopes: string[];
  redirectPort?: number;
}): Promise<void> {
  const port = opts.redirectPort ?? 8730;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  const authorizeUrl = new URL(`${GGG_OAUTH_BASE}/authorize`);
  authorizeUrl.searchParams.set("client_id", opts.clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", opts.scopes.join(" "));
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end(`Authorization failed: ${error}`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (returnedState !== state || !returnedCode) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("State mismatch or missing code.");
        server.close();
        reject(new Error("OAuth state mismatch"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" }).end(
        "Authorized. You can close this tab and return to the terminal."
      );
      server.close();
      resolve(returnedCode);
    });
    server.listen(port, "127.0.0.1", () => {
      console.log("Open this URL in a browser to authorize the app:\n");
      console.log(authorizeUrl.toString());
      console.log(`\nWaiting for redirect on ${redirectUri} ...`);
    });
  });

  const tokenRes = await fetch(`${GGG_OAUTH_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent(),
    },
    body: new URLSearchParams({
      client_id: opts.clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }

  const body = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };

  saveTokens({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + body.expires_in * 1000,
    scope: body.scope,
  });

  console.log("\nSaved tokens to", tokenStorePath());
  console.log("You can now run the MCP server normally.");
}

/**
 * Returns a valid access token, refreshing it first if it's expired or
 * close to expiring. Throws if no tokens are stored yet (run `npm run auth`
 * first).
 */
export async function getAccessToken(clientId: string): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error(
      "No stored GGG credentials found. Run `npm run auth` once to authorize this app against your PoE account."
    );
  }

  const oneMinute = 60_000;
  if (Date.now() < tokens.expires_at - oneMinute) {
    return tokens.access_token;
  }

  const res = await fetch(`${GGG_OAUTH_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent(),
    },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Refresh failed (${res.status}). Your refresh token may have expired after 90 days -- run \`npm run auth\` again.`
    );
  }

  const body = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };

  const updated: TokenSet = {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? tokens.refresh_token,
    expires_at: Date.now() + body.expires_in * 1000,
    scope: body.scope,
  };
  saveTokens(updated);
  return updated.access_token;
}
