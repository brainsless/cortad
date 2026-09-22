import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, createDecipheriv, hkdfSync } from "node:crypto";
import { identityScript } from "./identities.mjs";

// Mint with the real program, then read the value back only from the header file the box writes.
function mint(recipe, envLines, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "secret-sessions-"));
  writeFileSync(join(dir, ".env"), envLines);
  if (extra.nextAuthVersion) {
    mkdirSync(join(dir, "node_modules", "next-auth"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "next-auth", "package.json"), JSON.stringify({ version: extra.nextAuthVersion }));
  }
  const script = identityScript([{ header: "authorization", where: "src/auth.ts", ...recipe }], { envPath: join(dir, ".env"), base: "http://127.0.0.1:9" })
    .split("/tmp/bl-identit").join(join(dir, "bl-identit"));
  writeFileSync(join(dir, "mint.py"), script);
  const out = execFileSync("python3", [join(dir, "mint.py")], { cwd: dir, encoding: "utf8" });
  const report = JSON.parse(out.split("BL_IDENTITIES ")[1]);
  const status = report.identities[0]?.status;
  let line = null;
  try {
    line = readFileSync(join(dir, "bl-identity-user.header"), "utf8").trim();
  } catch {}
  return { status, line };
}

test("supabase mints an HS256 token that verifies against the JWT secret with GoTrue claims", () => {
  const secret = "s".repeat(40);
  const { status, line } = mint({ kind: "supabase", role: "user", env: ["SUPABASE_JWT_SECRET"] }, `SUPABASE_JWT_SECRET=${secret}\n`);
  assert.equal(status, "minted");
  const [header, token] = line.replace(/^authorization:\s*/, "").split(/\s+/);
  assert.equal(header.toLowerCase(), "bearer");
  const [h, b, sig] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "HS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(b, "base64url").toString());
  assert.equal(claims.role, "authenticated");
  assert.equal(claims.aud, "authenticated");
  assert.match(claims.sub, /^[0-9a-f-]{36}$/);
  assert.ok(claims.exp > claims.iat);
  const want = createHmac("sha256", secret).update(`${h}.${b}`).digest("base64url");
  assert.equal(sig, want, "signature must match HMAC-SHA256 over header.body");
});

test("authjs mints a v5 JWE that decrypts to the session claims with A256CBC-HS512", () => {
  const secret = "a-strong-nextauth-secret-value-000";
  const { status, line } = mint({ kind: "authjs", role: "user", header: "cookie", env: ["AUTH_SECRET", "NEXTAUTH_SECRET"] }, `AUTH_SECRET=${secret}\n`);
  assert.equal(status, "minted");
  const [name, jwe] = line.replace(/^cookie:\s*/, "").split("=");
  assert.equal(name, "authjs.session-token");
  const [protHdr, ek, ivB, ctB, tagB] = jwe.split(".");
  assert.equal(ek, "", "dir key management: empty encrypted key");
  assert.deepEqual(JSON.parse(Buffer.from(protHdr, "base64url").toString()), { alg: "dir", enc: "A256CBC-HS512" });

  const salt = "authjs.session-token";
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from(salt), Buffer.from(`Auth.js Generated Encryption Key (${salt})`), 64));
  const macKey = key.subarray(0, 32);
  const encKey = key.subarray(32);
  const iv = Buffer.from(ivB, "base64url");
  const ct = Buffer.from(ctB, "base64url");
  const aad = Buffer.from(protHdr, "ascii");
  const al = Buffer.alloc(8);
  al.writeBigUInt64BE(BigInt(aad.length * 8));
  const tag = createHmac("sha512", macKey).update(Buffer.concat([aad, iv, ct, al])).digest().subarray(0, 32);
  assert.equal(Buffer.from(tagB, "base64url").toString("hex"), tag.toString("hex"), "auth tag must match HMAC-SHA512");

  const dec = createDecipheriv("aes-256-cbc", encKey, iv);
  const plain = Buffer.concat([dec.update(ct), dec.final()]).toString();
  const claims = JSON.parse(plain);
  assert.ok(claims.sub, "carries a subject");
  assert.ok(claims.exp > claims.iat);
  assert.ok(claims.jti, "carries a jti like Auth.js");
});

test("authjs refuses to mint for next-auth v4 (A256GCM), which is not covered", () => {
  const { status, line } = mint({ kind: "authjs", role: "user", header: "cookie", env: ["NEXTAUTH_SECRET"] }, `NEXTAUTH_SECRET=${"x".repeat(32)}\n`, { nextAuthVersion: "4.24.7" });
  assert.equal(status, "upstream");
  assert.equal(line, null, "no cookie is written when the variant is not supported");
});

test("a missing secret is reported absent, never guessed", () => {
  assert.equal(mint({ kind: "supabase", role: "user", env: ["SUPABASE_JWT_SECRET"] }, "OTHER=1\n").status, "absent");
  assert.equal(mint({ kind: "authjs", role: "user", header: "cookie", env: ["AUTH_SECRET"] }, "OTHER=1\n").status, "absent");
});
