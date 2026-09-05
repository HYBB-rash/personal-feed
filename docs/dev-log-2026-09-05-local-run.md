# 开发日志：本地运行与服务配置修复

- 日期：2026-09-05
- 范围：Personal Feed 本地 MCP 服务、systemd 安装器

## 目标

使用 DSH 已配置的模型在本机启动独立服务，验证真实 MCP 调用，明确浏览器和个人语境的运行条件。

## 时间线

- 13:39：确认本地源码与 origin/main 的文件树一致；类型检查、58 项 TypeScript 测试、28 项 Python 测试、构建和 Nix 检查通过。
- 13:40：临时启动真实 CLI，使用 MCP SDK 验证鉴权、工具发现、收藏及取消收藏，随后停止临时服务并删除隔离数据。
- 13:41：发现没有模型环境变量或已有服务配置，CDP 9222 也不可达。用户指示复用 dsh-plugins 模型配置；仅提取默认模型与对应密钥，不输出秘密。
- 13:42：安装器 check 通过，apply 安装用户服务后反复退出，错误为模型 base URL 缺失。停止本次服务。
- 13:43：systemd-analyze 明确报告 EnvironmentFile 路径不是绝对路径，原因是外围双引号被作为路径内容。原测试反而要求该错误格式。创建基于 origin/main 的独立分支，修改测试为绝对路径与目标路径检查，见证失败后修复。

## 逻辑链条

源码 CLI 能运行不代表 Nix 包经 systemd 启动成功。配置文件内容完整，实际 unit 解析器忽略 EnvironmentFile，故修复安装器输出；不通过全局环境变量绕过问题。EnvironmentFile 接收完整单一路径，不能沿用 ReadWritePaths 的列表值引号编码；保留后者行为，并转义 EnvironmentFile 中的百分号 specifier。

## 改动

- src/install/service.ts：单独编码 EnvironmentFile 路径，去掉外围引号。
- tests/install/service-install.spec.ts：要求 EnvironmentFile 是实际绝对目标路径，替换原有错误断言。

## 验证

- 修复前定向测试：1 项失败，明确发生于绝对路径断言。
- 后续构建与本机复验结果在完成后补记。

## 遗留

真实 X Feed 尚未跑通；本机 CDP 9222 不可达，新独立状态也未录入用户长期兴趣和已有认识。没有配置 DSH MCP 接入或改动 DSH 服务。

## 修复后复验

- 13:44：定向安装器测试 7 项通过；完整类型检查、58 项 TypeScript 测试、28 项 Python 测试和构建通过。构建仍存在原有 tsdown/rolldown `define` 选项警告，不影响本次产物启动。
- 13:45：提交修复 294f7b8，以安装器从该精确提交重新构建并安装。systemd 正确识别 EnvironmentFiles，服务 active/running，NRestarts=0；systemd-analyze 不再报告 Personal Feed 路径错误（另有无关既存 timer 文件名警告）。
- 13:45：真实服务 healthz/readyz 均为 200，MCP 客户端发现全部五个工具，list_saved 正常返回空集合。使用用户本轮原文调用 observe_context，DeepSeek 返回 ignored（约 1.6 秒）；request 返回 incomplete/personal_context（约 0.8 秒）。未伪造用户偏好以绕过语境条件，也未将该结果视为业务空集。
- MCP 地址为 http://127.0.0.1:43180/mcp；独立配置位于 ~/.config/personal-feed/service.env（0600），状态位于 ~/.local/state/personal-feed。使用 deepseek-v4-flash；密钥不记录到日志或 Git。
- 本次创建服务前的备份：~/.config/personal-feed/backups/service-2026-09-05T05-42-23-117Z-180cc7c2-8177-46fa-9c3e-42c8cb663b33。通过 service rollback --apply 指定该目录可撤销本次安装，状态数据按安装器合同保留。
- 用户尚待确认已登录 X 浏览器所在主机；127.0.0.1:9222 不可达，真实 Feed 推荐未完成。修复仅本地提交和安装，未推送或合并。
