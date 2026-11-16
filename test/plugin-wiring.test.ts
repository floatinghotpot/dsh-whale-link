/**
 * Wiring tests for `apply()`: the owner Peer, the credential provider, and the
 * route's admission policy plus returned promise.
 *
 * These are the connections the Desktop crash depended on (a provider that maps
 * the forwarded Cookie to an owner Peer, and a route whose promise WebServer can
 * await), so they are asserted directly instead of only through the pure
 * modules. Isolation matches the lifecycle tests: a temporary HOME plus a
 * dynamic import, so `autoConnect` cannot reach the developer's real tunnel.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

interface RouteLike {
  kind: string;
  path: string;
  auth: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

interface ProviderLike {
  authenticate(request: { headers: Record<string, unknown> }): unknown;
}

interface Recorded {
  routes: RouteLike[];
  providers: ProviderLike[];
  peerOptions: unknown[];
  effects: string[];
}

/** Fake Context recording the contributions `apply` makes. */
function makeCtx(): { ctx: unknown; recorded: Recorded } {
  const recorded: Recorded = { routes: [], providers: [], peerOptions: [], effects: [] };
  const ctx = {
    connection: {
      createPeer(options: unknown): unknown {
        recorded.peerOptions.push(options);
        return { principal: { kind: "owner" } };
      },
      authentication: {
        register(provider: ProviderLike): () => void {
          recorded.providers.push(provider);
          return () => {};
        },
      },
    },
    webServer: {
      port: 0,
      register(route: RouteLike): () => void {
        recorded.routes.push(route);
        return () => {};
      },
    },
    effect(cb: () => unknown, label: string): void {
      recorded.effects.push(label);
      cb();
    },
    on(_event: string, _cb: () => void): void {},
    get(_name: string): unknown {
      return undefined;
    },
  };
  return { ctx, recorded };
}

/** Minimal request/response doubles for one GET on the route. */
function makeExchange(): { req: IncomingMessage; res: ServerResponse; status: { value: number } } {
  const status = { value: 0 };
  const res = {
    writeHead(code: number) {
      status.value = code;
      return res;
    },
    end() {
      return res;
    },
    on() {
      return res;
    },
    get writableEnded() {
      return true;
    },
  };
  const req = {
    method: "GET",
    url: "/remote-access/state",
    headers: {},
    destroy() {},
    async *[Symbol.asyncIterator]() {},
  };
  return { req: req as unknown as IncomingMessage, res: res as unknown as ServerResponse, status };
}

test("apply wires one owner provider, a required route, and a handler returning its promise", async () => {
  const home = await mkdtemp(join(tmpdir(), "rdsh-wiring-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { apply } = await import("../src/index.ts");
    type ApplyCtx = Parameters<typeof apply>[0];

    const { ctx, recorded } = makeCtx();
    apply(ctx as unknown as ApplyCtx);

    assert.equal(recorded.providers.length, 1, "exactly one credential provider is registered");
    assert.deepEqual(recorded.peerOptions, [{ principal: { kind: "owner" } }], "the provider admits a plugin-owned owner Peer");
    assert.ok(
      recorded.effects.some((label) => label.includes("owner credential provider")),
      "the provider registration is owned by the plugin fiber",
    );

    const provider = recorded.providers[0]!;
    assert.equal(provider.authenticate({ headers: {} }), undefined, "no cookie is not admitted");
    assert.equal(provider.authenticate({ headers: { cookie: "theme=light" } }), undefined, "a foreign cookie is not admitted");
    assert.equal(
      provider.authenticate({ headers: { cookie: `dsh-whale-link=${"B".repeat(43)}` } }),
      undefined,
      "a wrong value for the plugin cookie is not admitted",
    );

    assert.equal(recorded.routes.length, 1, "the /remote-access route is registered once");
    const route = recorded.routes[0]!;
    assert.equal(route.kind, "prefix");
    assert.equal(route.path, "/remote-access");
    assert.equal(route.auth, "required", "admission is DSH's, not the handler's");

    const { req, res, status } = makeExchange();
    const pending = route.handler(req, res);
    assert.ok(
      typeof (pending as Promise<void>)?.then === "function",
      "the handler returns its promise so WebServer can contain a failure",
    );
    await pending;
    assert.equal(status.value, 404, "a GET is answered by the route's own status semantics");
  } finally {
    process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});
