import { beforeEach, describe, expect, it } from "vitest";
import { GeminiVertexProvider } from "../worker/llm/gemini-vertex";
import { ClassificationError } from "../worker/llm/types";
import {
  bytesToBase64,
  clearTokenCache,
  getAccessToken,
  parseServiceAccount,
  signJwt,
  type ServiceAccount,
} from "../worker/llm/vertex-auth";

const keyPair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer);
const pem = `-----BEGIN PRIVATE KEY-----\n${bytesToBase64(pkcs8).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
const sa: ServiceAccount = { client_email: "bot@proj.iam.gserviceaccount.com", private_key: pem };

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** fetch fake: token endpoint + a queue of Vertex responses. */
function fakeFetch(vertexResponses: Array<{ status?: number; body: unknown }> = []) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: `tok-${calls.length}`, expires_in: 3600, token_type: "Bearer" });
    }
    const next = vertexResponses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
    });
  }) as typeof fetch;
  return { fn, calls };
}

beforeEach(clearTokenCache);

describe("vertex auth", () => {
  it("signs a verifiable RS256 JWT with the right claims", async () => {
    const jwt = await signJwt(sa, "https://oauth2.googleapis.com/token", 1_700_000_000);
    const [h, c, s] = jwt.split(".") as [string, string, string];

    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h)))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(c)))).toEqual({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keyPair.publicKey,
      b64urlDecode(s),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });

  it("accepts a key whose newlines are escaped", async () => {
    const escaped = { ...sa, private_key: pem.replace(/\n/g, "\\n") };
    await expect(signJwt(escaped, "aud", 1)).resolves.toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("explains an invalid private key", async () => {
    await expect(signJwt({ ...sa, private_key: "-----BEGIN PRIVATE KEY-----\n...\n" }, "aud", 1)).rejects.toThrow(
      /not a valid PKCS#8 PEM/,
    );
  });

  it("exchanges the JWT and caches the token until close to expiry", async () => {
    const { fn, calls } = fakeFetch();
    let now = 1_700_000_000_000;
    const opts = { fetch: fn, now: () => now };

    const t1 = await getAccessToken(sa, opts);
    const t2 = await getAccessToken(sa, opts);
    expect(t1).toBe(t2);
    expect(calls).toHaveLength(1);
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(body.get("assertion")?.split(".")).toHaveLength(3);

    now += 56 * 60 * 1000; // inside the 5-minute refresh margin
    const t3 = await getAccessToken(sa, opts);
    expect(t3).not.toBe(t1);
    expect(calls).toHaveLength(2);
  });

  it("shares one in-flight token request between concurrent callers", async () => {
    const { fn, calls } = fakeFetch();
    const [a, b] = await Promise.all([getAccessToken(sa, { fetch: fn }), getAccessToken(sa, { fetch: fn })]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it("validates the service-account JSON", () => {
    expect(() => parseServiceAccount("nope")).toThrow(/not valid JSON/);
    expect(() => parseServiceAccount("{}")).toThrow(/client_email/);
    expect(parseServiceAccount(JSON.stringify(sa)).client_email).toBe(sa.client_email);
  });
});

const goodItem = {
  language: "en",
  transcript: null,
  title: "Email the professor",
  next_action: "Email the professor about the deadline",
  type: "task",
  status: "next",
  context: "@pc",
  time_estimate_min: 10,
  confidence: 0.9,
};

function vertexOk(text: string, extra: Record<string, unknown> = {}) {
  return {
    body: {
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
      modelVersion: "gemini-3.8-flash",
      ...extra,
    },
  };
}

function provider(fetchFn: typeof fetch, location = "global") {
  return new GeminiVertexProvider({
    serviceAccount: sa,
    projectId: "my-proj",
    location,
    model: "gemini-3.8-flash",
    timezone: "Europe/Bratislava",
    fetch: fetchFn,
    now: () => new Date("2026-10-15T10:00:00Z"),
  });
}

describe("GeminiVertexProvider", () => {
  it("builds global and regional endpoints", () => {
    const { fn } = fakeFetch();
    expect(provider(fn).endpoint()).toBe(
      "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/google/models/gemini-3.8-flash:generateContent",
    );
    expect(provider(fn, "europe-west1").endpoint()).toBe(
      "https://europe-west1-aiplatform.googleapis.com/v1/projects/my-proj/locations/europe-west1/publishers/google/models/gemini-3.8-flash:generateContent",
    );
  });

  it("classifies text with structured output and a bearer token", async () => {
    const { fn, calls } = fakeFetch([vertexOk(JSON.stringify(goodItem))]);
    const result = await provider(fn).classify({ text: "email the prof" });

    expect(result.item.title).toBe("Email the professor");
    expect(result.model).toBe("gemini-3.8-flash");
    const call = calls[1]!;
    expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer tok-1");
    const req = JSON.parse(String(call.init?.body));
    expect(req.generationConfig.responseMimeType).toBe("application/json");
    expect(req.generationConfig.responseSchema.properties.title).toBeDefined();
    expect(req.contents[0].parts[0].text).toContain("Thursday 2026-10-15");
    expect(req.contents[0].parts[0].text).toContain("email the prof");
  });

  it("sends audio as inline data", async () => {
    const { fn, calls } = fakeFetch([vertexOk(JSON.stringify({ ...goodItem, transcript: "hello" }))]);
    const bytes = new Uint8Array([79, 103, 103, 83, 0, 1, 2]);
    const result = await provider(fn).classify({ audio: { bytes, mimeType: "audio/ogg" } });

    expect(result.item.transcript).toBe("hello");
    const parts = JSON.parse(String(calls[1]?.init?.body)).contents[0].parts;
    expect(parts[1]).toEqual({ inlineData: { mimeType: "audio/ogg", data: bytesToBase64(bytes) } });
  });

  it("ignores thought parts", async () => {
    const { fn } = fakeFetch([
      {
        body: {
          candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: JSON.stringify(goodItem) }] } }],
        },
      },
    ]);
    await expect(provider(fn).classify({ text: "x" })).resolves.toMatchObject({ item: { type: "task" } });
  });

  it("throws ClassificationError with raw output on invalid JSON", async () => {
    const { fn } = fakeFetch([vertexOk("not json at all")]);
    const err = await provider(fn).classify({ text: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClassificationError);
    expect((err as ClassificationError).details.rawOutput).toBe("not json at all");
  });

  it("throws ClassificationError on HTTP errors and empty candidates", async () => {
    const { fn } = fakeFetch([
      { status: 429, body: { error: { message: "quota" } } },
      { body: { candidates: [{ finishReason: "SAFETY" }] } },
    ]);
    await expect(provider(fn).classify({ text: "x" })).rejects.toThrow(/HTTP 429/);
    await expect(provider(fn).classify({ text: "x" })).rejects.toThrow(/SAFETY/);
  });
});
