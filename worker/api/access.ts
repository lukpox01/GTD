/**
 * Cloudflare Access JWT verification. Access already blocks unauthenticated requests at the edge;
 * checking its signed assertion in the Worker as well means a misconfigured Access application
 * (wrong path, policy removed) fails closed instead of exposing the API.
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */

export interface AccessJwk extends JsonWebKey {
  kid: string;
}

/** Fetches the team's signing keys (`/cdn-cgi/access/certs`). Injected so tests can use their own keys. */
export type AccessKeyFetcher = (certsUrl: string) => Promise<AccessJwk[]>;

export const fetchAccessKeys: AccessKeyFetcher = async (certsUrl) => {
  const res = await fetch(certsUrl);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const body = await res.json<{ keys?: AccessJwk[] }>();
  return body.keys ?? [];
};

export interface AccessIdentity {
  email: string | null;
  sub: string;
}

export class AccessError extends Error {
  override name = "AccessError";
}

/** "myteam", "myteam.cloudflareaccess.com" or "https://myteam.cloudflareaccess.com/" → issuer URL. */
export function accessIssuer(teamDomain: string): string {
  const host = teamDomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return `https://${host.includes(".") ? host : `${host}.cloudflareaccess.com`}`;
}

interface CachedKeys {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}
const keyCache = new Map<string, CachedKeys>();
const REFRESH_MS = 60 * 60 * 1000; // Access rotates keys every 6 weeks and publishes the next one early
const MIN_REFETCH_MS = 60 * 1000; // an unknown kid triggers a refetch at most this often

/** For tests. */
export function clearAccessKeyCache(): void {
  keyCache.clear();
}

async function signingKey(issuer: string, kid: string, fetchKeys: AccessKeyFetcher): Promise<CryptoKey | undefined> {
  const now = Date.now();
  let cached = keyCache.get(issuer);
  const stale = !cached || now - cached.fetchedAt > REFRESH_MS;
  const unknownKid = cached && !cached.keys.has(kid) && now - cached.fetchedAt > MIN_REFETCH_MS;
  if (stale || unknownKid) {
    const jwks = await fetchKeys(`${issuer}/cdn-cgi/access/certs`);
    const keys = new Map<string, CryptoKey>();
    for (const jwk of jwks) {
      if (jwk.kty !== "RSA" || !jwk.kid) continue;
      keys.set(
        jwk.kid,
        await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
      );
    }
    cached = { keys, fetchedAt: now };
    keyCache.set(issuer, cached);
  }
  return cached?.keys.get(kid);
}

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function b64urlJson(s: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
  if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
  return parsed as Record<string, unknown>;
}

/** Verifies an Access JWT (signature, issuer, audience, expiry). Throws AccessError when invalid. */
export async function verifyAccessJwt(
  token: string,
  opts: { teamDomain: string; audience: string; fetchKeys: AccessKeyFetcher; now?: number },
): Promise<AccessIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError("malformed token");
  const [h, p, sig] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = b64urlJson(h);
    payload = b64urlJson(p);
  } catch {
    throw new AccessError("malformed token");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AccessError("unsupported token");

  const issuer = accessIssuer(opts.teamDomain);
  const key = await signingKey(issuer, header.kid, opts.fetchKeys);
  if (!key) throw new AccessError("unknown signing key");
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlBytes(sig),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) throw new AccessError("bad signature");

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const leeway = 60;
  if (payload.iss !== issuer) throw new AccessError("wrong issuer");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(opts.audience)) throw new AccessError("wrong audience");
  if (typeof payload.exp !== "number" || payload.exp + leeway < now) throw new AccessError("expired");
  if (typeof payload.nbf === "number" && payload.nbf - leeway > now) throw new AccessError("not yet valid");

  return {
    email: typeof payload.email === "string" ? payload.email : null,
    sub: typeof payload.sub === "string" ? payload.sub : "",
  };
}

/** The assertion Access adds to every proxied request; the cookie is the fallback for direct browser calls. */
export function accessToken(header: string | undefined, cookie: string | undefined): string | null {
  if (header) return header;
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie ?? "");
  return m?.[1] ?? null;
}
