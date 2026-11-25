import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 单例守卫测试：桌面壳会在同一进程 apply 本插件两次。验证第二次 apply 不注册任何贡献，
 * 且收尾 disposer 复位后、新实例能重新接管。
 *
 * 隔离：apply() 末尾会 void autoConnect()，它读 ~/.rdsh/host.json 与 ~/.rdsh/join.lock。
 * 开发机上这些文件可能是 join 模式 + 有 token ⇒ 会真的拉起隧道。因此先把 HOME 指向临时
 * 目录，再动态 import（保证模块级 homedir() 读到临时 HOME），让 autoConnect 提前返回。
 *
 * 假 ctx 的 effect 必须**立即执行回调并保存返回的 disposer**（与 cordis 一致）——
 * 旧实现只计数、不执行，正是「收尾从未被调用」这个 bug 的盲区来源。
 */

interface EffectEntry {
  label: string;
  disposer: unknown;
}

interface MockCtx {
  connection: {
    createPeer: () => { principal: { kind: string } };
    authenticatedUrl?: (base: string) => string;
    requestRejection?: (request: { headers: Record<string, string | undefined> }) => 401 | 403 | undefined;
  };
  webServer: { port: number; register: () => () => void };
  effect: (cb: () => unknown, label: string) => void;
  on: (event: string, cb: () => void) => void;
  get: (name: string) => unknown;
  effects: EffectEntry[];
  listeners: string[];
}

function makeCtx(shape: "provider" | "session" = "provider"): MockCtx {
  const effects: EffectEntry[] = [];
  const listeners: string[] = [];
  // 每代都要能被 `authGenerationOf` 正确识别：provider 是点号服务（`ctx.get`），
  // session 是 `authenticatedUrl` + `requestRejection` 两个方法。
  const providerService = { register: () => () => {} };
  return {
    connection: {
      createPeer: () => ({ principal: { kind: "owner" } }),
      ...(shape === "session"
        ? {
            authenticatedUrl: (base: string) => `${base}/?no-token=1`,
            requestRejection: () => undefined,
          }
        : {}),
    },
    webServer: { port: 52247, register: () => () => {} },
    effect(cb: () => unknown, label: string): void {
      effects.push({ label, disposer: cb() });
    },
    on(event: string, _cb: () => void): void {
      listeners.push(event);
    },
    get(name: string): unknown {
      return shape === "provider" && name === "connection.authentication" ? providerService : undefined;
    },
    effects,
    listeners,
  };
}

test("apply 是单例：第二次零注册，收尾 disposer 复位后重新接管", async () => {
  const home = await mkdtemp(join(tmpdir(), "rdsh-singleton-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { apply } = await import("../src/index.ts");

    const ctx1 = makeCtx();
    const ctx2 = makeCtx();
    apply(ctx1);
    apply(ctx2);

    assert.equal(ctx1.effects.length, 3, "第一个实例注册凭据 provider + RPC 路由 + 收尾三个 effect");
    assert.ok(ctx1.effects.some((e) => e.label.includes("owner credential provider")), "凭据 provider 经 ctx.effect 注册");
    assert.ok(ctx1.effects.some((e) => e.label.includes("RPC route")), "RPC 路由经 ctx.effect 注册");
    assert.ok(ctx1.effects.some((e) => e.label.includes("teardown")), "第一个实例注册收尾 effect");
    assert.equal(ctx1.listeners.filter((e) => e === "dispose").length, 0, "不再注册 dispose 事件监听");
    assert.equal(ctx2.effects.length, 0, "第二个实例零注册（effect）");
    assert.equal(ctx2.listeners.length, 0, "第二个实例零注册（事件）");

    // 收尾 disposer 复位后，第三个实例应能重新接管；disposer 幂等，连调两次不抛。
    const teardown = ctx1.effects.find((e) => e.label.includes("teardown"))!.disposer as () => Promise<void>;
    await teardown();
    await teardown();

    const ctx3 = makeCtx();
    apply(ctx3);
    assert.equal(ctx3.effects.length, 3, "收尾复位后第三个实例重新注册");

    // 复位单例，让后续用例（session 态）能接管。
    const teardown3 = ctx3.effects.find((e) => e.label.includes("teardown"))!.disposer as () => Promise<void>;
    await teardown3();
  } finally {
    process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("session 态同样是单例：2 个 effect，收尾 disposer 复位后重新接管", async () => {
  const home = await mkdtemp(join(tmpdir(), "rdsh-singleton-session-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { apply } = await import("../src/index.ts");

    const ctx1 = makeCtx("session");
    apply(ctx1);
    assert.equal(ctx1.effects.length, 2, "session 态只有 RPC 路由 + 收尾两个 effect");
    assert.ok(ctx1.effects.some((e) => e.label.includes("RPC route")), "RPC 路由经 ctx.effect 注册");
    assert.ok(
      !ctx1.effects.some((e) => e.label.includes("owner credential provider")),
      "session 态不注册 provider",
    );

    const ctx2 = makeCtx("session");
    apply(ctx2);
    assert.equal(ctx2.effects.length, 0, "第二个实例零注册（effect）");

    const teardown = ctx1.effects.find((e) => e.label.includes("teardown"))!.disposer as () => Promise<void>;
    await teardown();

    const ctx3 = makeCtx("session");
    apply(ctx3);
    assert.equal(ctx3.effects.length, 2, "收尾复位后第三个实例重新注册");

    const teardown3 = ctx3.effects.find((e) => e.label.includes("teardown"))!.disposer as () => Promise<void>;
    await teardown3();
  } finally {
    process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});
