# WhaleLink（鲸语通）DSH 插件

**安全地远程访问你的 DSH 智能体——用任意浏览器或「鲸语通」App。不需要公网 IP，不做端口转发，全程端到端加密。**

`dsh-whale-link` 是 **DeepSeek Harness（DSH）** 的插件。装好后，DSH 的**设置**里会多出一个 **WhaleLink** 面板：把本机接入一个 hub（鲸语通托管服务，或你自己部署的 hub），这台机器上跑的 DSH 就能从任何地方访问。

**其他语言**：[English](README.md)

---

## 状态

预发布（`0.x`）。`0.16.0` 是第一个独立发布版，功能与 `dsh-web-remote` `0.15.0` 等价。

> npm 上的 `dsh-whale-link` 目前还是一个**占位包**（故意抛错）。在 `0.16.0` 发布之前，请从本地检出安装——见[开发](#开发)。

## 功能

- **在面板里完成，不用命令行。** 接入、断开、注销、状态，都在 **设置 → WhaleLink**。
- **两种接入方式。** 粘贴 hub 门户一次性授权令牌，或用「鲸语通」App 扫码。
- **同网络优先直连。** 接入后插件在本机监听一个专用端口（默认 `8442`）直连服务同网段客户端——延迟更低、速度更快；不在同一网络的客户端自动回落到云端中转。
- **暂停不丢绑定。**「断开」只停隧道、保留令牌；「注销」清掉本地绑定并在 hub 侧吊销这台主机。
- **可选访问口令。** 只有你知道的一层锁：任何人（包括服务提供方）要进入这台主机都得先输对口令。随时开启/关闭。
- **诊断与修复。** 能看到是谁占着隧道、本机还装了哪些份插件，以及清掉残留锁。
- **远程也能选目录。** 插件把 DSH 的目录选择器固定为**浏览器内**形态——远端浏览器永远够不到宿主屏幕上的原生系统对话框。

## 环境要求

| | |
|---|---|
| DSH | 桌面版，或 `dsh web`；且该 DSH 构建需支持插件 bundle、`webServer` 前缀路由与 `connection.authenticatedUrl`（DSH 0.1.2+） |
| Hub | 鲸语通托管服务（面板已预填 `https://rdsh.cn`），或[自建 hub](https://github.com/floatinghotpot/remote-dsh) |
| `pnpm` | 仅当通过 DSH 的**插件**界面安装时需要 |

## 安装

- **DSH App**：**插件** → 安装第三方插件 → 输入 `dsh-whale-link`。
- **命令行**：`dsh plugin --profile <name> add dsh-whale-link`（该 profile 首次使用时自动初始化）。

安装或升级后请**重启 DSH**：目录选择器是 boot 期挂载的，运行中的热补丁替换不了它，固定的形态要下一次启动才生效。

## 使用

### 1. 接入本机

1. 在 hub 上「添加主机」，复制页面给出的 **Hub 地址**与**授权令牌**（只显示一次）。
2. 打开 **设置 → WhaleLink**。服务器地址已预填，只有自建 hub 才需要改。
3. 粘贴**授权令牌**，可填**主机名称**，点「**接入**」。

想用手机接入：点「**扫码接入**」，用「鲸语通」App 的主机列表 →「扫码添加」扫下方二维码。

两种方式二选一：填令牌，或扫码。接入成功后令牌会存在本机，以后再接入不必重新粘贴。

### 2. 从任何地方访问它

- **浏览器**：打开 hub 地址，登录，在主机列表里点这台主机。
- **「鲸语通」App**：登录后，在主机列表里点这台主机。

### 3. 日常操作

| 操作 | 效果 |
|---|---|
| **断开** | 停隧道，配置与授权保留；点「接入」即可恢复。（主机仍处于 join 模式时，内网直连口继续服务本网段。） |
| **注销** | 停隧道、删除本地绑定与令牌，并请求 hub 吊销这台主机；面板回到「未接入」。 |
| 掉线 | 隧道自动重连，无需操作。 |

### 面板状态

| 状态 | 含义 |
|---|---|
| 未接入 | 从未接入，或已注销 |
| 连接中…／断线重连… | 正在建立隧道，或掉线后自动恢复 |
| 已连接 | 此刻可从外网访问 |
| 未接入（已断开，配置保留） | 曾接入过，当前暂停 |
| 已接入（由本机其它实例托管） | 本机的 `rdsh` CLI 或另一个 DSH 在用隧道，面板只读 |

## 数据存在哪

全部在 `~/.rdsh/` 下（host 配置路径可用 `RDSH_CONFIG` 覆盖）：

| 路径 | 内容 |
|---|---|
| `host.json` | 主机配置（`mode`、`hub`、`name`、访问口令、兼容开关） |
| `join-<host>[-<port>].token` | 持久化的 host 令牌（`0600`） |
| `e2ee-key.json` | 主机端端到端加密密钥对（`0600`） |
| `direct-secret` | 内网直连票据的 per-host 密钥（`0600`） |
| `join.lock` | 当前哪个进程在跑隧道（`0600`） |
| `device-id` | 稳定的设备标识（`0600`） |
| `rdsh-meta.json` | 上报的设备类型与组件版本 |

删掉这些文件等同于“从未接入”，但推荐用「注销」——它还会在 hub 侧吊销主机。

## 工作原理

- **服务端半**跑在 DSH web 进程内（Cordis 函数插件）。它通过 [`rdsh-gateway`](https://www.npmjs.com/package/rdsh-gateway) 向 hub 建立**出站**隧道，并把流量转发给本机 DSH（`127.0.0.1:<webServer.port>`）。不在公网开任何入站端口。
- **内网直连**在接入期间额外监听一个本机端口（默认 `8442`），由 per-host 密钥签名的**一次性票据**把守；访问口令是可选的额外一层。
- **浏览器半**是手写的 `window.__ModuleLoader__` 模块，注册 **设置 → WhaleLink** 分区，并通过插件自己的 `/remote-access` RPC 路由与服务端半通信。
- **端到端加密**由隧道承载：中继只转发密文，读不到会话内容与文件。

## ⚠️ 不要和 `dsh-web-remote` 装在一起

本包与 [`dsh-web-remote`](https://www.npmjs.com/package/dsh-web-remote) 是**同一个插件的两个名字**（见 [NOTICE](NOTICE)）。把两者装进同一个 DSH profile 会让 DSH 起不来：

- 两份 patch 都会禁用 `directory-picker` 并插入 `directory-picker-browse` 行，loader 会判定 `duplicate loader entry id`（`directoryPicker` 服务重复）——**DSH 无法启动**；
- 两者暴露同一个 `/remote-access` RPC 路由，并争抢同一把机器级 `~/.rdsh/join.lock`。

每个 profile 只能选**一个**。想在保留另一个的情况下试本包，就给它单独一个 profile：

```bash
dsh plugin --profile whale-link add dsh-whale-link   # 首次使用时初始化
dsh whale-link                                        # 启动该 profile
```

## 安全说明

- **只有你的账号进得来。** 接入不是“开门”：一台主机只对它所属的账号（以及你显式共享的人）可达。
- **传输端到端加密。** 中继只看到连接元数据，看不到你的对话与文件。
- **本机还有你的一把锁。** 可选访问口令在本机校验，连 hub 运营方也绕不过去。
- **注销即清空。**「注销」删除本地绑定与令牌，并在 hub 侧吊销主机。
- 插件不开公网入站端口；隧道只在接入期间运行，内网直连口在主机保持 join 模式期间继续服务本网段（受票据把守，设了口令时还要过口令）。

## 开发

需要 **Node.js ≥ 22** 与 **pnpm ≥ 9**。

```bash
pnpm install
pnpm build     # tsc（strict）
pnpm test      # node --test
```

| 路径 | 内容 |
|---|---|
| `src/index.ts` | 服务端半：隧道生命周期、直连口、RPC 分发 |
| `src/rpc-route.ts` | `/remote-access` 前缀路由与其信封 |
| `src/lock-diagnostics.ts` | 锁持有者分类、本机安装扫描 |
| `client.js` | 浏览器半：设置分区 |
| `cordis.patch.yml` | Bundle patch：挂载插件行并固定目录选择器 |
| `locale/` | DSH 插件页面的 `meta.title` / `meta.description` |
| `icon.svg` | 插件图标 |

运行时依赖：`rdsh-gateway`（`^0.18.0`）——主机侧隧道实现，由 [remote-dsh](https://github.com/floatinghotpot/remote-dsh) 发布。

## 许可

代码以 **MIT** 许可发布——见 [LICENSE](LICENSE)。**WhaleLink / 鲸语通**名称与 logo 属品牌资产，**不在** MIT 授权范围内——见 [NOTICE](NOTICE)。
