/**
 * The plugin's own owner credential for requests forwarded to the local dsh.
 *
 * dsh `0.2.2-rc.2` removed `connection.authenticatedUrl`, which this plugin used
 * to exchange dsh's launch token for a browser-session Cookie, and it moved
 * every WebServer route behind Connection's authentication providers. The
 * tunnel still has to authenticate the requests it forwards to the local dsh,
 * so the plugin mints a per-process secret, forwards it as a Cookie segment on
 * those requests (the gateway treats `dshAuthCookieHeader` opaquely), and
 * registers an `AuthenticationProvider` that maps exactly that Cookie to its
 * owner Peer.
 *
 * The module owns the credential format and its comparison only, so the
 * contract is unit-testable without a tunnel or a Cordis context.
 * @module
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** Cookie name carrying the plugin's own credential on forwarded requests. */
export const PEER_COOKIE_NAME = "dsh-whale-link";

/** A Fetch-style header container: node:http records carry no `get` method. */
export interface HeaderBag {
  get(name: string): string | null;
}

/** Header containers Connection passes to an authentication provider. */
export type CredentialHeaders =
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | HeaderBag;

/** The request facts the verifier reads. */
export interface CredentialRequest {
  readonly headers: CredentialHeaders;
}

/** One process-scoped credential: the forwarded Cookie segment plus its verifier. */
export interface PeerCredential {
  /** `name=value` Cookie segment the local dsh accepts for this process. */
  readonly cookieHeader: string;
  /** Whether the request carries exactly this credential. */
  accepts(request: CredentialRequest): boolean;
}

/** Shape of a 32-byte base64url secret. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** Whether `headers` is a Fetch-style container rather than a node:http record. */
function isHeaderBag(headers: CredentialHeaders): headers is HeaderBag {
  return typeof (headers as HeaderBag).get === "function";
}

/** The raw `cookie` header text, or `undefined` when the request carries none. */
function cookieText(headers: CredentialHeaders): string | undefined {
  if (isHeaderBag(headers)) return headers.get("cookie") ?? undefined;
  const raw = headers["cookie"];
  if (typeof raw === "string") return raw;
  /* A repeated node:http header arrives as an array; joining keeps the
  duplicate-cookie refusal below effective. */
  if (Array.isArray(raw)) return raw.join("; ");
  return undefined;
}

/**
 * The credential value the request carries.
 * @param headers - request headers.
 * @returns the single `dsh-whale-link` cookie value, or `undefined` when it is
 * absent or repeated (an ambiguous credential is refused, never guessed).
 */
function credentialValue(headers: CredentialHeaders): string | undefined {
  const text = cookieText(headers);
  if (text === undefined) return undefined;
  let value: string | undefined;
  for (const part of text.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0 || part.slice(0, equals).trim() !== PEER_COOKIE_NAME) continue;
    if (value !== undefined) return undefined;
    value = part.slice(equals + 1).trim();
  }
  return value;
}

/**
 * Mint the credential accepted for one plugin process.
 * @param secret - 32 base64url-encoded bytes; a random secret is generated when
 * omitted (tests pass their own).
 * @returns the Cookie segment forwarded to the local dsh plus the verifier that
 * accepts exactly that segment.
 * @throws when `secret` is not 43 base64url characters.
 */
export function createPeerCredential(secret: string = randomBytes(32).toString("base64url")): PeerCredential {
  if (!SECRET_PATTERN.test(secret)) {
    throw new Error("dsh-whale-link: peer credential secret must be 32 base64url-encoded bytes");
  }
  const expected = Buffer.from(secret, "ascii");
  return {
    cookieHeader: `${PEER_COOKIE_NAME}=${secret}`,
    accepts(request: CredentialRequest): boolean {
      const value = credentialValue(request.headers);
      if (value === undefined || !SECRET_PATTERN.test(value)) return false;
      const actual = Buffer.from(value, "ascii");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
}
