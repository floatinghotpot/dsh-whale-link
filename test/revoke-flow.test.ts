import { test } from "node:test";
import assert from "node:assert/strict";
import { performRevoke } from "../src/revoke-flow.ts";
import type { RevokeSteps } from "../src/revoke-flow.ts";

/** Build the five steps, recording their order unless an override replaces one. */
function makeSteps(calls: string[], overrides: Partial<RevokeSteps> = {}): RevokeSteps {
  return {
    stopTunnel: async () => { calls.push("stopTunnel"); },
    stopDirect: async () => { calls.push("stopDirect"); },
    saveLan: async () => { calls.push("saveLan"); },
    clearToken: () => { calls.push("clearToken"); },
    selfRevoke: async () => { calls.push("selfRevoke"); },
    hubTimeoutMs: 50,
    ...overrides,
  };
}

test("按 stopTunnel → stopDirect → saveLan → clearToken → selfRevoke 顺序执行", async () => {
  const calls: string[] = [];
  const outcome = await performRevoke(makeSteps(calls));
  assert.deepEqual(calls, ["stopTunnel", "stopDirect", "saveLan", "clearToken", "selfRevoke"]);
  assert.deepEqual(outcome, {});
});

test("stopTunnel 失败仍完成本地注销与 hub 步骤", async () => {
  const calls: string[] = [];
  const outcome = await performRevoke(makeSteps(calls, {
    stopTunnel: async () => {
      calls.push("stopTunnel");
      throw new Error("stop boom");
    },
  }));
  assert.deepEqual(calls, ["stopTunnel", "stopDirect", "saveLan", "clearToken", "selfRevoke"]);
  assert.equal(outcome.teardownError, "stop boom");
  assert.equal(outcome.hubError, undefined);
});

test("stopDirect 失败记录 teardownError，其余步骤继续", async () => {
  const calls: string[] = [];
  const outcome = await performRevoke(makeSteps(calls, {
    stopDirect: async () => {
      calls.push("stopDirect");
      throw new Error("direct boom");
    },
  }));
  assert.deepEqual(calls, ["stopTunnel", "stopDirect", "saveLan", "clearToken", "selfRevoke"]);
  assert.equal(outcome.teardownError, "direct boom");
});

test("两个 teardown 都失败时只保留第一个原因", async () => {
  const calls: string[] = [];
  const outcome = await performRevoke(makeSteps(calls, {
    stopTunnel: async () => {
      calls.push("stopTunnel");
      throw new Error("tunnel first");
    },
    stopDirect: async () => {
      calls.push("stopDirect");
      throw new Error("direct second");
    },
  }));
  assert.equal(outcome.teardownError, "tunnel first");
});

test("selfRevoke 失败仍标记本地注销完成", async () => {
  const calls: string[] = [];
  const outcome = await performRevoke(makeSteps(calls, {
    selfRevoke: async () => {
      calls.push("selfRevoke");
      throw new Error("hub rejected");
    },
  }));
  assert.deepEqual(calls, ["stopTunnel", "stopDirect", "saveLan", "clearToken", "selfRevoke"]);
  assert.equal(outcome.hubError, "hub rejected");
  assert.equal(outcome.teardownError, undefined);
});

test("selfRevoke 挂起时有界返回", async () => {
  const calls: string[] = [];
  const started = Date.now();
  const outcome = await performRevoke(makeSteps(calls, {
    selfRevoke: () => new Promise<void>(() => {}),
    hubTimeoutMs: 40,
  }));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 30 && elapsed < 1000, `bounded hub wait (${elapsed}ms)`);
  assert.match(outcome.hubError ?? "", /timed out after 40ms/u);
  assert.deepEqual(calls, ["stopTunnel", "stopDirect", "saveLan", "clearToken"]);
});

test("saveLan 失败向外传播，且不再清 token / 调 hub", async () => {
  const calls: string[] = [];
  await assert.rejects(
    performRevoke(makeSteps(calls, {
      saveLan: async () => {
        calls.push("saveLan");
        throw new Error("disk full");
      },
    })),
    /disk full/u,
  );
  assert.deepEqual(calls, ["stopTunnel", "stopDirect", "saveLan"]);
});
