// Originated in remote-dsh/packages/web-remote@0.15.0; the DSH 0.2.2+ authentication here is this edition's.
/**
 * dsh-whale-link — server half (Cordis function plugin, runs in the dsh web process).
 *
 * Runs the join tunnel in-process (no spawn), forwarding to the local dsh web
 * (`127.0.0.1:<webServer.port>`), and exposes the `/remote-access` RPC channel
 * (`connect` / `disconnect` / `revoke` / `state`) to the browser client half.
 *
 * The channel is a native prefix route on the web server (see `./rpc-route.ts`),
 * not `connection.rpc.handle(...)`: since 0.1.5-rc.2 that helper reads
 * `owner.webServer` through a service shadow whose fiber cannot resolve
 * `webServer` for third-party plugins and aborts the whole plugin tree
 * (upstream regression, deepseek-harness discussion #5926).
 *
 * Admission has two generation-specific paths, chosen by `authGenerationOf`:
 * - DSH master (0.2.3+): the route declares `auth: 'required'`, so WebServer's
 *   `webserver/authorize` (source fence plus Connection's credential providers)
 *   runs before the handler; the plugin registers its own owner credential
 *   provider (`./peer-credential.ts`).
 * - DSH 0.2.2-rc.2..rc.5: WebServer ignores the `auth` field, so the handler
 *   calls `connection.requestRejection` itself, and the tunnel/LAN-direct ports
 *   forward a browser-session Cookie minted from this process's launch token.
 *
 * Function-plugin form (export `inject` + `apply`) — no `@deepseek-ai/cordis`
 * runtime import, only a minimal local `Ctx` type.
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerJoin,
  startJoin,
  startDirect,
  createDirectTicketManager,
  loadOrCreateDirectSecret,
  loadOrCreateE2eeKeyPair,
  detectInsecure,
  hubRequest,
  selfRevoke,
  persistToken,
  clearPersistedToken,
  readPersistedToken,
  readJoinLock,
  describeJoinLockAt,
  forceUnlockJoinLock,
  loadConfig,
  saveConfig,
  DEFAULT_HOST_CONFIG_PATH,
  UsageReporter,
  writeHostMeta,
  gatewayVersion,
  exchangeDshSessionCookie,
} from "rdsh-gateway";
import type { DirectHandle, DirectOptions, DirectTicketManager, JoinHandle, JoinState, RdshConfig, UsageMeter } from "rdsh-gateway";
import { RPC_CHANNEL, handleRpcRoute } from "./rpc-route.ts";
import type { RpcDispatch, RpcResult, WebServerService } from "./rpc-route.ts";
import { createPeerCredential } from "./peer-credential.ts";
import type { CredentialRequest } from "./peer-credential.ts";
import { performRevoke } from "./revoke-flow.ts";
import { classifyHolder, scanPluginInstalls, uninstallCommand } from "./lock-diagnostics.ts";

/** 面板状态（client 半五态 + 断开后态 + 注销中） */
export type Status = "unconfigured" | "disconnected" | "connecting" | "connected" | "reconnecting" | "external" | "revoking";

/** 本插件的包名 + 版本号（读自身的 package.json）；读不到时回落默认值。 */
const PLUGIN_META: { name: string; version: string } = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    };
    return {
      name: typeof pkg.name === "string" ? pkg.name : "dsh-whale-link",
      version: typeof pkg.version === "string" ? pkg.version : "unknown",
    };
  } catch {
    return { name: "dsh-whale-link", version: "unknown" };
  }
})();

/** 本插件安装目录（package 根）；用于「本机其它安装」清单里标记 self。 */
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** One Peer as this plugin hands it back to the authentication registry. */
interface PeerLike {
  readonly principal: { readonly kind: string };
}

/** One credential verifier as the DSH authentication registry accepts it. */
interface AuthenticationProviderLike {
  authenticate(request: CredentialRequest): PeerLike | undefined;
}

/** The slice of `connection.authentication` this plugin registers into. */
interface AuthenticationService {
  register(provider: AuthenticationProviderLike): unknown;
}

/** The slice of the DSH connection service this plugin uses across two API generations. */
interface ConnectionService {
  /** Create the plugin-owned owner Peer admitted for the forwarded credential (provider generation). */
  createPeer(options: { principal: { kind: "owner" } }): PeerLike;
  /** 0.2.2-rc.x: add this process's launch token to an application URL; removed on master. */
  authenticatedUrl?(baseUrl: string): string;
  /** 0.2.2-rc.x: Host/Origin fence plus browser-session admission; removed on master. */
  requestRejection?(request: {
    readonly headers: Record<string, string | readonly string[] | undefined>;
  }): 401 | 403 | undefined;
}

interface Ctx {
  connection: ConnectionService;
  webServer: WebServerService;
  effect(callback: () => unknown, label: string): void;
  on(event: string, cb: () => void): void;
  /**
   * 读取服务而不建立硬依赖（缺席返回 undefined）。用于取 `directoryPicker`
   * 做只读诊断——本插件不 inject 它，避免没有选择器的组合把插件树拖垮。
   */
  get(name: string): unknown;
}

/** Which Connection authentication generation this DSH build exposes. */
type AuthGeneration = "provider" | "session" | "unsupported";

/**
 * Pick the authentication generation by capability, never by version string
 * (the release line and master carry overlapping version numbers).
 *
 * ⚠ Read the provider service through `ctx.get`: some Cordis builds redirect
 * `ctx.connection.authentication` to a dotted service access that requires an
 * `inject` declaration and throws without it, which would park the plugin in
 * `pending` again on the release line.
 * @param ctx - plugin context.
 * @returns the generation whose wiring `apply` should install.
 */
