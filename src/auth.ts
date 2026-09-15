import { runInteractiveAuth } from "./adapters/ggg-oauth.js";

const clientId = process.env.POE2_GGG_CLIENT_ID;
if (!clientId) {
  console.error(
    "Set POE2_GGG_CLIENT_ID first. Register a public (PKCE) client at https://www.pathofexile.com/developer\n" +
      "and set its redirect URI to http://127.0.0.1:8730/callback (or pass a different port with POE2_REDIRECT_PORT)."
  );
  process.exit(1);
}

const scopes = ["account:profile", "account:characters"];
const port = process.env.POE2_REDIRECT_PORT ? Number(process.env.POE2_REDIRECT_PORT) : undefined;

runInteractiveAuth({ clientId, scopes, redirectPort: port }).catch((err) => {
  console.error("Auth failed:", err);
  process.exit(1);
});
