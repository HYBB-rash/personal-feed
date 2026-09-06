# Personal Feed MCP contract

客户端用 `serverName: personal_feed` 连接后，模型看到的工具名为 `mcp__personal_feed__<raw-name>`。每次成功调用同时返回一段供 Agent 阅读的文本和严格的 `structuredContent`；以下表格中的字段之外不允许出现额外字段。

`currentText` 必须是当前用户消息原文。服务只校验它，不替调用方归纳、改写或拼接会话历史。服务生成自己的匿名请求 ID，不接受 `chatId`、`messageId`、session identity 或其他通道身份。

| Raw tool | Input | `structuredContent` |
|---|---|---|
| `request` | `{currentText}` | `{status:"one_link",url}`、`{status:"business_empty"}`，或 `{status:"incomplete",stage}`；stage 只能是 `context_observation`、`personal_context`、`source_window`、`judgement_execution`、`conflict`、`shutdown` |
| `observe_context` | `{currentText, continuationToken?}` | `{status:"applied",appliedCount}`、`{status:"ignored"}`、`{status:"already_observed"}`，或 `{status:"incomplete",stage}`；stage 只能是 `context_observation`、`conflict` |
| `process_feedback` | `{currentText, referenceText?, continuationToken?}` | `{status:"pass"}`、`{status:"completed"}`、`{status:"discarded"}`、`{status:"needs_input",question,continuationToken}`，或 `{status:"incomplete",stage}`；stage 只能是 `feedback_interpretation`、`feedback_commit`、`conflict` |
| `record_feedback` | `{operation:"save"|"unsave",url,title?,note?}` | `{status:"saved"}`、`{status:"unsaved"}`、`{status:"already_saved"}` 或 `{status:"already_unsaved"}` |
| `list_saved` | `{limit?}`，默认 20，服务入口最大 100 | `{status:"completed",items:[{url,title?,note?,savedAt}]}` |

## 问题和 Feed 结果的字段增量

上述顶层类别和阶段保持不变，另允许以下字段；其他额外字段仍不合法。

| 位置 | 字段 | 约束 |
|---|---|---|
| `request`、`observe_context`、`process_feedback` 的业务结果 | `question?`、`continuationToken?` | 必须同时出现或同时省略；`question` 是非空字符串。`process_feedback.needs_input` 仍必须带齐这两个字段 |
| `observe_context`、`process_feedback` 的业务结果 | `feed?` | 表示应用在这次更新之后实际继续原 Feed 得到的结果；未尝试续做时省略 |
| `request` 输入、`record_feedback`、`list_saved` | 无增量 | `request` 不接受续答标记，收藏工具不承载问题或 Feed |

`feed` 只允许以下三种严格形状：

```ts
{ status: 'one_link', url: string }
{ status: 'business_empty' }
{ status: 'incomplete', stage: 'context_observation' | 'personal_context' | 'source_window' | 'judgement_execution' | 'conflict' | 'shutdown' }
```

嵌套 `feed` 不允许问题、token 或下一层 `feed`。剩余问题只放外层，问题与 Feed 结果可以同时出现；接入同时呈现两者，不把更新成功误解成 Feed 成功，也不把仍有问题误解成没有 Feed 结果。`request` 使用自己的顶层 Feed 结果，不嵌套 `feed`。

例如，下列是用于接入验证的受控应用返回，表达“更新已提交，续做因来源失败未完成，而且仍有问题”：

```json
{
  "status": "applied",
  "appliedCount": 1,
  "question": "还有哪个适用范围需要澄清？",
  "continuationToken": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "feed": { "status": "incomplete", "stage": "source_window" }
}
```

这是字段示例，不代表当前默认应用已实现个人信息澄清或 Feed 自动续做。重复字母标记仅为夹具，实际关联继续使用既有随机标记。

## 调用与呈现

`request` 已在内部观察本轮语境，同一轮不要再调用 `observe_context`。每次调用都根据当前事实重新观察用户原话，不按历史原话跳过；同一句话在关注变化后再次表达仍可更新语境。`already_observed` 保留在公开结果类别中。`record_feedback` 只管理收藏，不代表喜欢或不喜欢。

- 个人信息表达，以及 `request` 或 `observe_context` 提出的问题的回答，交给 `observe_context`；语义反馈及 `process_feedback` 提出的问题的回答，交给 `process_feedback`。
- 调用方在当前有效问答内自动携带 `continuationToken`，保持本条 `currentText` 原样，不重发旧请求、不把旧原文拼成新的用户消息。`request` 不接收标记。
- 只为本次关联更新标记：返回了新的问题/token 对就使用该对；对应调用没有返回剩余问题时结束该关联。无关的普通调用或收藏结果不用于清除另一条问答的标记。关联中断后不猜测或重建它，不建立跨会话恢复设施。
- `request` 的 `incomplete/personal_context` 带问题时表示等待补充；不带问题时仍按普通未完成呈现。`ignored` 或 `applied` 带问题也继续呈现问题。
- 问题与 `feed` 同时出现时同时呈现；没有问题时不自行补问。调用方不得因为 `feed` 存在或个人信息变得足够，再额外调用一次 `request`；普通更新没有 `feed` 就只呈现更新结果。

token 保持 32 字节随机值编码成的 43 字符 base64url 格式，不展示给用户，不进入可读文本或日志。格式非法为 MCP 输入错误；格式合法但无法关联时，`observe_context` 返回 `incomplete/context_observation`，`process_feedback` 返回 `incomplete/feedback_interpretation`，不制造新问题、修改个人信息或重跑 Feed。

`business_empty`、`needs_input` 和可说明阶段的 `incomplete` 都是正常业务结果。Bearer 鉴权失败、非法输入 schema、内部返回越出上述封闭合同，以及存储故障才是 MCP error。服务错误不会伪装成空 Feed。

## 当前支持边界

D01 已实现上述类型、MCP 校验、透传和可读结果组合。默认应用仍未实现个人信息问答关联或自动续做；它对 `observe_context` 中格式合法的 token 返回 `incomplete/context_observation`，不解释这条回答或改变资料。无 token 的既有更新、Feed 请求和有效反馈续答保持原有行为。

接入测试用受控应用返回验证字段及呈现，真实应用测试验证失效标记无副作用；它们不证明 D05/D06 已能产生问题或继续 Feed，也不替代真实对话、模型或 X 使用验收。完整业务交接要求见 [D00 合同](d00-handoff.md)。