function authGenerationOf(ctx: Ctx): AuthGeneration {
  const provider = ctx.get("connection.authentication") as AuthenticationService | undefined;
  if (typeof provider?.register === "function" && typeof ctx.connection.createPeer === "function") return "provider";
  if (
    typeof ctx.connection.authenticatedUrl === "function"
    && typeof ctx.connection.requestRejection === "function"
  ) return "session";
  return "unsupported";
}

/** `directoryPicker` 服务的最小形状（只读 kind，避免依赖上游类型包）。 */
interface DirectoryPickerLike {
  capability?: () => { kind?: string } | undefined;
}

/** 本部署期望的选择器形态：插件就是为远程访问而生，必须是浏览器内形态。 */
const EXPECTED_PICKER_KIND = "browse";

/** 当前解析出的选择器形态（`browse` / `native` / `none` / `unknown`）——只读诊断，不参与业务。 */
function pickerKindOf(ctx: { get(name: string): unknown }): string {
  try {
    const kind = (ctx.get("directoryPicker") as DirectoryPickerLike | undefined)?.capability?.()?.kind;
    return typeof kind === "string" ? kind : "none";
  } catch {
    return "unknown";
  }
}

/**
 * 面板用的目录选择器诊断（纯函数，便于单测）。
 * `pickerOk === false` 是远端访问的**故障信号**：说明选择器不是浏览器内形态，
 * 远端浏览器只会看到弹在宿主屏幕上的原生对话框。
 */
export function pickerDiagnostics(ctx: { get(name: string): unknown }): {
  pickerKind: string;
  expectedPickerKind: string;
  pickerOk: boolean;
} {
  const pickerKind = pickerKindOf(ctx);
  return { pickerKind, expectedPickerKind: EXPECTED_PICKER_KIND, pickerOk: pickerKind === EXPECTED_PICKER_KIND };
}

const ok = (value: unknown): RpcResult => ({ ok: true, value });
const err = (code: string, message: string, details?: unknown): RpcResult => ({ ok: false, error: { code, message, details: details ?? {} } });

function mapState(s: JoinState): Status {
  switch (s) {
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "rejected":
    case "stopped":
    case "superseded":
      return "disconnected";
  }
}

export const inject = ["connection", "webServer"];

/**
 * 单例守卫：桌面壳会在同一进程里 apply 本插件两次（组合配置只有一行，重复来自宿主）。
 * 只让第一个实例干活，第二个实例在注册任何贡献之前直接退出；dispose 时复位，保证
 * 「卸载 → 重装不重启」时新实例能正常接管。
 */
let applied = false;

/** 直连口 EADDRINUSE 退避重试间隔（上一个实例异步释放端口期间；累计约 3.5s）。 */
const EADDRINUSE_RETRY_DELAYS_MS = [500, 1000, 2000];

/** 收尾时 hub 上报类操作的上限：`hubRequest` 默认 10s 超时，会吃满桌面端 10s 优雅窗口。 */
const TEARDOWN_FLUSH_BUDGET_MS = 1500;

/** 注销时等待 hub 侧确认的上限：超时按失败提示，但不阻塞本地注销。 */
const REVOKE_HUB_TIMEOUT_MS = 3_000;

/** 起直连口；撞 EADDRINUSE（上一实例异步释放端口期间）按退避间隔重试，最终失败则抛给 syncDirect 降级。 */
async function startDirectWithRetry(opts: DirectOptions): Promise<DirectHandle> {
  for (let attempt = 0; attempt <= EADDRINUSE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await startDirect(opts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt === EADDRINUSE_RETRY_DELAYS_MS.length) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, EADDRINUSE_RETRY_DELAYS_MS[attempt]));
    }
  }
  // 不可达：循环要么 return 要么 throw。
  throw new Error("unreachable");
}

