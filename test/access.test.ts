import { beforeEach, describe, expect, it } from "vitest";
import { accessIssuer, accessToken, clearAccessKeyCache, verifyAccessJwt, type AccessJwk } from "../worker/api/access";
import { makeAccessKey } from "./helpers";

const TEAM = "myteam";
const ISS = "https://myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";
const now = Math.floor(Date.now() / 1000);

beforeEach(clearAccessKeyCache);

async function setup() {
  const key = await makeAccessKey();
  const fetched: string[] = [];
  const fetchKeys = async (url: string) => {
    fetched.push(url);
    return [key.jwk as AccessJwk];
  };
  const verify = (token: string) => verifyAccessJwt(token, { teamDomain: TEAM, audience: AUD, fetchKeys });
  const valid = { iss: ISS, aud: [AUD], exp: now + 3600, iat: now, nbf: now, sub: "u1", email: "me@example.com" };
  return { key, fetched, verify, valid };
}

describe("verifyAccessJwt", () => {
  it("accepts a valid token and returns the identity", async () => {
    const { key, fetched, verify, valid } = await setup();
    expect(await verify(await key.sign(valid))).toEqual({ email: "me@example.com", sub: "u1" });
    expect(fetched).toEqual([`${ISS}/cdn-cgi/access/certs`]);
  });

  it("caches the signing keys", async () => {
    const { key, fetched, verify, valid } = await setup();
    await verify(await key.sign(valid));
    await verify(await key.sign(valid));
    expect(fetched).toHaveLength(1);
  });

  it.each([
    ["wrong audience", { aud: ["someone-else"] }, "wrong audience"],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }, "wrong issuer"],
    ["expired", { exp: now - 3600 }, "expired"],
    ["not yet valid", { nbf: now + 3600 }, "not yet valid"],
    ["missing exp", { exp: undefined }, "expired"],
  ])("rejects a token with %s", async (_, override, message) => {
    const { key, verify, valid } = await setup();
    await expect(verify(await key.sign({ ...valid, ...override }))).rejects.toThrow(message);
  });

  it("rejects a token signed by another key with the same kid", async () => {
    const { verify, valid } = await setup();
    const forger = await makeAccessKey();
    await expect(verify(await forger.sign(valid))).rejects.toThrow("bad signature");
  });

  it("rejects an unknown kid, alg=none and garbage", async () => {
    const { key, verify, valid } = await setup();
    await expect(verify(await key.sign(valid, { kid: "other" }))).rejects.toThrow("unknown signing key");
    await expect(verify(await key.sign(valid, { alg: "none" }))).rejects.toThrow("unsupported");
    await expect(verify("abc")).rejects.toThrow("malformed");
    await expect(verify("a.b.c")).rejects.toThrow("malformed");
  });

  it("accepts a string aud claim", async () => {
    const { key, verify, valid } = await setup();
    await expect(verify(await key.sign({ ...valid, aud: AUD }))).resolves.toMatchObject({ sub: "u1" });
  });
});

describe("helpers", () => {
  it("normalises the team domain", () => {
    expect(accessIssuer("myteam")).toBe(ISS);
    expect(accessIssuer("myteam.cloudflareaccess.com")).toBe(ISS);
    expect(accessIssuer(" https://myteam.cloudflareaccess.com/ ")).toBe(ISS);
  });

  it("reads the header first, then the CF_Authorization cookie", () => {
    expect(accessToken("h", "CF_Authorization=c")).toBe("h");
    expect(accessToken(undefined, "a=1; CF_Authorization=c; b=2")).toBe("c");
    expect(accessToken(undefined, "a=1")).toBeNull();
    expect(accessToken(undefined, undefined)).toBeNull();
  });
});
