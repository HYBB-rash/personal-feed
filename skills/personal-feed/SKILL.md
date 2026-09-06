---
name: personal-feed
description: 使用已安装的 Personal Feed MCP 请求一条个人 Feed，观察用户直接表达的长期兴趣或已有认识，处理对 Feed 内容的喜欢、不喜欢和追问，以及收藏、取消收藏和查看收藏。用户明确请求 Personal Feed，或当前消息直接表达这些意图时使用；普通话题中的“喜欢”或“不喜欢”不要自动触发 Feed 反馈。
---

# Personal Feed

Personal Feed 是独立 MCP 服务。只通过已加载的 `mcp__personal_feed__*` 工具使用它；不要自行读写其状态、调用 HTTP、操作浏览器或模拟筛选结果。

## 请求 Feed

用户明确要求 Personal Feed 时，调用 `mcp__personal_feed__request` 一次，并将当前用户消息原文不改动地作为 `currentText`。该调用不传 token，已经观察本轮语境，同一轮不再调用 `observe_context`。

- `one_link`：只呈现返回的这一条内容。
- `business_empty`：说明本轮暂时没有符合条件的内容；不自行补推荐。
- `incomplete`：按工具返回的阶段说明未完成；不把它说成“没有内容”。其中 `personal_context` 带问题/token 时说明原 Feed 正在等待补充信息，呈现具体问题；没有问题时不自行编造问题或等待状态。

以上结果都可能同时携带剩余问题，按下面的问答规则一并呈现，不因已有链接或空结果就丢弃问题。

## 观察上下文

当前用户消息直接表达长期兴趣、已有认识，或回答当前个人信息问题时，调用 `mcp__personal_feed__observe_context`。`currentText` 必须是当前用户消息原文，不要归纳、重写或拼接历史会话。当前有效的个人信息问答有关联 token 时自动携带，用户不必说“我在回答”。`ignored` 和 `already_observed` 都是正常结果；带剩余问题时问答仍有效。

普通更新没有附带 Feed 结果时，只呈现更新结果和实际返回的问题；不因为信息已经足够而主动请求 Feed。

## 处理反馈

喜欢、不喜欢或对 Feed 内容的语义反馈调用 `mcp__personal_feed__process_feedback`：

- `currentText` 始终是当前用户消息原文。
- 仅当当前消息或当前显式引用里有定位目标所需的文字时才传 `referenceText`；不从更早的隐含会话里猜。
- 返回 `needs_input` 时，呈现返回的 `question`。用户回答后，将新的用户原文作为 `currentText`，并将当前有效的 `continuationToken` 原样传回 `process_feedback`；如果同时有 `feed`，也呈现该结果。
- `pass`、`completed`、`discarded` 和 `incomplete` 按原意回复，不在工具成功前声称已记录。

收藏和取消收藏只调用 `mcp__personal_feed__record_feedback`，`operation` 只能是 `save` 或 `unsave`。它不代替喜欢或不喜欢。仅在当前消息或当前显式引用能唯一定位 URL 时调用；无法唯一定位时先用一个简短问题追问。

查看收藏调用 `mcp__personal_feed__list_saved`；未给数量时不传 `limit`，由服务使用默认值 20。

## 当前问答与附带的 Feed

- `request`、`observe_context`、`process_feedback` 的任一正常业务结果都可能携带 `question` 与 `continuationToken`。两者应成对出现，只询问实际返回的问题，不从 `applied`、`ignored` 或其他顶层结果猜测问答已经结束。
- `request` 或 `observe_context` 的个人信息问题及其补充，交回 `observe_context`；`process_feedback` 的反馈问题及其回答，交回 `process_feedback`。保持本条用户原话，不把旧请求再作为新的 `currentText` 发送。
- 只在当前持续的有效问答内保留关联。对应调用返回了新问题/token 对就改用它；没有剩余问题时结束该关联。不要用无关普通调用或收藏结果清除另一条有效问答，也不要从早先已经中断的问答找回或猜测 token；不展示 token，不写入文件或建立跨会话恢复设施。
- `observe_context`、`process_feedback` 可能在外层结果之外附带 `feed`。分别说明更新或反馈的结果，以及 `feed` 中的链接、业务空或未完成；即使更新成功，也不能把来源或判断失败说成 Feed 成功。
- 问题和 Feed 结果可以同时存在，必须同时呈现。嵌套 `feed` 不包含下一层 Feed 或独立问题，使用外层的问题/token；不要因为出现 Feed 结果就丢弃剩余问题。
- 工具已经交回实际续做结果时，不再自行调用 `request`。普通更新也不自行发起推荐。
- 关联无法使用时，按工具返回的未完成说明本次无法对应回答；不重建旧关联或自动重发旧 Feed。MCP 错误不解释成空结果或已完成。

当前默认应用尚未实现个人信息问答和 Feed 自动续做；上述规则说明如何消费应用实际返回的字段，不允许自行补出这些字段或伪造续做结果。`observe_context` 收到合法但当前无法关联的 token 时会返回未完成。

## 不可用

如果 `mcp__personal_feed__*` 工具不存在或暂时不可用，如实说明 Personal Feed 未安装或服务暂时不可用。不用网页搜索、临时脚本、本地文件或自己的推荐来伪造 Personal Feed 结果。
