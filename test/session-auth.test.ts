/**
 * Release-line credential path: the plugin asks DSH for an authenticated URL, the
 * launch token is exchanged for a browser-session Cookie over real HTTP, and the
 * route guard delegates admission to `requestRejection`. The failure case proves
 * `connect` refuses without a tunnel when no cookie can be minted.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "rdsh-session-auth-"));
const previousHome = process.env.HOME;
process.env.HOME = home;
const { apply } = await import("../src/index.ts");

after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

interface RouteLike {
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

interface EffectRecord {
  label: string;
  disposer: unknown;
}

interface Harness {
  routes: RouteLike[];
  effects: EffectRecord[];
  rejections: number;
}

const envelope = (method: string, args: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "client-request", rpcId: "test-rpc", method, payload: { args } });

function makeExchange(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
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
    socket: { remoteAddress: "127.0.0.1" },
    destroy() {},
    async *[Symbol.asyncIterator]() {
      if (options.body !== undefined) yield Buffer.from(options.body);
    },
  };
  return { req: req as unknown as IncomingMessage, res: res as unknown as ServerResponse, status, text };
}

async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "server must expose an address");
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Fake Context for the session generation: real port, real requestRejection wiring. */
function makeCtx(options: {
  port: number;
  token: string | null;
  reject: (headers: Record<string, string | undefined>) => boolean;
  harness: Harness;
}): unknown {
  const { port, token, reject, harness } = options;
  return {
    connection: {
      createPeer: () => ({ principal: { kind: "owner" } }),
      authenticatedUrl: (base: string): string => (token === null ? `${base}/?no-token=1` : `${base}/?token=${token}`),
      requestRejection: (request: { headers: Record<string, string | undefined> }): 401 | undefined => {
        harness.rejections += 1;
        return reject(request.headers) ? 401 : undefined;
      },
    },
    webServer: {
      port,
      register(route: RouteLike): () => void {
        harness.routes.push(route);
        return () => {};
      },
    },
    effect(cb: () => unknown, label: string): void {
      harness.effects.push({ label, disposer: cb() });
    },
    on(_event: string, _cb: () => void): void {},
    get(_name: string): unknown {
      return undefined;
    },
  };
}

async function dispose(harness: Harness): Promise<void> {
  const teardown = harness.effects.find((effect) => effect.label.includes("teardown"));
  if (typeof teardown?.disposer === "function") await (teardown.disposer as () => Promise<void>)();
}

test("session 代：启动令牌经真实 HTTP 换发，guard 用 requestRejection 准入", async () => {
  const seen: string[] = [];
  const { server, port } = await startServer((req, res) => {
    seen.push(req.url ?? "");
    res.writeHead(303, { "set-cookie": "dsh-auth-test=1; Path=/; HttpOnly" });
    res.end();
  });
  const harness: Harness = { routes: [], effects: [], rejections: 0 };
  try {
    apply(makeCtx({
      port,
      token: "launch-token",
      reject: (headers) => !String(headers.cookie ?? "").includes("dsh-auth-test=1"),
      harness,
    }) as never);

    assert.equal(harness.routes.length, 1);
    await waitFor(() => seen.length > 0);
    assert.deepEqual(seen, ["/?token=launch-token"], "the launch token is exchanged over the DSH index URL");

    const route = harness.routes[0]!;
    const denied = makeExchange({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: envelope("state"),
    });
    await route.handler(denied.req, denied.res);
    assert.equal(denied.status.value, 401, "a request without the session cookie is refused");

    const admitted = makeExchange({
      method: "POST",
      headers: { "content-type": "application/json", cookie: "dsh-auth-test=1" },
      body: envelope("state"),
    });
    await route.handler(admitted.req, admitted.res);
    assert.equal(admitted.status.value, 200);
    assert.match(admitted.text.value, /"type":"server-response"/u);
  } finally {
    await dispose(harness);
    await closeServer(server);
  }
});

test("session 代换发失败：connect 拒绝并可重试，成功后清掉原因", async () => {
  const exchanges: string[] = [];
  const { server, port } = await startServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/?token=")) {
      exchanges.push(url);
      if (exchanges.length === 1) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("no cookie");
        return;
      }
      res.writeHead(303, { "set-cookie": "dsh-auth-test=1; Path=/; HttpOnly" });
      res.end();
      return;
    }
    // 任何 hub 路径都失败：本用例只验证凭据闸门与重试，不验证入网。
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  const harness: Harness = { routes: [], effects: [], rejections: 0 };
  try {
    apply(makeCtx({ port, token: "launch-token", reject: () => false, harness }) as never);
    const route = harness.routes[0]!;
    const hub = `http://127.0.0.1:${port}`;

    // 第一次：换发拿不到 cookie → connect 明确拒绝，面板 message 有原因。
    const first = makeExchange({
      method: "POST",
      url: "/remote-access/connect",
      headers: { "content-type": "application/json" },
      body: envelope("connect", { hub }),
    });
    await route.handler(first.req, first.res);
    assert.equal(first.status.value, 200, "business failures stay inside a 200 server-response envelope");
    assert.match(first.text.value, /"ok":false/u);
    assert.match(first.text.value, /"code":"dsh-auth"/u);
    assert.equal(exchanges.length, 1);

    const stateAfterFailure = makeExchange({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: envelope("state"),
    });
    await route.handler(stateAfterFailure.req, stateAfterFailure.res);
    assert.match(stateAfterFailure.text.value, /"message":"[^"]*无法取得 DSH 会话凭据/u);

    // 第二次：同一实例重试换发（服务端这次回 cookie）→ 越过凭据闸门，止于入网失败。
    const second = makeExchange({
      method: "POST",
      url: "/remote-access/connect",
      headers: { "content-type": "application/json" },
      body: envelope("connect", { hub }),
    });
    await route.handler(second.req, second.res);
    assert.equal(second.status.value, 200);
    assert.match(second.text.value, /"code":"register-failed"/u);
    assert.equal(exchanges.length, 2, "the failed exchange is retried on the next connect");

    const stateAfterSuccess = makeExchange({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: envelope("state"),
    });
    await route.handler(stateAfterSuccess.req, stateAfterSuccess.res);
    assert.ok(
      !/"message":"[^"]*无法取得 DSH 会话凭据/u.test(stateAfterSuccess.text.value),
      "the stale failure reason is cleared once the exchange succeeds",
    );
  } finally {
    await dispose(harness);
    await closeServer(server);
  }
});
