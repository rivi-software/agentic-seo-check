/**
 * The session cookie of the account pages (issue #229): `__Host-account`, whose value is
 * `<accountId>.<expiresMs>.<hmac>`, signed with the secret ACCOUNT_SESSION_KEY. WebCrypto only,
 * since it runs in a Worker.
 */

export const SESSION_DAYS = 30;

const COOKIE = "__Host-account";
const DAY_MS = 86_400_000;
const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");
};

const sign = async (payload: string, key: string): Promise<string> => {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );

  const mac = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    encoder.encode(payload)
  );

  return toBase64Url(new Uint8Array(mac));
};

/** Compares without stopping at the first difference, so timing says nothing about the signature. */
const sameText = (a: string, b: string): boolean => {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let differences = left.length === right.length ? 0 : 1;

  for (const [index, byte] of left.entries()) {
    if (byte !== right[index]) {
      differences += 1;
    }
  }

  return differences === 0;
};

const ATTRIBUTES = "Secure; HttpOnly; SameSite=Lax; Path=/";

/** The whole `Set-Cookie` value for a session that lasts SESSION_DAYS from `now`. */
export const sessionCookie = async (
  accountId: string,
  key: string,
  now: number
): Promise<string> => {
  const payload = `${accountId}.${now + SESSION_DAYS * DAY_MS}`;
  const value = `${payload}.${await sign(payload, key)}`;

  return `${COOKIE}=${value}; ${ATTRIBUTES}; Max-Age=${SESSION_DAYS * 86_400}`;
};

/** The `Set-Cookie` value that ends the session. */
export const clearSessionCookie = (): string =>
  `${COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;

/** The account id of a valid, unexpired session cookie on the request, else null. */
export const readSession = async (
  request: Request,
  key: string,
  now: number
): Promise<string | null> => {
  const header = request.headers.get("Cookie");

  if (!header) {
    return null;
  }

  let value: string | undefined;

  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");

    if (name === COOKIE) {
      value = rest.join("=");
      break;
    }
  }

  if (!value) {
    return null;
  }

  const parts = value.split(".");

  if (parts.length !== 3) {
    return null;
  }

  const [accountId, expires, signature] = parts;

  if (!accountId || !signature || !/^\d+$/u.test(expires ?? "")) {
    return null;
  }

  const expected = await sign(`${accountId}.${expires}`, key);

  if (!sameText(signature, expected)) {
    return null;
  }

  return Number(expires) > now ? accountId : null;
};
