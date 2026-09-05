# 可复用经验

- 2026-09-05：systemd 的 EnvironmentFile= 将外围双引号作为路径字面内容，本机报告 path is not absolute 并忽略变量文件；不能复用 ReadWritePaths= 的列表引号编码。安装器测试应验证实际绝对目标路径，真实启动后核对 EnvironmentFiles、重启次数和 MCP 模型调用；源码 CLI 及 readyz 通过不代表 systemd 配置或真实业务可用。
- 2026-09-05：真实 deepseek-v4-flash 判断可能在 HTTP 200 后等响应体超过 30 秒；记录状态码不足以证明调用完成。本次单次模型上限 90 秒、工具总上限 300 秒后，真实 MCP 在约 105 秒返回 one_link。工具总超时为本机手工配置，重新运行 installer apply 会重写 env，需重新检查。独立调试 X 窗口须留在观察器支持的首页、探索或搜索页，停在个人主页会导致 source_window/incomplete。