export function apply(ctx: Ctx): void {
  if (applied) return;
  /**
   * 用量上报器：**归插件进程**，不随隧道 handle 走。
   *
   * 直连口按设计比隧道活得久（`disconnect` 只停隧道），而 `startTunnel` 每次重连都会
   * 新建 handle——若直连口沿用 handle 自建的报告器，重连后就会把字节记进一个已停实例
   * 的 meter（其定时器已清）⇒ 直连流量再次恒 0。故这里持一份进程级 reporter：
   * 首次 `startTunnel` 时建 + `start()`，之后重连/换 hub 只 `setTarget()`。
   * 这样即便隧道断开、只有直连口在服务，它仍能继续定时上报直连字节。
   */
  let reporter: UsageReporter | null = null;
  /** 收尾与 autoConnect 的竞态：dispose 后禁止再建隧道/直连口。 */
  let disposed = false;
  let handle: JoinHandle | null = null;
  let liveState: JoinState | null = null; // 仅隧道运行中非 null
  let currentHub: string | undefined;
  let currentName: string | undefined;
  let lastMessage: string | undefined;
  let liveCompat: boolean | undefined; // 运行中切换的 dshUiCompat（覆盖 host.json）
  let liveAccessCode: string | null | undefined; // 运行中切换的访问密码（undefined=未初始化；null=关闭）
  let currentConfig: RdshConfig | null = null; // 最近一次读到的 host.json
  let directHandle: DirectHandle | null = null; // 直连口（24-direct-first，A 案；与隧道共用同一 dsh）
  let directTicketManager: DirectTicketManager | null = null; // 一次性直连票管理器（R4）
  let directSecret: string | null = null; // 直连密钥（per-host 随机，自动生成）
  let bindSession: { bindId: string; consumeToken: string; hub: string; name: string; insecure: boolean; expiresAt: number } | null = null; // 扫码绑定会话（26）
  let directAccessCode: string | null | undefined = undefined; // 直连口当前应用的口令（undefined=未启动）
  let directMeter: UsageMeter | undefined; // 直连口当前挂的 meter（undefined=没挂，尚未接 hub）
  /** 注销进行中：禁止任何入口再启动隧道/直连口，避免复用旧 token 直连。 */
  let revoking = false;
  /** 一次接入的启动段（connect / scanState approved / autoConnect）是否在进行：与 revoke 互斥。 */
  let starting = false;

  /**
   * 双代认证接线（见 doc/fix/20261125-whale-link-dsh-0.2.2-rc.5-pending/solution.md）。
   *
   * - provider 代（DSH master / 0.2.3+）：插件自铸 owner 凭据，注册
   *   `connection.authentication` provider；转发请求带该 Cookie，准入由 DSH 的
   *   `webserver/authorize` 完成。
   * - session 代（0.2.2-rc.2～rc.5 发布线）：没有 provider 注册表，用本进程启动令牌
   *   经 `GET /?token=` 换一张 DSH 浏览器会话 cookie；路由准入自己调
   *   `requestRejection`（该代 WebServer 不处理 `auth` 字段）。
   * - 两代都没有：插件保持激活，只放行只读 `state`（见路由 guard），面板显示原因。
   *
   * 代际只看能力、不看版本号；provider 服务用 `ctx.get` 读，避免 Cordis 把
   * `ctx.connection.authentication` 重定向成点号服务访问而要求 inject。
   */
  const generation = authGenerationOf(ctx);
  /** 转发到本进程 dsh 的 Cookie 段：provider 代=插件凭据；session 代=换发结果；其它=null。 */
  let dshAuthCookieHeader: string | null = null;
  let cookieTask: Promise<string | null> | null = null;
  /** session 代换发失败的可见原因（换发成功后清掉，避免误导后续失败）。 */
  const SESSION_AUTH_FAILED_MESSAGE = "无法取得 DSH 会话凭据（启动令牌换发失败），远程访问暂不可用";

  if (generation === "provider") {
    const credential = createPeerCredential();
    dshAuthCookieHeader = credential.cookieHeader;
    const provider = ctx.get("connection.authentication") as AuthenticationService;
    const peer = ctx.connection.createPeer({ principal: { kind: "owner" } });
    ctx.effect(
      () => provider.register({ authenticate: (request) => (credential.accepts(request) ? peer : undefined) }),
      "dsh-whale-link: owner credential provider",
    );
  } else if (generation === "session") {
    cookieTask = startSessionCookieExchange();
  } else {
    // 未识别的 DSH 认证代际：插件保持激活，只放行只读 state（见路由 guard）；
    // 面板经 state 读到下面的原因，宿主 stderr 同样留一条（logger 是 Context 自有属性，
    // 不经 reflect.provide，`ctx.get("logger")` 取不到，所以这里用 console）。
    lastMessage = "当前 DSH 的 Connection 认证接口无法识别，远程访问不可用（请升级 dsh-whale-link）";
    console.warn("dsh-whale-link: unsupported DSH Connection authentication generation");
  }

  /**
   * 用本进程启动令牌换一次 DSH 浏览器会话 cookie（session 代专用）。
   * 失败（无令牌 / 服务端不回 cookie / 网络错误）返回 null，由调用方决定不建隧道。
   */
  function startSessionCookieExchange(): Promise<string | null> {
    if (typeof ctx.connection.authenticatedUrl !== "function") return Promise.resolve(null);
    try {
      const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`);
      const token = new URL(url).searchParams.get("token");
      if (token === null) return Promise.resolve(null);
      return exchangeDshSessionCookie(ctx.webServer.port, token).then((cookie) => {
        if (cookie !== null) dshAuthCookieHeader = cookie;
        return cookie;
      });
    } catch {
      return Promise.resolve(null);
    }
  }

  /** 取（或重试）转发凭据；session 代失败返回 null，并在 lastMessage 里留下原因。 */
  async function ensureAuthCookie(): Promise<string | null> {
    if (generation !== "session") return dshAuthCookieHeader;
    if (dshAuthCookieHeader !== null) return dshAuthCookieHeader;
    cookieTask ??= startSessionCookieExchange();
    const task = cookieTask;
    const cookie = await task;
    if (cookieTask === task) cookieTask = null; // 失败允许下一次接入重试
    if (cookie === null) lastMessage = SESSION_AUTH_FAILED_MESSAGE;
    else if (lastMessage === SESSION_AUTH_FAILED_MESSAGE) lastMessage = undefined;
    return cookie;
  }

  const hooks = {
    onState: (s: JoinState, detail?: { message?: string; delayMs?: number }): void => {
      liveState = s;
      if (s === "rejected") {
        // 永久失败（token 吊销）→ 记录原因并停，不重连
        lastMessage = detail?.message ?? "host token rejected by hub";
        handle = null;
        liveState = null;
      } else if (s === "stopped" || s === "superseded") {
        handle = null;
        liveState = null;
      } else if (s === "connected") {
        // 已连接 → 清掉「connecting…」之类的过渡信息
        lastMessage = undefined;
      }
    },
    onLog: (level: "info" | "warn" | "error", message: string): void => {
      // MVP：日志不渲染，仅记录错误供面板 message 展示
      if (level === "error") lastMessage = message;
    },
  };

  /** 读 host.json 非 join 模式是否需确认覆盖（D5 档1：host.json 存在且 mode≠join）。 */
  async function needsOverwriteConfirm(): Promise<boolean> {
    if (!existsSync(DEFAULT_HOST_CONFIG_PATH)) return false;
    const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
    return config.mode !== "join";
  }

  async function connect(args: Record<string, unknown>): Promise<RpcResult> {
    try {
      // 注销进行中：拒绝任何接入请求（否则会复用持久化 token 直连）。
      if (revoking) return err("revoking", "revoke in progress; retry shortly");
      if (typeof args.hub !== "string" || args.hub.trim() === "") {
        return err("bad-request", "hub (string) required");
      }
      const hub = args.hub.trim();
      if (!/^https?:\/\//.test(hub)) return err("bad-request", "hub must be an http(s) URL");
      const token = typeof args.token === "string" && args.token.trim() !== "" ? args.token.trim() : undefined;
      const name = typeof args.name === "string" && args.name.trim() !== "" ? args.name.trim() : undefined;

      // 已在跑 → 幂等返回当前态
      if (handle !== null) {
        return ok({ status: mapState(liveState ?? "connected"), hub: currentHub, name: currentName });
      }

      // 任何他人活锁 → 拒绝（CLI 或另一份插件）；附结构化 lock 供面板渲染诊断。
      const held = readJoinLock();
      if (held !== null) {
        const who = held.pid === process.pid
          ? "another dsh-whale-link instance in this process"
          : held.role === "cli" ? "the rdsh CLI" : "another dsh-whale-link instance";
        // 注：details.lock 刻意只给 {role,pid}（轻量，避免 connect 路径跑 ps）；面板拿到 lock-busy 后
        // 由 1s 轮询把状态翻成 external 并自动调 diagnose 取完整 LockReport。
        return err("lock-busy", `join tunnel is owned by ${who} (pid ${held.pid}); stop it first`, {
          lock: { role: held.role, pid: held.pid },
        });
      }

      // D5 档1：覆盖 lan/cloud 配置需显式确认
      if ((await needsOverwriteConfirm()) && args.confirmOverwrite !== true) {
        return err("mode-conflict", "host.json is not in join mode; re-send with confirmOverwrite: true to overwrite");
      }

      // 双代转发凭据：session 代要先换发 DSH 会话 cookie；拿不到就不建隧道（否则远端必然 401）。
      // 启动段与注销互斥：领取凭据/注册/写 join 配置/起隧道期间不允许注销，
      // 注销也不允许在这里并发启动（否则会把刚写好的 lan 覆盖回 join）。
      if (revoking) return err("revoking", "revoke in progress; retry shortly");
      if (starting) return err("busy", "another join is in progress; retry shortly");
      starting = true;
      try {
        if ((await ensureAuthCookie()) === null) {
          return err("dsh-auth", "DSH session credential unavailable");
        }

        // 注册（join token → host token）或复用持久化 host token；留空 = 复用
        const { token: hostToken, insecure, name: joinedName } = await registerJoin({ hubUrl: hub, token, name });

        // 写 host.json（mode join）
        const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
        config.mode = "join";
        config.hub = hub;
        config.name = joinedName;
        config.insecure = insecure;
        await saveConfig(DEFAULT_HOST_CONFIG_PATH, config);

        // 起隧道：转发到本进程 dsh
        startTunnel(config, hub, hostToken, joinedName, insecure);
        return ok({ status: "connecting", hub, name });
      } finally {
        starting = false;
      }
    } catch (e) {
      return err("register-failed", e instanceof Error ? e.message : String(e));
    }
  }

  /** 扫码绑定：向 hub 申请一次性绑定会话，返回二维码与 consumeToken（26）。 */
  async function beginScan(args: Record<string, unknown>): Promise<RpcResult> {
    try {
      // 注销进行中 / 另一次接入正在启动：不新建扫码会话（否则可能被注销后的轮询消费）。
      if (revoking) return err("revoking", "revoke in progress");
      if (starting) return err("busy", "another join is in progress; retry shortly");
      if (typeof args.hub !== "string" || args.hub.trim() === "") {
        return err("bad-request", "hub (string) required");
      }
      const hub = args.hub.trim().replace(/\/+$/, "");
      if (!/^https?:\/\//.test(hub)) return err("bad-request", "hub must be an http(s) URL");
      const name = typeof args.name === "string" && args.name.trim() !== "" ? args.name.trim() : hostname();
      const insecure = await detectInsecure(hub);
      // 注销可能在网络 await 期间完成：重检，避免注销后写入 bindSession。
      if (revoking) return err("revoking", "revoke in progress");
      const keys = loadOrCreateE2eeKeyPair();
      const res = await hubRequest(hub, "/api/bind-sessions", {
        method: "POST",
        insecure,
        body: { name, e2eePublicKey: keys.publicRaw.toString("base64url") },
      });
      if (revoking) return err("revoking", "revoke in progress");
      if (!res.ok) return err("begin-scan-failed", `bind session create failed: ${res.status}`);
      const j = res.body as { bindId: string; consumeToken: string; expiresAt: number; qrDataUri: string | null };
      bindSession = { bindId: j.bindId, consumeToken: j.consumeToken, hub, name, insecure, expiresAt: j.expiresAt };
      return ok({ bindId: j.bindId, qrDataUri: j.qrDataUri, expiresAt: j.expiresAt });
    } catch (e) {
      return err("begin-scan-failed", e instanceof Error ? e.message : String(e));
    }
  }

  /** 扫码绑定：轮询会话状态；approved 后 consume 换 host token 并复用 startTunnel（26）。 */
  async function scanState(): Promise<RpcResult> {
    try {
      // 注销进行中：不再消费扫码结果（否则会在注销期间拉起隧道）。
      if (revoking) return err("revoking", "revoke in progress");
      if (bindSession === null) return ok({ status: "none" });
      const session = bindSession;
      const { hub, name, bindId, consumeToken, insecure } = session;
      const res = await hubRequest(hub, `/api/bind-sessions/${bindId}`, { method: "GET", insecure });
      // 注销可能已把 bindSession 置空：身份已变/已清，本轮作废，不消费。
      if (bindSession !== session) return ok({ status: "none" });
      if (!res.ok) return ok({ status: "pending" }); // 瞬时错误，面板下一轮重试
      const j = res.body as { status: string };
      if (j.status === "approved") {
        // 注销进行中 / 另一次接入正在启动：本轮不消费，交给下一轮（2s 后）。
        if (revoking) return err("revoking", "revoke in progress");
        if (starting) return ok({ status: "pending" });
        starting = true;
        try {
          const consumeRes = await hubRequest(hub, `/api/bind-sessions/${bindId}/consume`, {
            method: "POST",
            insecure,
            body: { consumeToken },
          });
          if (!consumeRes.ok) {
            // 领取失败（罕见：会话已过期/已被消费）→ 终止扫码，面板显示"已过期"+刷新
            bindSession = null;
            return ok({ status: "expired" });
          }
          const cj = consumeRes.body as { hostId: string; hostToken: string };
          // 持久化 host token（与 registerJoin 一致）→ 断开后「接入」才能复用已存令牌
          persistToken(hub, cj.hostToken);
          const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
          config.mode = "join";
          config.hub = hub;
          config.name = name;
          config.insecure = insecure;
          await saveConfig(DEFAULT_HOST_CONFIG_PATH, config);
          bindSession = null;
          if ((await ensureAuthCookie()) === null) {
            return err("dsh-auth", "DSH session credential unavailable");
          }
          startTunnel(config, hub, cj.hostToken, name, insecure);
          return ok({ status: "connecting", hub, name });
        } finally {
          starting = false;
        }
      }
      if (j.status === "expired") {
        bindSession = null;
        return ok({ status: "expired" });
      }
      return ok({ status: j.status }); // pending / consumed
    } catch (e) {
      return err("scan-state-failed", e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 写 `rdsh-meta.json`：插件形态 + 本插件 / gateway 版本（gateway 不猜，只读）。
   *
   * 只写一次（首次建 reporter 时）；重连不重复写，写失败也不影响隧道。
   */
  function writePluginMeta(): void {
    const versions: Record<string, string> = {};
    if (PLUGIN_META.version !== "") versions[PLUGIN_META.name] = PLUGIN_META.version;
    const gateway = gatewayVersion();
    if (gateway !== null) versions["rdsh-gateway"] = gateway;
    try {
      writeHostMeta({ deviceKind: "desktop", versions });
    } catch {
      // 写失败只影响 meta 上报（退化为不带 deviceKind/versions），不影响隧道。
    }
  }

  /** 起隧道并同步面板状态（connect / autoConnect 共用；转发到本进程 dsh）。 */
  function startTunnel(config: RdshConfig, hub: string, token: string, name: string, insecure: boolean): void {
    // 只判 disposed：三个调用方（connect/scanState/autoConnect）都在置 `starting` 前查过 revoking，
    // 故 revoking=true 时不会再有「新」调用；在途调用必须被允许完成，否则 connect 会返回 connecting
    // 却无隧道（revoke 等待的就是这些在途调用，随后会立即拆掉）。
    if (disposed) return;
    currentConfig = config;
    liveCompat = config.dshUiCompat?.trustE2EEAsLoopback !== false;
    liveAccessCode = config.gateway?.accessCode ?? null;
    currentHub = hub;
    currentName = name;
    lastMessage = undefined;
    directSecret = loadOrCreateDirectSecret();
    directTicketManager = createDirectTicketManager(directSecret);
    // 进程级 reporter：首次建 + start，之后每次重连/换 hub 只更新上报目标。
    if (reporter === null) {
      writePluginMeta();
      reporter = new UsageReporter({ hubUrl: hub, token, insecure, role: "plugin" });
      reporter.start();
    } else {
      reporter.setTarget(hub, token, insecure);
    }
    handle = startJoin({
      hubUrl: hub,
      token,
      insecure,
      target: { host: "127.0.0.1", port: ctx.webServer.port },
      role: "plugin",
      dshUiCompat: config.dshUiCompat,
      gateway: config.gateway,
      direct: { candidates: () => directHandle?.candidates() ?? [], mintTicket: () => directTicketManager!.mint() },
      dshAuthCookieHeader,
      name,
      hooks,
      reporter,
    });
    void syncDirect(config);
  }

  /** 直连口同步（方案 B）：join 模式**始终监听**，门禁 = ticket；口令（accessCode）为可选增强层。 */
  async function syncDirect(config: RdshConfig): Promise<void> {
    // 整函数包 try：本函数由 `void syncDirect(...)` 触发，任何漏出的异常都会变成未捕获
    // rejection（宿主可能静默吞掉）→ 直连口永远起不来且毫无线索。
    try {
      // 注销进行中不启动/重启直连口（stopDirect 刚把它停掉）。
      if (revoking) return;
      // 转发凭据拿不到就不启动直连口（session 代换发失败 / 未识别的代际）。
      if ((await ensureAuthCookie()) === null) return;
      if (directSecret === null) directSecret = loadOrCreateDirectSecret();
      const code = config.gateway?.accessCode ?? null;
      const meter = reporter?.meter;
      // 重启直连口的两类理由：① 口令变化（即时生效/移除）；② meter 身份变化——典型是
      // 「先设口令起直连口（此时 reporter 为 null → meter 缺失）→ 后接 hub」，必须重启一次
      // 把进程级 meter 补挂上，否则该直连口流量会永久静默不上报。
      if (directHandle !== null && directAccessCode !== undefined && (directAccessCode !== code || directMeter !== meter)) {
        await stopDirect();
      }
      directTicketManager = createDirectTicketManager(directSecret);
      if (directHandle === null) {
        const started = await startDirectWithRetry({
          dshPort: ctx.webServer.port,
          dshAuthCookieHeader,
          secret: directSecret,
          accessCode: code,
          consumeTicket: (t) => directTicketManager!.consume(t),
          host: config.host,
          port: config.port,
          dshUiCompat: { trustPairedAsLoopback: config.dshUiCompat?.trustE2EEAsLoopback !== false },
          // 进程级 reporter 的 meter（见 apply() 顶部注释）：与隧道共用同一份，重连后依然有效。
          // 尚未接入过 hub 时为 undefined（无可上报目标），属预期。
          meter,
        });
        // 收尾可能恰在 startDirect 的异步 listen 期间到达：此时 teardown 的 stopDirect() 因
        // directHandle 仍为 null 已跳过，这里必须补停，否则 8442 监听口在收尾之后泄漏。
        if (disposed) {
          await started.stop().catch(() => undefined);
          return;
        }
        directHandle = started;
        directMeter = meter;
        directAccessCode = code;
      }
    } catch (err) {
      console.error(
        `rdsh: direct gateway sync failed on ${config.host ?? "0.0.0.0"}:${config.port ?? 8442} — ${err instanceof Error ? err.message : String(err)}`,
      );
      directHandle = null;
      directAccessCode = undefined;
    }
  }

  async function stopDirect(): Promise<void> {
    if (directHandle !== null) {
      await directHandle.stop().catch(() => undefined);
      directHandle = null;
    }
    directTicketManager = null;
    directAccessCode = undefined;
    directMeter = undefined;
  }

  /**
   * 启动时自动接入：host.json 已是 join 模式且有持久化 host token、隧道未被 CLI/他人持有 →
   * 复用 token 自动建隧道（与 CLI `rdsh serve` 行为一致，消除「需先点接入才有隧道」的鸡生蛋）。
   * 任一前置条件不满足则静默跳过，面板保持 disconnected，由用户手动接入。
   */
  async function autoConnect(): Promise<void> {
    try {
      if (revoking || starting) return;
      if (handle !== null) return;
      // 活锁不接入：他人（CLI / 另一进程）由 state() 显示为 external。
      // 例外是 pid-reuse 残锁（锁里的 pid 被别的进程复用、isAlive 为真）：先 reap 再接入。
      // 窄闸门（reasonFilter 只放行 pid-reuse）保证不误删 alive 活锁。
      const held = readJoinLock();
      if (held !== null) {
        const res = await forceUnlockJoinLock(undefined, { reasonFilter: ["pid-reuse"] });
        if (!res.removed) return;                    // 非 pid-reuse 活锁 / CAS 失败 → 放弃本轮
      }
      const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
      if (config.mode !== "join" || typeof config.hub !== "string" || config.hub === "") return;
      if (readPersistedToken(config.hub) === null) return;
      // 启动段与注销互斥（autoConnect 也在事件循环里与用户点击并发）。
      if (revoking || starting) return;
      starting = true;
      try {
        // 凭据拿不到就不建隧道（session 代换发失败 / 未识别的代际）；lastMessage 已由对应路径写好。
        if ((await ensureAuthCookie()) === null) return;
        const { token: hostToken, insecure, name: joinedName } = await registerJoin({
          hubUrl: config.hub,
          name: config.name,
        });
        startTunnel(config, config.hub, hostToken, joinedName, insecure);
      } finally {
        starting = false;
      }
    } catch (e) {
      // 自动接入失败不阻塞面板；用户可手动接入重试。
      // 例外：锁被占用（同机另一实例在跑隧道）必须让用户看见原因 —— 否则表现为
      // 「面板一直 disconnected」，与修复前的「状态反复掉线/连线」一样无法自查。
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("join lock") || msg.includes("another tunnel is already running")) lastMessage = msg;
    }
  }

  async function disconnect(): Promise<RpcResult> {
    if (handle !== null) {
      await handle.stop();
      handle = null;
      liveState = null;
    }
    // 只停隧道，**不停直连口**：join 模式下直连口始终监听（见 gateway/direct.ts 设计），
    // 停掉它会让同网段的 APP 退化成走公网隧道、且断开期间完全不可用。
    return ok({ status: "disconnected", hub: currentHub, name: currentName });
  }

  async function revoke(): Promise<RpcResult> {
    if (revoking) return err("revoking", "revoke already in progress");
    // 先同步置位：后到的 revoke/connect/scanState/beginScan 立即被拒，state() 立刻返回 revoking，
    // 与客户端乐观态对齐，也杜绝「两个并发 revoke 都通过入口检查」的双重注销。
    revoking = true;
    let teardownStarted = false;
    try {
      // 放弃未完成的扫码会话，避免注销后下一轮 scan-state 又把它消费成隧道。
      bindSession = null;
      // 有界等待在途接入收尾（≤5s）：期间在途 connect/scanState/autoConnect 的 startTunnel 允许完成
      // （startTunnel 只判 disposed），完成后由本次注销立即拆掉；其写入的 token 由 clearToken 清理。
      for (let waited = 0; starting && waited < 5_000; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (starting) return err("busy", "a join is still in progress; retry shortly");
      const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
      const hub = config.mode === "join" ? config.hub : undefined;
      const token = hub !== undefined ? readPersistedToken(hub) : null;
      /**
       * 本地注销优先：stop 失败不阻断写 lan / 清 token；hub 侧有界等待。
       * 注销期间 state 返回 revoking、connect/scanState/syncDirect 全部拒绝，
       * 因此不会出现「面板已断开但还能复用旧 token 直连」的窗口。
       */
      teardownStarted = true;
      const outcome = await performRevoke({
        stopTunnel: async () => {
          if (handle !== null) await handle.stop({ flushTimeoutMs: TEARDOWN_FLUSH_BUDGET_MS });
        },
        stopDirect,
        saveLan: async () => {
          // 先落盘置为 lan（关键）：即便后续失败，也绝不留下「join 模式 + 无 token」的死态
          //（否则重启后 autoConnect 因无 token 静默跳过、面板永远 disconnected，只能人工重接）。
          const fresh = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
          fresh.mode = "lan";
          fresh.hub = undefined;
          fresh.name = undefined;
          fresh.insecure = undefined;
          await saveConfig(DEFAULT_HOST_CONFIG_PATH, fresh);
        },
        clearToken: () => {
          if (hub !== undefined) clearPersistedToken(hub);
        },
        selfRevoke: async () => {
          if (hub !== undefined && token !== null) await selfRevoke(hub, token, config.insecure === true);
        },
        hubTimeoutMs: REVOKE_HUB_TIMEOUT_MS,
      });
      currentHub = undefined;
      currentName = undefined;
      lastMessage = outcome.teardownError !== undefined
        ? `隧道关闭失败（本地已注销，请重启 DSH）：${outcome.teardownError}`
        : outcome.hubError !== undefined
          ? `本地已注销，但服务端吊销失败；若该主机仍出现在 App 列表，请手动移除或联系管理员：${outcome.hubError}`
          : undefined;
      return ok({ status: "unconfigured" });
    } catch (e) {
      return err("revoke-failed", e instanceof Error ? e.message : String(e));
    } finally {
      // 已进入 teardown 的话，即使后续步骤失败也不能留下可命中的 handle（否则 connect 幂等分支会谎报已连接）。
      if (teardownStarted) {
        handle = null;
        liveState = null;
      }
      revoking = false;
    }
  }

  async function state(): Promise<RpcResult> {
    try {
      const compat = uiCompatEnabled();
      // 只读诊断：每个分支都带上，面板据此显示/告警当前目录选择器形态
      const picker = pickerDiagnostics(ctx);
      // 面板页脚/信息行：插件身份（包名 + 版本）+ 内网直连口状态（未启动时 port 为 null）
      const meta = {
        pluginName: PLUGIN_META.name,
        pluginVersion: PLUGIN_META.version,
        direct: { active: directHandle !== null, port: directHandle?.actualPort ?? null },
      };
      if (revoking) {
        return ok({
          status: "revoking",
          uiCompat: compat,
          hasAccessCode: accessCodeEnabled(),
          ...picker,
          ...meta,
        });
      }
      if (handle !== null && liveState !== null) {
        return ok({
          status: mapState(liveState),
          hub: currentHub,
          name: currentName,
          message: lastMessage,
          hasToken: true,
          uiCompat: compat,
          hasAccessCode: accessCodeEnabled(),
          ...picker,
          ...meta,
        });
      }
      const held = readJoinLock();
      if (held !== null) {
        return ok({
          status: "external",
          lock: { role: held.role, pid: held.pid, sameProcess: held.pid === process.pid },
          message: lastMessage,
          uiCompat: compat,
          hasAccessCode: accessCodeEnabled(),
          ...picker,
          ...meta,
        });
      }
      const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
      const hasAccessCode = config.gateway?.accessCode != null;
      if (config.mode === "join" && config.hub !== undefined) {
        return ok({
          status: "disconnected",
          hub: config.hub,
          name: config.name,
          message: lastMessage,
          hasToken: readPersistedToken(config.hub) !== null,
          uiCompat: compat,
          hasAccessCode,
          ...picker,
          ...meta,
        });
      }
      return ok({ status: "unconfigured", message: lastMessage, uiCompat: compat, hasAccessCode, ...picker, ...meta });
    } catch (e) {
      return err("internal", e instanceof Error ? e.message : String(e));
    }
  }

  /** 读当前 dshUiCompat 开关（内存覆盖 > host.json；缺省 true）。 */
  function uiCompatEnabled(): boolean {
    if (liveCompat !== undefined) return liveCompat;
    return currentConfig?.dshUiCompat?.trustE2EEAsLoopback !== false;
  }

  /** 当前访问密码是否启用（运行中 live 优先；否则读最近 host.json；缺省 false）。 */
  function accessCodeEnabled(): boolean {
    if (liveAccessCode !== undefined) return liveAccessCode !== null;
    return currentConfig?.gateway?.accessCode != null;
  }

  async function setAccessCode(args: Record<string, unknown>): Promise<RpcResult> {
    try {
      // 注销期间禁止 load-modify-save host.json（会与 saveLan 的原子写并发）。
      if (revoking) return err("revoking", "revoke in progress");
      const raw = args.code;
      // null/undefined = 清除；否则必须是 ≥4 的非空字符串
      let code: string | null;
      if (raw === null || raw === undefined) {
        code = null;
      } else if (typeof raw === "string" && raw.length >= 4) {
        code = raw;
      } else {
        return err("bad-request", "code must be null or a string of at least 4 chars");
      }
      // ① 内存即时生效（运行中的隧道；缺省也写入供下次连接）
      liveAccessCode = code;
      handle?.setAccessCode(code);
      // ② 持久化 host.json
      const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
      config.gateway = { accessCode: code };
      await saveConfig(DEFAULT_HOST_CONFIG_PATH, config);
      currentConfig = config;
      // ③ 直连口随口令开关同步（R14：清除口令 → 关直连口）
      await syncDirect(config);
      return ok({ hasAccessCode: code !== null });
    } catch (e) {
      return err("internal", e instanceof Error ? e.message : String(e));
    }
  }

  async function setUiCompat(args: Record<string, unknown>): Promise<RpcResult> {
    try {
      // 注销期间禁止 load-modify-save host.json（会与 saveLan 的原子写并发）。
      if (revoking) return err("revoking", "revoke in progress");
      if (typeof args.enabled !== "boolean") return err("bad-request", "enabled (boolean) required");
      // ① 内存即时生效（运行中的隧道；缺省也写入供下次连接）
      liveCompat = args.enabled;
      handle?.setUiCompat(args.enabled);
      // ② 持久化 host.json
      const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
      config.dshUiCompat = { trustE2EEAsLoopback: args.enabled };
      await saveConfig(DEFAULT_HOST_CONFIG_PATH, config);
      currentConfig = config;
      return ok({ enabled: args.enabled });
    } catch (e) {
      return err("internal", e instanceof Error ? e.message : String(e));
    }
  }

  /** 诊断（只读）：锁详情 + 持有者来源 + 本机其它安装 + 建议动作（不碰锁、不杀进程）。 */
  async function diagnose(): Promise<RpcResult> {
    try {
      const report = await describeJoinLockAt();
      const installs = scanPluginInstalls(PLUGIN_DIR);
      const holder =
        report.pid !== undefined
          ? { pid: report.pid, role: report.role, kind: classifyHolder(report.command), command: report.command }
          : null;
      // 同 pid = 本进程内另一个插件实例（宿主重复 apply）：卸载别的 profile 帮不上忙，别给误导建议。
      const sameProcess = report.pid !== undefined && report.pid === process.pid;
      const uninstallCommands = sameProcess ? [] : installs.filter((i) => !i.self).map((i) => uninstallCommand(i.profile, i.pkg));
      return ok({
        lock: report,
        sameProcess,
        holder,
        installs,
        self: { dir: PLUGIN_DIR, version: PLUGIN_META.version },
        actions: {
          forceUnlock: report.unlock,
          unlockReason: report.reason,
          unlockHint: report.hint,
          uninstallCommands,
        },
      });
    } catch (e) {
      return err("diagnose-failed", e instanceof Error ? e.message : String(e));
    }
  }

  /** 强制解锁：受闸门（forceUnlockJoinLock）；成功后清 message 并返回新 state。 */
  async function forceUnlock(): Promise<RpcResult> {
    try {
      const res = await forceUnlockJoinLock();
      if (!res.removed) {
        return err("unlock-blocked", res.report.hint, { lock: res.report });
      }
      lastMessage = undefined;
      return await state();
    } catch (e) {
      return err("unlock-failed", e instanceof Error ? e.message : String(e));
    }
  }

  /** Business dispatch of the browser half's channel; the envelope is handled by `handleRpcRoute`. */
  const dispatch: RpcDispatch = async (endpoint, payload) => {
    const args = payload.args ?? {};
    switch (endpoint) {
      case "connect":
        return await connect(args);
      case "disconnect":
        return await disconnect();
      case "revoke":
        return await revoke();
      case "state":
        return await state();
      case "set-ui-compat":
        return await setUiCompat(args);
      case "set-access-code":
        return await setAccessCode(args);
      case "begin-scan":
        return await beginScan(args);
      case "scan-state":
        return await scanState();
      case "diagnose":
        return await diagnose();
      case "force-unlock":
        return await forceUnlock();
      default:
        return err("bad-request", `unknown endpoint ${endpoint}`);
    }
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: RPC_CHANNEL,
        // master 代由 WebServer 按 required 准入（provider 已在上面注册）；
        // 0.2.2-rc.x 的 WebServer 忽略该字段，准入由下面的 handler 自己完成。
        auth: "required",
        // Return the promise: WebServer awaits it and contains a throwing handler
        // (400 + warning). A discarded rejection becomes an unhandled rejection,
        // which DSH reports as a fatal load failure and exits.
        handler: (req, res) => {
          if (generation === "session") {
            // 旧代：路由 `auth` 不生效，用 DSH 官方围栏 + 浏览器会话校验做准入。
            const rejection = ctx.connection.requestRejection!({ headers: req.headers });
            if (rejection !== undefined) {
              res.writeHead(rejection, { "content-type": "text/plain" });
              res.end(rejection === 401 ? "unauthorized" : "forbidden");
              return;
            }
          } else if (generation === "unsupported") {
            // 未识别的代际：只放行本机（loopback）对只读 state 的访问，面板据此显示原因；
            // 其余端点/来源一律 503。该态没有隧道凭据，远端本就不可达。
            const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
            const remote = req.socket.remoteAddress;
            const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
            if (pathname !== `${RPC_CHANNEL}/state` || !loopback) {
              res.writeHead(503, { "content-type": "text/plain" });
              res.end("authentication unavailable");
              return;
            }
          }
          return handleRpcRoute(req, res, dispatch);
        },
      }),
    `dsh-whale-link: ${RPC_CHANNEL} RPC route`,
  );

  // 启动自动接入（静默；CLI 托管时跳过，见 autoConnect 前置条件）
  void autoConnect();

  ctx.effect(() => async () => {
    // 同步置 disposed：立即阻止 autoConnect/syncDirect 再建隧道/直连口。
    disposed = true;
    // 顺序 = CLI join()（direct → handle → dsh）：先关直连口（含直连尾账），
    // 再 handle.stop() 做末次 flush，最后 reporter.stop() 清定时器（其内部 flush 与 handle.stop 幂等）。
    await stopDirect();
    if (handle !== null) await handle.stop({ flushTimeoutMs: TEARDOWN_FLUSH_BUDGET_MS }).catch(() => undefined);
    if (reporter !== null) await reporter.stop(TEARDOWN_FLUSH_BUDGET_MS).catch(() => undefined);
    // 收尾完成后再复位单例：新实例此时才允许接管（也便于测试证明「dispose 被 await」）。
    applied = false;
  }, "dsh-whale-link: teardown");

  // 单例标志在注册全部完成后再置位：若上面 ctx.effect 同步抛错，applied 仍为 false，
  // 后续重 apply 还能重来，不会永久卡死（P2-3）。
  applied = true;
}
