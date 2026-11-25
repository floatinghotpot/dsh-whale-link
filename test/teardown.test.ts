import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";

/**
 * 生命周期测试（真实 cordis Context）：验证 `apply()` 的收尾走 `ctx.effect` disposer，
 * 且宿主 `fiber.dispose()` 会**真的执行并 await** 它——这是 0.14.0 之前「收尾从未被调用」
 * 那个 bug 的盲区。用真实 Context 而不是假 ctx，才能抓住「注册了但宿主不调用」这类回归。
 *
 * 隔离：与 singleton.test.ts 一致，临时 HOME + 动态 import，避免 autoConnect 拉起真实隧道。
 */

interface FakeWebServer {
  port: number;
  register: () => () => void;
}

type Shape = "provider" | "session";

function makeCtx(
  shape: Shape,
  onRegister: () => void,
  onProviderDisposed: () => void = () => {},
  onRouteDisposed: () => void = () => {},
): Context {
  const ctx = new Context();
  const webServer: FakeWebServer = {
    port: 0,
    register: () => {
      onRegister();
      return () => { onRouteDisposed(); };
    },
  };
  ctx.provide("webServer", webServer);
  if (shape === "provider") {
    // Master exposes the credential registry as the nested service
    // `connection.authentication`; the plugin reads it via `ctx.get`.
    ctx.provide("connection", { createPeer: () => ({ principal: { kind: "owner" } }) });
    ctx.provide("connection.authentication", { register: () => () => { onProviderDisposed(); } });
  } else {
    // Release line: no provider registry; the session path uses these two methods.
    ctx.provide("connection", {
      createPeer: () => ({ principal: { kind: "owner" } }),
      authenticatedUrl: (base: string) => `${base}/?no-token=1`,
      requestRejection: () => undefined,
    });
  }
  return ctx;
}

test("真实 cordis：fiber.dispose() 执行收尾 disposer 并复位单例", async () => {
  const home = await mkdtemp(join(tmpdir(), "rdsh-teardown-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { apply } = await import("../src/index.ts");
    type ApplyCtx = Parameters<typeof apply>[0];

    let registerCount = 0;
    let providerDisposals = 0;

    const ctx1 = makeCtx("provider", () => { registerCount += 1; }, () => { providerDisposals += 1; });
    apply(ctx1 as unknown as ApplyCtx);
    assert.equal(registerCount, 1, "第一个实例注册 RPC 路由");
    assert.equal(providerDisposals, 0, "provider 在 apply 阶段不撤销");

    const ctx2 = makeCtx("provider", () => { registerCount += 1; });
    apply(ctx2 as unknown as ApplyCtx);
    assert.equal(registerCount, 1, "第二个实例被单例拦住，零注册");

    // 关键断言：真实 fiber.dispose() 会执行收尾 disposer → 复位单例，
    // 并撤销归插件 fiber 的凭据 provider。
    await ctx1.fiber.dispose();
    assert.equal(providerDisposals, 1, "fiber dispose 撤销凭据 provider（注册归属插件 fiber）");

    const ctx3 = makeCtx("provider", () => { registerCount += 1; }, () => { providerDisposals += 1; });
    apply(ctx3 as unknown as ApplyCtx);
    assert.equal(registerCount, 2, "dispose 后单例已复位，第三个实例重新注册");

    await ctx3.fiber.dispose();
    assert.equal(providerDisposals, 2, "第三个实例的 provider 同样随 fiber 撤销");
  } finally {
    process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("session 态：路由随 fiber 撤销，且不注册 provider", async () => {
  const home = await mkdtemp(join(tmpdir(), "rdsh-teardown-session-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { apply } = await import("../src/index.ts");
    type ApplyCtx = Parameters<typeof apply>[0];

    let registerCount = 0;
    let routeDisposals = 0;
    let providerDisposals = 0;

    const ctx = makeCtx(
      "session",
      () => { registerCount += 1; },
      () => { providerDisposals += 1; },
      () => { routeDisposals += 1; },
    );
    apply(ctx as unknown as ApplyCtx);
    assert.equal(registerCount, 1, "session 态仍注册 RPC 路由");
    assert.equal(providerDisposals, 0, "session 态没有 provider 可撤销");

    await ctx.fiber.dispose();
    assert.equal(routeDisposals, 1, "fiber dispose 撤销 RPC 路由");
    assert.equal(providerDisposals, 0, "session 态始终不注册 provider");
  } finally {
    process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});
