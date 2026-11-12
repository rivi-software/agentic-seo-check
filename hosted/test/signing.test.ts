import { assert, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";

import {
  directoryResponse,
  parseKeys,
  requestSignature,
  requestSigner,
  SigningKeysError,
  signatureBase,
  signingKeys,
  thumbprint,
} from "../src/signing.ts";

/** The Ed25519 test key of RFC 9421, Appendix B.1.4, as .dev.vars has it. */
const TEST_KEY = {
  kty: "OKP",
  crv: "Ed25519",
  x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
  d: "n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU",
} as const;

/** Its thumbprint, the keyid of Cloudflare's own examples. */
const TEST_KEYID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";

const AGENT = "https://mcp.agentic-seo.rivi.software";

const encoder = new TextEncoder();

/** Whether `signature` (base64) is the test key's over `base`. */
const verifies = async (base: string, signature: string) => {
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: TEST_KEY.kty, crv: TEST_KEY.crv, x: TEST_KEY.x },
    { name: "Ed25519" },
    false,
    ["verify"]
  );

  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    Buffer.from(signature, "base64"),
    encoder.encode(base)
  );
};

/** The base64 signature of a `sig1=:…:` header. */
const signatureOf = (header: string | null, label = "sig1") =>
  new RegExp(`${label}=:(?<value>[^:]+):`, "u").exec(header ?? "")?.groups
    ?.value ?? "";

describe("Web Bot Auth", () => {
  it("names a key by its JWK thumbprint", async () => {
    await expect(thumbprint(TEST_KEY)).resolves.toBe(TEST_KEYID);
  });

  it("writes the signature base as RFC 9421 does", async () => {
    // RFC 9421, Appendix B.2.6: signing a request with ed25519.
    const base = signatureBase(
      [
        ['"date"', "Tue, 20 Apr 2021 02:07:55 GMT"],
        ['"@method"', "POST"],
        ['"@path"', "/foo"],
        ['"@authority"', "example.com"],
        ['"content-type"', "application/json"],
        ['"content-length"', "18"],
      ],
      '("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"'
    );

    await expect(
      verifies(
        base,
        "wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw=="
      )
    ).resolves.toBeTruthy();
  });

  it("signs a request's authority and Signature-Agent, for a minute", async () => {
    const [key] = await parseKeys(JSON.stringify([TEST_KEY]));
    assert(key);

    const headers = await requestSignature(
      key,
      AGENT,
      new URL("https://Shop.Example.com:8443/a?b=1"),
      { now: 1_762_785_600_000, nonce: "bm9uY2U=" }
    );

    const params = `("@authority" "signature-agent");created=1762785600;expires=1762785660;keyid="${TEST_KEYID}";alg="ed25519";nonce="bm9uY2U=";tag="web-bot-auth"`;

    expect(headers).toStrictEqual({
      "signature-agent": `"${AGENT}"`,
      "signature-input": `sig1=${params}`,
      signature: expect.stringMatching(/^sig1=:[\w+/]+={0,2}:$/u),
    });

    await expect(
      verifies(
        `"@authority": shop.example.com:8443\n"signature-agent": "${AGENT}"\n"@signature-params": ${params}`,
        signatureOf(headers.signature ?? null)
      )
    ).resolves.toBeTruthy();
  });

  it("serves the public keys only, signed over the authority asked for", async () => {
    const keys = await parseKeys(JSON.stringify(TEST_KEY));

    const response = await directoryResponse(
      keys,
      new Request(`${AGENT}/.well-known/http-message-signatures-directory`),
      { now: 1_762_785_600_000, nonce: "bm9uY2U=" }
    );

    const params = `("@authority";req);alg="ed25519";keyid="${TEST_KEYID}";nonce="bm9uY2U=";tag="http-message-signatures-directory";created=1762785600;expires=1762785900`;
    const body = await response.text();

    expect(response.headers.get("content-type")).toBe(
      "application/http-message-signatures-directory+json"
    );
    expect(JSON.parse(body)).toStrictEqual({
      keys: [{ kty: "OKP", crv: "Ed25519", x: TEST_KEY.x }],
    });
    expect(body).not.toContain(TEST_KEY.d);
    expect(response.headers.get("signature-input")).toBe(`sig1=${params}`);

    await expect(
      verifies(
        `"@authority";req: mcp.agentic-seo.rivi.software\n"@signature-params": ${params}`,
        signatureOf(response.headers.get("signature"))
      )
    ).resolves.toBeTruthy();
  });

  it("signs the directory with every key it lists", async () => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]);

    assert("privateKey" in pair, "an Ed25519 key is a pair");

    const second = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const keys = await parseKeys(JSON.stringify([TEST_KEY, second]));

    const response = await directoryResponse(
      keys,
      new Request(`${AGENT}/.well-known/http-message-signatures-directory`)
    );

    const { keys: listed } = z
      .object({ keys: z.array(z.unknown()) })
      .parse(await response.json());

    expect(listed).toHaveLength(2);
    expect(response.headers.get("signature-input")).toMatch(
      /^sig1=\("@authority";req\);.+, sig2=\("@authority";req\);.+$/u
    );
    expect(response.headers.get("signature")).toMatch(
      /^sig1=:[^:]+:, sig2=:[^:]+:$/u
    );
  });

  it("signs https requests only, which nobody on the path can read", async () => {
    const sign = requestSigner(JSON.stringify([TEST_KEY]), AGENT);

    await expect(
      sign(new URL("https://shop.example.com/"))
    ).resolves.toMatchObject({ "signature-agent": `"${AGENT}"` });
    await expect(
      sign(new URL("http://shop.example.com/"))
    ).resolves.toStrictEqual({});
  });

  it("sends requests unsigned without keys, or with a secret that holds none", async () => {
    const logged = vi.spyOn(console, "error").mockReturnValue(undefined);
    onTestFinished(() => logged.mockRestore());
    const url = new URL("https://shop.example.com/");
    const secret = '[{"kty":"OKP","crv":"Ed25519","x":"only-public"}]';

    await expect(requestSigner(undefined, AGENT)(url)).resolves.toStrictEqual(
      {}
    );
    await expect(requestSigner(secret, AGENT)(url)).resolves.toStrictEqual({});
    await expect(signingKeys("not json")).resolves.toStrictEqual([]);
    expect(logged).toHaveBeenCalledWith(
      "WEB_BOT_AUTH_KEYS is not a list of Ed25519 private keys as JWKs: requests go out unsigned."
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain("only-public");
  });

  it("tells error tracking of a secret that holds no key, once, and nothing of the secret (issue #93)", async () => {
    const logged = vi.spyOn(console, "error").mockReturnValue(undefined);
    onTestFinished(() => logged.mockRestore());
    const heard: Error[] = [];
    const secret = '[{"kty":"OKP","crv":"Ed25519","x":"public-only-93"}]';
    const sign = requestSigner(secret, AGENT, (problem) => heard.push(problem));
    const url = new URL("https://shop.example.com/");

    await sign(url);
    await expect(sign(url)).resolves.toStrictEqual({});

    expect(heard).toStrictEqual([expect.any(SigningKeysError)]);
    expect(heard[0]?.cause).toBeUndefined();
    expect(`${heard[0]?.message} ${heard[0]?.stack ?? ""}`).not.toContain(
      "public-only-93"
    );
  });
});
