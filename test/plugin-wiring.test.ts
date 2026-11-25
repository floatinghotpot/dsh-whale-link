/**
 * Wiring tests for `apply()`: the generation-specific credential wiring, the
 * route's admission policy and its returned promise, plus the `inject` regression
 * lock for the release-line activation bug.
 *
 * Isolation matches the lifecycle tests: a temporary HOME plus a dynamic import,
 * so `autoConnect` cannot reach the developer's real tunnel.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
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

type Shape = "provider" | "session" | "unsupported";

interface EffectRecord {
  label: string;
  disposer: unknown;
}

interface Recorded {
  routes: RouteLike[];
  providers: ProviderLike[];
  peerOptions: unknown[];
  effects: EffectRecord[];
  rejectionCalls: number;
}

const home = await mkdtemp(join(tmpdir(), "rdsh-wiring-"));
const previousHome = process.env.HOME;
process.env.HOME = home;
const { apply } = await import("../src/index.ts");

after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

/** Fake Context recording the contributions `apply` makes for one generation. */
function makeCtx(shape: Shape): { ctx: unknown; recorded: Recorded } {
  const recorded: Recorded = { routes: [], providers: [], peerOptions: [], effects: [], rejectionCalls: 0 };
  const providerService = {
    register(provider: ProviderLike): () => void {
      recorded.providers.push(provider);
      return () => {};
    },
  };
  const session = shape === "session"
    ? {
        // 无 token：apply 的换发直接返回 null、不触网；guard 行为由下面的假实现决定。
        authenticatedUrl: (base: string): string => `${base}/?no-token=1`,
        requestRejection: (request: { headers: { cookie?: string } }): 401 | 403 | undefined => {
          recorded.rejectionCalls += 1;
          return typeof request.headers.cookie === "string" && request.headers.cookie.includes("dsh-auth-test=1")
            ? undefined
            : 401;
        },
      }
    : {};
  const ctx = {
    connection: {
      createPeer(options: unknown): unknown {
        recorded.peerOptions.push(options);
        return { principal: { kind: "owner" } };
      },
      ...session,
    },
    webServer: {
      port: 0,
      register(route: RouteLike): () => void {
        recorded.routes.push(route);
        return () => {};
      },
    },
    effect(cb: () => unknown, label: string): void {
      recorded.effects.push({ label, disposer: cb() });
    },
    on(_event: string, _cb: () => void): void {},
    get(name: string): unknown {
      return shape === "provider" && name === "connection.authentication" ? providerService : undefined;
    },
  };
  return { ctx, recorded };
}

/** Run the plugin fiber's teardown so the next case can apply again. */
async function dispose(recorded: Recorded): Promise<void> {
  const teardown = recorded.effects.find((effect) => effect.label.includes("teardown"));
  if (typeof teardown?.disposer === "function") await (teardown.disposer as () => Promise<void>)();
}

/** Minimal request/response doubles for one call on the route. */
function makeExchange(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  remoteAddress?: string;
} = {}): { req: IncomingMessage; res: ServerResponse; status: { value: number }; text: { value: string } } {
  const status = { value: 0 };
  const text = { value: "" };
  const res = {
    writeHead(code: number) {
      status.value = code;
      return res;
    },
    end(chunk?: string) {
      text.value += chunk ?? "";
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
    method: options.method ?? "GET",
    url: options.url ?? "/remote-access/state",
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
    destroy() {},
    async *[Symbol.asyncIterator]() {
      if (options.body !== undefined) yield Buffer.from(options.body);
    },
  };
  return { req: req as unknown as IncomingMessage, res: res as unknown as ServerResponse, status, text };
}

const envelope = (method: string, args: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "client-request", rpcId: "test-rpc", method, payload: { args } });

test("inject 不再依赖 connection.authentication（发布线激活的机械锁）", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const match = /export const inject = \[([\s\S]*?)\];/u.exec(source);
  assert.ok(match !== null, "src/index.ts must declare `export const inject = [...]`");
  assert.ok(!match[1]!.includes("connection.authentication"), "inject must not require the provider-only service");
});

