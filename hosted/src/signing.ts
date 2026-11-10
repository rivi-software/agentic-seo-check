/**
 * Web Bot Auth (issue #41): the hosted server signs every https request it sends to a site with
 * an Ed25519 key, as HTTP Message Signatures (RFC 9421) with the `web-bot-auth` tag, and publishes
 * the public keys at /.well-known/http-message-signatures-directory. A site, and Cloudflare's
 * verified bots, can then tell its requests from others that send its User-Agent, which no
 * address can do: every Cloudflare Worker sends from the same ones. The keys are the Worker secret
 * WEB_BOT_AUTH_KEYS, a JSON list of private JWKs; the first signs.
 * https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/
 */
import { z } from "zod";

export const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

const DIRECTORY_TYPE = "application/http-message-signatures-directory+json";

/** How long a request's signature holds: "A minute is often sufficient" (Cloudflare). */
const REQUEST_SECONDS = 60;

/** How long the directory's signature holds, and a cache keeps the directory. */
const DIRECTORY_SECONDS = 300;

const PrivateJwk = z.object({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string().min(1),
  d: z.string().min(1),
});

/** A public key as the directory lists it: never `d`. */
interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface SigningKey {
  /** The key's JWK thumbprint (RFC 7638), which a signature names as its `keyid`. */
  keyid: string;
  publicJwk: PublicJwk;
  privateKey: CryptoKey;
}

const encoder = new TextEncoder();

/** The key's id: SHA-256 over its required members in lexical order, base64url (RFC 7638). */
export const thumbprint = async (key: PublicJwk): Promise<string> => {
  const members = JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x });
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(members));

  return Buffer.from(digest).toString("base64url");
};

/** The keys of WEB_BOT_AUTH_KEYS: one private JWK, or a list of them. */
export const parseKeys = async (secret: string): Promise<SigningKey[]> => {
  const parsed: unknown = JSON.parse(secret);
  const keys = z.array(PrivateJwk).min(1).parse([parsed].flat());

  const signing = await Promise.all(
    keys.map(async ({ kty, crv, x, d }) => {
      const publicJwk: PublicJwk = { kty, crv, x };

      return {
        keyid: await thumbprint(publicJwk),
        publicJwk,
        privateKey: await crypto.subtle.importKey(
          "jwk",
          { kty, crv, x, d },
          { name: "Ed25519" },
          false,
          ["sign"]
        ),
      };
    })
  );

  return signing;
};

/** The keys as this isolate read them from the secret, which stays the same until a deploy. */
let loaded: { secret: string; keys: Promise<SigningKey[]> } | null = null;

/**
 * The keys of the secret, read once per isolate. A secret that holds no Ed25519 private key is a
 * deploy's mistake: the requests go out unsigned, as without the secret, and the log says why.
 */
export const signingKeys = (
  secret: string | undefined
): Promise<SigningKey[]> => {
  if (!secret) {
    return Promise.resolve([]);
  }

  if (loaded?.secret !== secret) {
    loaded = {
      secret,
      keys: parseKeys(secret).catch(() => {
        // Never the error itself, which may quote the secret.
        console.error(
          "WEB_BOT_AUTH_KEYS is not a list of Ed25519 private keys as JWKs: requests go out unsigned."
        );

        return [];
      }),
    };
  }

  return loaded.keys;
};

/** A signature's parameters as Signature-Input writes them (RFC 8941): integers and strings. */
const integer = (name: string, value: number): string => `;${name}=${value}`;
const text = (name: string, value: string): string => `;${name}="${value}"`;

const parameters = (covered: string[], params: string[]): string =>
  `(${covered.join(" ")})${params.join("")}`;

/**
 * The text a signature signs (RFC 9421, section 2.5): each covered component on a line, as
 * `"name": value`, then the signature's parameters.
 */
export const signatureBase = (
  components: [name: string, value: string][],
  signatureParams: string
): string =>
  [
    ...components.map(([name, value]) => `${name}: ${value}`),
    `"@signature-params": ${signatureParams}`,
  ].join("\n");

const signBase = async (key: SigningKey, base: string): Promise<string> =>
  Buffer.from(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      key.privateKey,
      encoder.encode(base)
    )
  ).toString("base64");

/** A nonce, which Cloudflare recommends and neither checks nor tracks. */
const nonce = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

/** When a signature is made, and what makes it differ each time; fixed in the tests. */
export interface SignatureMoment {
  now?: number;
  nonce?: string;
}

/**
 * The headers that sign one request to `url`: `@authority` (its host) and Signature-Agent, the
 * origin whose key directory holds the key, as a quoted string.
 */
export const requestSignature = async (
  key: SigningKey,
  agent: string,
  url: URL,
  moment: SignatureMoment = {}
): Promise<Record<string, string>> => {
  const created = Math.floor((moment.now ?? Date.now()) / 1000);
  const signatureAgent = `"${agent}"`;

  const params = parameters(
    ['"@authority"', '"signature-agent"'],
    [
      integer("created", created),
      integer("expires", created + REQUEST_SECONDS),
      text("keyid", key.keyid),
      text("alg", "ed25519"),
      text("nonce", moment.nonce ?? nonce()),
      text("tag", "web-bot-auth"),
    ]
  );

  const base = signatureBase(
    [
      ['"@authority"', url.host],
      ['"signature-agent"', signatureAgent],
    ],
    params
  );

  return {
    "signature-agent": signatureAgent,
    "signature-input": `sig1=${params}`,
    signature: `sig1=:${await signBase(key, base)}:`,
  };
};

/**
 * Signs each https request with the first key of the secret, or with nothing while it holds none.
 * `agent` is the origin that serves the key directory. A request over plain http goes unsigned:
 * anyone on its path could read the signature and send it again, as this server, for a minute.
 */
export const requestSigner =
  (secret: string | undefined, agent: string) =>
  async (url: URL): Promise<Record<string, string>> => {
    if (url.protocol !== "https:") {
      return {};
    }

    const [key] = await signingKeys(secret);

    return key ? requestSignature(key, agent, url) : {};
  };

/**
 * The key directory: every key's public half, signed by each key over the authority it was asked
 * for (`"@authority";req`), so that nobody can serve a copy of it to register our keys as theirs.
 */
export const directoryResponse = async (
  keys: SigningKey[],
  request: Request,
  moment: SignatureMoment = {}
): Promise<Response> => {
  const authority = new URL(request.url).host;
  const created = Math.floor((moment.now ?? Date.now()) / 1000);

  const signatures = await Promise.all(
    keys.map(async (key, index) => {
      const label = `sig${index + 1}`;

      const params = parameters(
        ['"@authority";req'],
        [
          text("alg", "ed25519"),
          text("keyid", key.keyid),
          text("nonce", moment.nonce ?? nonce()),
          text("tag", "http-message-signatures-directory"),
          integer("created", created),
          integer("expires", created + DIRECTORY_SECONDS),
        ]
      );

      const base = signatureBase([['"@authority";req', authority]], params);

      return {
        input: `${label}=${params}`,
        signature: `${label}=:${await signBase(key, base)}:`,
      };
    })
  );

  const body = JSON.stringify({ keys: keys.map((key) => key.publicJwk) });

  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "content-type": DIRECTORY_TYPE,
      "cache-control": `public, max-age=${DIRECTORY_SECONDS}`,
      "x-content-type-options": "nosniff",
      "signature-input": signatures.map((s) => s.input).join(", "),
      signature: signatures.map((s) => s.signature).join(", "),
    },
  });
};
