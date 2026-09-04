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

在干净且明确的 Git commit 上先检查：

```sh
nix run . -- service install --check
```

另行授权安装和启动 user service 后才执行：

```sh
nix run . -- service install --apply
```

`--apply` 从该 commit 构建 Nix 运行物，安装一个 user systemd unit、权限为 `0600` 的独立配置和状态目录，然后启动 PF。它不配置或重启 DSH。

## 可选 DSH 接入

PF 已运行后，配置端点和同一份 MCP token：

```sh
export PERSONAL_FEED_MCP_URL='http://127.0.0.1:43180/mcp'
export PERSONAL_FEED_MCP_TOKEN='<高熵服务 token>'
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
nix run . -- dsh install --check
```

另行授权机器态接入后才执行：

```sh
nix run . -- dsh install --apply
```

DSH 安装器会先确认 `readyz.status=ready` 和精确五个工具，再原子安装本仓的 instruction-only Skill、一条有归属标记的通用 `@deepseek-ai/dsh-mcp-client` 配置，以及权限为 `0600` 的 URL/token 环境文件。配置固定 `serverName: personal_feed`、`failOnStartupError: false` 和 120 秒工具超时。遇到用户自己的同名配置或 Skill 会拒绝覆盖。它不重启、发布或切换 DSH。

两个安装器都可重复执行。真正改动时会生成备份并打印明确回滚命令：

```sh
nix run . -- service rollback --apply '<backup-directory>'
nix run . -- dsh rollback --apply '<backup-directory>'
```

服务回滚只撤销 unit 和配置，不删除独立状态目录；试运行期间产生的数据会保留，是否迁移或删除另行决定。

DSH 重启、生产切换、真实 Web/Telegram 验收、`accept`、创建公开仓库、merge 和 push 都是分开的操作决定。

## 日志

服务日志只包含操作名、服务生成的匿名请求 ID、结果类别和耗时，不包含用户原文、X 正文、完整 URL、continuation token 或凭据。
