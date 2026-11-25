# DSH 兼容性

每个 `dsh-whale-link` 版本要求哪个 DSH，以及它实际在哪些 DSH 上激活并跑通 `/remote-access`。

| 插件 | DSH 要求 | 实测通过 | 说明 |
|---|---|---|---|
| `0.17.x` | `>=0.2.2-rc.2`（`engines.dsh`） | `0.2.2-rc.5`、`0.2.3-alpha.2` | 双代认证：`0.2.2-rc.x` 用启动令牌换发会话 cookie 并自行准入路由；`0.2.3+` 注册 `connection.authentication` provider，路由准入交给 WebServer 的 `auth: 'required'`。`0.17.2` 修复注销可靠性；认证路径未变。 |
| `0.17.0` | `>=0.2.2-rc.2`（`engines.dsh`） | —（发布线上不激活） | 只用 provider API。在 `0.2.2-rc.2`～`rc.5` 上插件停在 `pending`；请升级到 `0.17.1`。 |
| `0.16.x` | 未声明 | `0.1.2-rc.1`、`0.1.5-rc.2`、`0.1.7-rc.1`、`0.2.2-rc.1` | 没有 `engines.dsh`，没有任何环节会拦住它；在 `0.2.2-rc.2` 及以后启动即让 DSH 退出。这些版本请用 `0.17.x`。 |

暴露 `connection.authentication`、但 WebServer 仍不处理路由 `auth` 的「过渡混合」构建不在承诺范围内（provider 代假设 WebServer 会执行 `auth: 'required'`）；目前未观测到这种构建。

`0.2.2-rc.5` 同时用 CLI 临时 profile 与已安装的桌面版验证：插件激活、`/remote-access` 有应答、内网直连口正常监听。

## 要求在哪里执行

`package.json` 的 `engines.dsh` 是机器可读的下限。DSH 的**插件管理器**（「插件」页面）会拿它和当前 DSH 版本比较，不兼容就拒绝安装或激活。**profile 启动本身不检查**。

`dsh plugin` 命令只是把参数转发给 pnpm，**不做**兼容性检查。在旧 DSH 上它会照装 `0.17.x`（插件随后停在未激活），在新 DSH 上它会照装 `0.16.x`（启动崩溃）。命令行安装时请自己锁版本。

「实测通过」不受任何机制约束，只记录**插件被激活且 `/remote-access` 有应答**的版本——仅启动 DSH 不算，`0.17.0` 的 `pending` 正是这样漏过去的。不在这一列里的版本是**未实测**，不是"已确认不兼容"。

## 为旧 DSH 安装对应版本

```bash
dsh plugin --profile <name> add dsh-whale-link@0.16.0
```

在**插件**页面里则从版本列表中选择同一版本。安装或切换版本后都要重启 DSH。

## 维护规则

- 只有新版本在旧 DSH 上**真的不能工作**（依赖的 DSH API 被删除或改名）才抬高 `engines.dsh`；"没在那边测过"不是理由。
- 改动 `engines.dsh` 的同一次提交里更新本版本的表格行。`test/compatibility-doc.test.ts` 会在缺少当前 `<major>.<minor>.x` 行、或该行没有写出准确的 `engines.dsh` 范围时失败。
- 「实测通过」只写插件真正被激活、`/remote-access` 有应答的版本，不写推断的兼容性，也不把「仅启动成功」算进去。
- `0.2.2-rc.2` 之所以是下限，是因为发布线从该版本起就带有本插件需要的认证 API；表格里实测列从 `0.2.2-rc.5` 开始。

## 旧包名

`dsh-web-remote`（本插件此前的包名，最后版本 `0.15.0`）已停止维护，其兼容历史不在本文件里。装 `dsh-whale-link` 前必须把它从同一 profile 卸载——两者都会固定 DSH 的目录选择器，重复的行会让 DSH 无法启动。
