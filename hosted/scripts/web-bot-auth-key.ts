/**
 * Makes an Ed25519 key for Web Bot Auth (issue #41) and prints it as the value of the Worker
 * secret WEB_BOT_AUTH_KEYS: a JSON list of one private JWK. It writes nothing to disk. Keep the
 * output where you keep secrets, since Cloudflare never shows a secret again, then set it:
 *   pnpm run --silent hosted:key
 *   pnpm run hosted:secret WEB_BOT_AUTH_KEYS
 */
import { webcrypto } from "node:crypto";

const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
]);

if (!("privateKey" in pair)) {
  throw new Error("Ed25519 gave no key pair.");
}

const { kty, crv, x, d } = await webcrypto.subtle.exportKey(
  "jwk",
  pair.privateKey
);

process.stdout.write(`${JSON.stringify([{ kty, crv, x, d }])}\n`);
