# Personal Feed 原生表单实现与首轮验收准备

记录时间：2026-09-07，主机 herman。状态：实现和受控测试完成；Codex 已连接候选服务；用户表单亲验待进行。

## 本轮实现

固定 HTTP 头区分后台与交互，省略为后台。后台 request 只读已存事实并评估充分性，不将任务文字写入事实、不发问或等待。交互在一次工具调用内收取表单原文，明确部分先保存，只问必要问题；满足条件后原推荐执行一次。普通更新和反馈不生成推荐。

移除公开 continuationToken、待回答表及嵌套 feed，更新仓库 MCP 合同和 Skill。五个工具名称及顶层类别保持，交互结束原因受控；无效表单答案是输入错误。默认整次期限 300 秒，表单使用剩余时间，验收客户端为 360 秒。

MCP 标准连接只在 HTTP 接入内存路由；DELETE 与服务停止释放等待。失联客户端若不发送 DELETE，当前调用按期限结束；不增加 TTL、持久问答或恢复。客户端自动拒绝不归因于用户。

## 可复核证据

- 领域核心最初 3 项用例先失败后实现；传输首批 6 项真实 SDK HTTP 用例先失败后实现。默认期限断言由 120000 与 300000 不符的失败变为通过。
- 最终复核补充纯空白、缺 answer、过长答案 3 项真实 application + HTTP 用例，先失败，再修正领域吞错与接入错误映射，通过。
- 最终 pinned `nix develop --command pnpm check`：24 个 TypeScript 测试文件、307 项测试通过；33 项 Python 测试通过；类型检查与构建通过，退出 0。最终运行约 10:59–11:00。
- 构建仍有已有 tsdown `define` 配置告警，未阻止产物生成。本轮没有把告警当成新功能失败，也没有扩展修复范围。
- `git diff --check` 通过。原独立审计者有限复核四项责任 PASS；指出的无效表单分类问题已按上述 RED/GREEN 修正。
- 自动用例覆盖后台不写、连续原文问答、局部提交、一次推荐、队列外等待、交错答复、重复协议答复、取消、期限、DELETE、服务关闭、无表单能力、拒绝与模型/来源失败。它们均是隔离技术证据，不冒充真实用户验收。

当前接口：[MCP 合同](/home/herman/Projects/personal-feed/docs/MCP.md)。核心用例：[业务](/home/herman/Projects/personal-feed/tests/native-interaction.spec.ts)、[真实 SDK 与 HTTP](/home/herman/Projects/personal-feed/tests/service/elicitation.spec.ts)、[多轮局部事实](/home/herman/Projects/personal-feed/tests/clarification.spec.ts)。

## 独立候选运行环境

- 候选 PID：3530680；端口：127.0.0.1:43181。
- 构建：/home/herman/.local/share/personal-feed-dev/builds/native-form-20260907T110040。
- 产物目录 SHA-256（按路径和内容顺序聚合，排除 node_modules）：043bb93c350fdd0a6ff7d49ea29fa17ede14267a4abd65b263bd17d936f0c118。
- 14 份 JavaScript source map 内嵌 TypeScript 与本轮工作区源码逐项一致。
- 独立初始状态：/home/herman/.local/state/personal-feed-acceptance/native-form-20260907T110040。连接验证后仅有安全 service.log，没有写入用户事实。
- 复用已运行旧验收进程的模型配置，模型 deepseek-v4-flash / strict_tool；凭证不进入报告。新进程通过 pinned 环境启动，使用既有 9222 浏览器；没有启动浏览器或变更账户。
- healthz/readyz 均 200。它们不证明模型调用或 X 业务成功。
- 旧 43180 进程 3451873 保持运行，未重启或切换旧状态。没有执行安装、systemd 变更、提交、推送、DSH 或 Telegram 操作。

## Codex 任务验证

验收任务：Personal Feed 表单验收，ID 01a079d0-335f-7702-9d3c-e1edf9339b75，目录 /home/herman/Documents/Codex/2026-09-07/personal-feed-native-acceptance。

任务目录配置指定 43181、interactive、360 秒，且仅 granular.mcp_elicitations=true，其余 granular 开关 false。私密配置文件权限 0600。更新 Skill 仅复制到验收任务目录，旧服务对应的全局 Skill 未切换。

初始占位任务创建后写入配置，再通过受支持的同目录 fork 新建验收任务；占位任务已归档。新任务已报告加载的 observe_context 仅 currentText，没有 continuationToken。随后该任务只读调用 list_saved，候选服务安全日志记录 completed，从而证实请求到达新候选。没有执行模型、来源或表单调用。

实际任务上下文仍为 never。桌面任务管理工具未提供权限切换接口；用户须在该任务输入框权限菜单选择「自定义 (config.toml)」。安装版源码已确认该选项读取任务 cwd 配置并用于下一轮权限；必须再核实下一轮实际 granular 值，不能把磁盘配置当作已启用。新 MCP 加载已由上述真实调用单独验证。

补充诊断：本机 `codex -C <dir> mcp get` 未按目标 cwd 合并项目设置，而在目标目录运行同命令得到 43181；因此不使用前者结果判断桌面加载状态。

## 待用户亲验

依次核实权限生效、实际显示表单、填写并修改、取消及结束结果；再由用户明确发起新请求、补足真实个人信息，观察原调用一次性继续推荐。实际 Feed 的价值由用户判断。不得用普通聊天问答、自动填写或受控技术测试替代这些动作。

操作说明：[验收说明](/home/herman/Documents/Codex/2026-09-07/personal-feed-native-acceptance/ACCEPTANCE.md)。用户结果先记录于该目录 ACCEPTANCE-RESULTS.md，再归档本项目「个人Feed」目录。当前不宣称首轮用户亲验或完整业务验收通过。
