# Personal Feed MCP contract

客户端使用 `serverName: personal_feed`。五个工具名称和顶层业务结果类别保持稳定；所有输入与结果均为封闭 schema。`currentText` 必须是当前用户原文，不归纳、不拼接历史。

| Raw tool | Input | Result |
|---|---|---|
| `request` | `{currentText}` | `one_link` + `url` + 可选 `limitations`、`business_empty`、`incomplete` + `stage` |
| `observe_context` | `{currentText}` | `applied` + `appliedCount`、`ignored`、`already_observed`、`incomplete` + `stage` |
| `process_feedback` | `{currentText, referenceText?}` | `pass`、`completed`、`discarded`、`needs_input` + `question`、`incomplete` + `stage` |
| `record_feedback` | `{operation:"save"|"unsave",url,title?,note?}` | `saved`、`unsaved`、`already_saved`、`already_unsaved` |
| `list_saved` | `{limit?}`，默认 20，最大 100 | `completed` + `items:[{url,title?,note?,savedAt}]` |

`request` 阶段：`context_observation`、`personal_context`、`source_window`、`judgement_execution`、`conflict`、`shutdown`。`observe_context` 阶段：`context_observation`、`conflict`。`process_feedback` 阶段：`feedback_interpretation`、`feedback_commit`、`conflict`。

## 调用模式与问答

调用程序通过固定 HTTP 头 `Personal-Feed-Mode` 设置 `background` 或 `interactive`；省略即 `background`。这不是工具参数，不能由模型自行决定。其他值为非法输入。

普通 `request` 在两种模式下都读取当前可用个人了解并直接发现，空了解或 uncertain 认识均合法；不做充分性评估、不启动画像问答，也不把请求模板保存为个人事实。用户主动表达的更新由独立 `observe_context` 保存，后续请求才读取更新后的依据。

交互模式只为有必要澄清的独立更新／反馈提供 MCP `elicitation/create` form。客户端将 `answer` 原文交回当前调用；普通 `observe_context` 或 `process_feedback` 不额外生成 Feed。已完成业务不因非阻塞的剩余问题延长等待。

需要更新／反馈表单的客户端须声明 form elicitation 能力并允许此类交互；普通发现无此要求。表单使用 `relatedRequestId` 绑定发起它的工具调用，等待发生在业务队列之外。客户端只负责显示表单、回传原文，不通过新的 `observe_context` 或 `process_feedback` 调用来提交表单答案。

公开输入和输出不再接受 `continuationToken`，也不携带嵌套 `feed`；旧标记没有兼容分支。`needs_input` 类别保留，但不是跨调用续答协议。

## 结束与超时

交互未完成可在 `incomplete` 上携带 `reason`：

| reason | 含义 |
|---|---|
| `interaction_unavailable` | 客户端或当前调用无法提供交互 |
| `interaction_declined` | 客户端拒绝交互；可能由权限策略自动拒绝，不能断言是用户点击拒绝 |
| `interaction_cancelled` | 交互被取消 |
| `interaction_timeout` | 调用等待超时 |

这些原因适用于 `observe_context` 的 `context_observation` 和反馈的 `feedback_interpretation`；发现被取消／超时使用 `request` 的 `shutdown` 阶段，分别带 `interaction_cancelled` / `interaction_timeout`。历史 `request` 的 `context_observation` / `personal_context` 仍保留兼容校验，但普通发现不再做画像问答。`request` 的 `source_window` 另可带 `observation_failed`、`partial_observation`、`material_insufficient`。

整次服务调用默认 300 秒，表单只用剩余时间，不另开完整等待周期。无法确定内部阶段的请求异常结束为 `incomplete/shutdown`，文案仅说明本次请求中止；独立更新／反馈的内部异常使用各自的普通 `incomplete` 阶段。建议 Codex 工具超时 360 秒。取消或超时保留此前已经提交的局部事实，不恢复未完成请求。

## 连接与错误边界

Streamable HTTP 的 MCP 连接状态只在 HTTP 接入层内存中保存，用于协议路由。标准连接 ID 不进入领域数据或日志，也不表示用户身份。鉴权后的 `DELETE /mcp` 和服务停止释放连接及等待；单纯关闭客户端而不发送 DELETE 不保证立即清理，当前调用仍受总期限约束。没有持久化待回答表、跨重启恢复、重放或连接 TTL。重启后客户端须重新初始化。

`appliedCount` 是本次调用实际提交的变更项数，可累计多轮回答；重复新增和等值替换计零。它不等于事实总数变化，也不证明个人资料足够。

业务空、`needs_input`、`incomplete` 都是正常结果。只有鉴权、非法输入和明确的存储故障是 MCP error；内部异常或非法内部输出不得伪装成存储故障、正常空或保存成功。诊断日志失败不翻转已经得到的业务结果。日志不记录用户原文、来源正文、完整 URL、协议连接 ID 或凭证。

`record_feedback` 和 `list_saved` 没有 `incomplete` 类别：本地超时、服务关闭或未知内部异常通过当前 HTTP 请求的传输失败结束，不增加结果类别。客户端主动取消由 MCP 协议处理，与服务本地 timer 区分。中断只说明没有得到可靠确认；若提交已经开始，不能据此认定未保存，应先查询收藏状态再决定下一步，不自动重试。

自动测试与真实 Codex 界面验收分别记录；协议通过不能替代用户实际收答与真实 Feed 验收。历史 D00 文档中的跨调用标记流程已由本合同取代。


## V0 来源与推荐限制

成功结果仍只包含一条真实候选原文。可选 `limitations` 为去重数组，值为：`partial_observation`（仅取得部分来源）、`material_insufficient`（部分条目正文不足）、`judgement_incomplete`（部分条目判断失败）。多个问题可同时呈现；无问题时省略。调用方应连同原文说明实际限制，不能声称整批完整。

可信部分材料先继续判断；单条判断失败继续后续候选。整体来源失败、全部材料不足和整体判断失败仍按实际阶段结束为 `incomplete`。取消和整次时限优先结束，不因此继续下一候选。历史 `candidates.jsonl` 保留原样，但不再用作永久准入屏蔽或继续写判断账；本次去重不承诺跨调用永不重复。

V0 仅实现 S1/S2。来源正常零候选或兴趣候选均无推荐时，返回 `{status:"incomplete",stage:"judgement_execution",reason:"exploration_not_ready"}`，说明后续探索尚未就绪，不能报告新版意义下的正常空，也不假称已探索。`business_empty` 类别为兼容保留，V1 完成探索后再使用其完整语义。复验入口与证据见 [V0 执行记录](v0-execution.md)。