test("provider 代：注册 owner provider、route 声明 auth，handler 返回 promise", async () => {
  const { ctx, recorded } = makeCtx("provider");
  try {
    apply(ctx as never);

    assert.equal(recorded.effects.length, 3, "provider + route + teardown are the only effects");
    assert.equal(recorded.providers.length, 1, "exactly one credential provider is registered");
    assert.deepEqual(recorded.peerOptions, [{ principal: { kind: "owner" } }]);
    assert.ok(
      recorded.effects.some((effect) => effect.label.includes("owner credential provider")),
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

    assert.equal(recorded.routes.length, 1);
    const route = recorded.routes[0]!;
    assert.equal(route.kind, "prefix");
    assert.equal(route.path, "/remote-access");
    assert.equal(route.auth, "required", "admission is DSH's, not the handler's");

    const exchange = makeExchange();
    const pending = route.handler(exchange.req, exchange.res);
    assert.ok(
      typeof (pending as Promise<void>)?.then === "function",
      "the handler returns its promise so WebServer can contain a failure",
    );
    await pending;
    assert.equal(exchange.status.value, 404, "a GET is answered by the route's own status semantics");
    assert.equal(recorded.rejectionCalls, 0, "the provider generation never calls requestRejection");
  } finally {
    await dispose(recorded);
  }
});

test("session 代：不注册 provider，guard 用 requestRejection 准入", async () => {
  const { ctx, recorded } = makeCtx("session");
  try {
    apply(ctx as never);

    assert.equal(recorded.providers.length, 0, "the release line has no provider registry");
    assert.equal(recorded.effects.length, 2, "route + teardown, no provider effect");
    assert.equal(recorded.routes.length, 1);
    const route = recorded.routes[0]!;
    assert.equal(route.auth, "required");

    const denied = makeExchange({ method: "POST", headers: { "content-type": "application/json" }, body: envelope("state") });
    await route.handler(denied.req, denied.res);
    assert.equal(denied.status.value, 401, "no DSH session cookie is refused");
    assert.equal(recorded.rejectionCalls, 1);

    const admitted = makeExchange({
      method: "POST",
      headers: { "content-type": "application/json", cookie: "dsh-auth-test=1" },
      body: envelope("state"),
    });
    await route.handler(admitted.req, admitted.res);
    assert.equal(admitted.status.value, 200);
    assert.match(admitted.text.value, /"type":"server-response"/u);

    assert.ok(
      !recorded.effects.some((effect) => effect.label.includes("owner credential provider")),
      "the session generation registers no provider",
    );
  } finally {
    await dispose(recorded);
  }
});

test("unsupported 代：仍注册路由，只放行只读 state，其余 503", async () => {
  const { ctx, recorded } = makeCtx("unsupported");
  try {
    apply(ctx as never);

    assert.equal(recorded.routes.length, 1, "the route stays registered so the panel can read state");
    assert.equal(recorded.effects.length, 2, "route + teardown, no provider effect");
    const route = recorded.routes[0]!;

    const state = makeExchange({ method: "POST", headers: { "content-type": "application/json" }, body: envelope("state") });
    await route.handler(state.req, state.res);
    assert.equal(state.status.value, 200, "state stays readable so the panel can show the reason");
    assert.match(state.text.value, /"message":"[^"]*无法识别/u, "the panel receives the unsupported-generation reason");

    const remoteState = makeExchange({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: envelope("state"),
      remoteAddress: "10.0.0.5",
    });
    await route.handler(remoteState.req, remoteState.res);
    assert.equal(remoteState.status.value, 503, "a non-loopback caller cannot read state on an unknown generation");

    const connect = makeExchange({
      method: "POST",
      url: "/remote-access/connect",
      headers: { "content-type": "application/json" },
      body: envelope("connect", { hub: "https://example.invalid" }),
    });
    await route.handler(connect.req, connect.res);
    assert.equal(connect.status.value, 503, "mutating endpoints are refused");
  } finally {
    await dispose(recorded);
  }
});
