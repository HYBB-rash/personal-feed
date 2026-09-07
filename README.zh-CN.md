# Personal Feed

Personal Feed 是一个独立、单用户、与消息通道无关的 MCP 服务。它观察已打开且已登录的 X 页面，在自己的状态目录中维护偏好、反馈和收藏，并向任何具有通用 MCP Client 的 Agent 提供五个工具。

```text
Telegram / Web -> Agent -> 通用 MCP Client -> 127.0.0.1 Personal Feed 服务
```

这个仓库是唯一源码事实源，使用 MIT 许可证。`package.json` 保持 `private: true`，不发布 npm 包。

## 运行边界

- 首版只监听 `127.0.0.1:43180`。
- `POST /mcp` 是无状态 Streamable HTTP MCP，必须携带 Bearer token。
- `GET /healthz` 只证明进程活着。
- `GET /readyz` 只检查配置已加载、状态目录可写、Python observer 资产可读；不访问 X 或模型网络。
- 现有 X 浏览器需在 `127.0.0.1:9222` 提供 CDP。Personal Feed 不启动浏览器、不管理账号、不对外暴露 CDP。
- 默认状态目录是 `${XDG_STATE_HOME:-$HOME/.local/state}/personal-feed`。
- MCP token 和模型 API key 是两份独立凭据，不进 Git、URL 和日志。

五个原始工具名固定为 `request`、`observe_context`、`process_feedback`、`record_feedback` 和 `list_saved`。Client 使用 `serverName: personal_feed` 时，Agent 看到的名称是 `mcp__personal_feed__<原始名>`。

精确输入、封闭结果类别和错误边界见 [`docs/MCP.md`](docs/MCP.md)。

## 开发与验证

```sh
nix develop
pnpm install --frozen-lockfile
pnpm check
nix flake check
```

固定的 Nix 环境提供 Node.js、pnpm、Python 和 `websocket-client`。测试只使用 fake browser/model 和临时目录，不得连接真实账号、模型凭据、DSH home 或 user systemd。

## 安装独立服务

先在当前 shell 中提供凭据：

```sh
export PERSONAL_FEED_MCP_TOKEN='<高熵服务 token>'
export PERSONAL_FEED_MODEL_BASE_URL='https://model.example/v1'
export PERSONAL_FEED_MODEL='model-name'
export PERSONAL_FEED_MODEL_API_KEY='<独立模型 key>'
export PERSONAL_FEED_MODEL_TIMEOUT_MS='30000' # 可选
```

可选 `PERSONAL_FEED_MODEL_RESPONSE_FORMAT=strict_tool` 要求模型端点支持严格 Function JSON Schema；默认 `json_content` 保持原来的 JSON 文本接入。严格模式要求唯一的固定返回函数，仅取其数据并继续原有校验；不执行模型工具、不自动重试或退回自由文本，不更改模型的思考设置。安装器会保留这个显式选择。DeepSeek 的严格模式当前使用 [Beta 端点](https://api-docs.deepseek.com/guides/tool_calls/#strict-mode-beta)，应显式把 base URL 配为 `https://api.deepseek.com/beta`；服务不自动改写供应商地址。结构正确不代表语义判断一定正确。

在干净且明确的 Git commit 上先检查：

```sh
nix run . -- service install --check
```

另行授权安装和启动 user service 后才执行：

```sh
nix run . -- service install --apply
```

`--apply` 从该 commit 构建 Nix 运行物，安装一个 user systemd unit、权限为 `0600` 的独立配置和状态目录，然后启动 PF。它不配置或重启 DSH。

## Agent 接入

服务运行后，在所用 Agent 的通用 MCP Client 中配置：

| 配置 | 值 |
|---|---|
| 传输 | Streamable HTTP |
| MCP 端点 | `http://127.0.0.1:43180/mcp` |
| 请求头 | `Authorization: Bearer <服务 MCP token>` |
| Server name | `personal_feed` |

将本仓的 [`skills/personal-feed`](skills/personal-feed/SKILL.md) 通过 Agent 自己的 Skill 安装方式加载。用户随后从正常对话请求 Personal Feed，由 Agent 调用工具。配置字段名和凭据存储方式由具体 Client 决定；工具超时应覆盖服务的 `PERSONAL_FEED_TOOL_TIMEOUT_MS`。

Personal Feed 只安装自身服务。原来的 `dsh install` 和 `dsh rollback` 命令已移除；宿主的 MCP 配置与 Skill 安装由宿主管理。已安装的接入不会因源码删减而卸载；如需撤销旧安装器的机器态改动，使用产生该备份的旧版本。

服务安装可重复执行，改动时会打印备份路径和回滚命令：

```sh
nix run . -- service rollback --apply '<backup-directory>'
```

服务回滚撤销 unit 和配置，保留独立状态目录。

## 日志

工具调用日志包含操作名、服务生成的匿名请求 ID、结果类别和耗时。模型调用失败另记 `model_failure`，只记录固定错误分类、可选的固定结构位置及必要的 HTTP 状态码。应用校验用 `application_failure` 区分变更无效、缺少追问、充分性无效、冲突、取消及关联失效。日志不包含用户原文、模型返回正文、X 正文、完整 URL、continuation token 或凭据。诊断不改变工具结果，也不触发重试。
