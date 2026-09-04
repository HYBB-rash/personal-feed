# Personal Feed MCP contract

客户端用 `serverName: personal_feed` 连接后，模型看到的工具名为 `mcp__personal_feed__<raw-name>`。每次成功调用同时返回一段供 Agent 阅读的文本和严格的 `structuredContent`；以下表格中的字段之外不允许出现额外字段。

`currentText` 必须是当前用户消息原文。服务只校验它，不替调用方归纳、改写或拼接会话历史。服务生成自己的匿名请求 ID，不接受 `chatId`、`messageId`、session identity 或其他通道身份。

| Raw tool | Input | `structuredContent` |
|---|---|---|
| `request` | `{currentText}` | `{status:"one_link",url}`、`{status:"business_empty"}`，或 `{status:"incomplete",stage}`；stage 只能是 `context_observation`、`personal_context`、`source_window`、`judgement_execution`、`conflict`、`shutdown` |
| `observe_context` | `{currentText}` | `{status:"applied",appliedCount}`、`{status:"ignored"}`、`{status:"already_observed"}`，或 `{status:"incomplete",stage}`；stage 只能是 `context_observation`、`conflict` |
| `process_feedback` | `{currentText, referenceText?, continuationToken?}` | `{status:"pass"}`、`{status:"completed"}`、`{status:"discarded"}`、`{status:"needs_input",question,continuationToken}`，或 `{status:"incomplete",stage}`；stage 只能是 `feedback_interpretation`、`feedback_commit`、`conflict` |
| `record_feedback` | `{operation:"save"|"unsave",url,title?,note?}` | `{status:"saved"}`、`{status:"unsaved"}`、`{status:"already_saved"}` 或 `{status:"already_unsaved"}` |
| `list_saved` | `{limit?}`，默认 20，服务入口最大 100 | `{status:"completed",items:[{url,title?,note?,savedAt}]}` |

`request` 已在内部观察本轮语境，同一轮不要再调用 `observe_context`。`observe_context` 只接收用户直接表达的长期兴趣或已有认识。`process_feedback` 返回 `needs_input` 后，调用方必须把下一条用户原文作为新的 `currentText`，并原样传回 32 字节随机值编码成的 43 字符 `continuationToken`。`record_feedback` 只管理收藏，不代表喜欢或不喜欢。

`business_empty`、`needs_input` 和可说明阶段的 `incomplete` 都是正常业务结果。Bearer 鉴权失败、非法输入 schema、内部返回越出上述封闭合同，以及存储故障才是 MCP error。服务错误不会伪装成空 Feed。
