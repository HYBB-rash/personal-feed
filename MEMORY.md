# 可复用经验

- 2026-09-05：systemd 的 EnvironmentFile= 将外围双引号作为路径字面内容，本机报告 path is not absolute 并忽略变量文件；不能复用 ReadWritePaths= 的列表引号编码。安装器测试应验证实际绝对目标路径，真实启动后核对 EnvironmentFiles、重启次数和 MCP 模型调用；源码 CLI 及 readyz 通过不代表 systemd 配置或真实业务可用。
