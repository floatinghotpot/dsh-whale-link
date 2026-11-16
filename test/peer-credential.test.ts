/**
 * Unit tests for the plugin's own owner credential.
 *
 * The tunnel forwards this Cookie to the local dsh and the registered
 * AuthenticationProvider verifies it there, so the contract that matters is:
 * exactly the minted value is accepted, everything ambiguous or foreign is
 * refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PEER_COOKIE_NAME, createPeerCredential } from "../src/peer-credential.ts";

const SECRET = "A".repeat(43);

test("cookieHeader is the named cookie carrying the secret", () => {
  const credential = createPeerCredential(SECRET);
  assert.equal(credential.cookieHeader, `${PEER_COOKIE_NAME}=${SECRET}`);
});

test("default secrets are random and valid", () => {
  const first = createPeerCredential();
  const second = createPeerCredential();
  assert.notEqual(first.cookieHeader, second.cookieHeader);
  assert.match(first.cookieHeader, /^dsh-whale-link=[A-Za-z0-9_-]{43}$/u);
});

test("accepts the request that carries exactly the minted cookie", () => {
  const credential = createPeerCredential(SECRET);
  assert.equal(credential.accepts({ headers: { cookie: credential.cookieHeader } }), true);
});

test("accepts the cookie among unrelated cookies", () => {
  const credential = createPeerCredential(SECRET);
  const headers = { cookie: `rdsh_gate=1; ${credential.cookieHeader}; theme=light` };
  assert.equal(credential.accepts({ headers }), true);
});

test("rejects a wrong secret, a missing cookie, and a malformed value", () => {
  const credential = createPeerCredential(SECRET);
  for (const headers of [
    { cookie: `${PEER_COOKIE_NAME}=${"B".repeat(43)}` },
    { cookie: "theme=light" },
    {},
    { cookie: `${PEER_COOKIE_NAME}=short` },
    { cookie: `${PEER_COOKIE_NAME}=${"A".repeat(42)}` },
    { cookie: `${PEER_COOKIE_NAME}=${"A".repeat(44)}` },
  ]) {
    assert.equal(credential.accepts({ headers }), false, `expected rejection for ${JSON.stringify(headers)}`);
  }
});

test("rejects a repeated credential cookie instead of picking one", () => {
  const credential = createPeerCredential(SECRET);
  assert.equal(
    credential.accepts({ headers: { cookie: `a=1; ${credential.cookieHeader}; ${credential.cookieHeader}` } }),
    false,
  );
});

test("joins repeated cookie headers and refuses a duplicated credential", () => {
  const credential = createPeerCredential(SECRET);
  assert.equal(credential.accepts({ headers: { cookie: [`x=1`, `y=2`] } }), false);
  assert.equal(
    credential.accepts({ headers: { cookie: [`x=1`, `y=2`, credential.cookieHeader] } }),
    true,
  );
  assert.equal(
    credential.accepts({ headers: { cookie: [credential.cookieHeader, credential.cookieHeader] } }),
    false,
  );
});

test("reads Fetch-style Headers as well as node:http records", () => {
  const credential = createPeerCredential(SECRET);
  assert.equal(credential.accepts({ headers: new Headers({ cookie: credential.cookieHeader }) }), true);
  assert.equal(credential.accepts({ headers: new Headers({ cookie: "theme=light" }) }), false);
  assert.equal(credential.accepts({ headers: new Headers() }), false);
});

test("refuses a secret that is not 32 base64url-encoded bytes", () => {
  for (const secret of ["", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}+`, "ü".repeat(43)]) {
    assert.throws(() => createPeerCredential(secret), /32 base64url-encoded bytes/u);
  }
});
