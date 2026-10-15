/**
 * Google service-account auth for Vertex AI using only WebCrypto + fetch:
 * sign an RS256 JWT, exchange it for an OAuth access token, cache until expiry.
 */

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
/** Refresh this long before the token actually expires. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function parseServiceAccount(json: string): ServiceAccount {
  let sa: unknown;
  try {
    sa = JSON.parse(json);
  } catch {
    throw new Error("GCP_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  const { client_email, private_key, token_uri } = (sa ?? {}) as Record<string, unknown>;
  if (typeof client_email !== "string" || typeof private_key !== "string") {
    throw new Error("GCP_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  }
  return { client_email, private_key, token_uri: typeof token_uri === "string" ? token_uri : undefined };
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Module-level: survives across requests within one isolate.
const tokenCache = new Map<string, CachedToken>();
const inFlight = new Map<string, Promise<CachedToken>>();

/** For tests. */
export function clearTokenCache(): void {
  tokenCache.clear();
  inFlight.clear();
}

export interface TokenSourceOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

export async function getAccessToken(sa: ServiceAccount, opts: TokenSourceOptions = {}): Promise<string> {
  const now = opts.now ?? Date.now;
  const key = sa.client_email;

  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached.token;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = fetchToken(sa, opts.fetch ?? fetch, now).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  const fresh = await pending;
  tokenCache.set(key, fresh);
  return fresh.token;
}

async function fetchToken(sa: ServiceAccount, fetchFn: typeof fetch, now: () => number): Promise<CachedToken> {
  const tokenUri = sa.token_uri ?? DEFAULT_TOKEN_URI;
  const issuedAtMs = now();
  const assertion = await signJwt(sa, tokenUri, Math.floor(issuedAtMs / 1000));

  const res = await fetchFn(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${body.slice(0, 300)}`);

  const parsed = JSON.parse(body) as { access_token?: unknown; expires_in?: unknown };
  if (typeof parsed.access_token !== "string") throw new Error("token exchange: no access_token in response");
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  return { token: parsed.access_token, expiresAt: issuedAtMs + expiresIn * 1000 };
}

export async function signJwt(sa: ServiceAccount, audience: string, iat: number): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: sa.client_email, scope: SCOPE, aud: audience, iat, exp: iat + 3600 };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;

  const key = await importPrivateKey(sa.private_key);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/\\n/g, "\n") // tolerate a key whose newlines were double-escaped when pasted
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  try {
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "sign",
    ]);
  } catch (e) {
    throw new Error(`service account private_key is not a valid PKCS#8 PEM key (${(e as Error).message})`);
  }
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
