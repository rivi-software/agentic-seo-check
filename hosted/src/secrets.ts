/**
 * The unguessable secrets the Workers make (a shared report's id, a waitlist link's secret) and the
 * SHA-256 they are kept or looked up by.
 */

/** `bytes` random bytes in base64url: 22 characters for 16 bytes, 43 for 32. */
export const randomSecret = (bytes: number): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "base64url"
  );

/** SHA-256 of `text` in UTF-8, as 64 hex digits. */
export const sha256Hex = async (text: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
