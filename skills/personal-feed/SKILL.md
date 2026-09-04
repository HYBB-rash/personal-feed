---
name: personal-feed
description: 使用已安装的 Personal Feed MCP 请求一条个人 Feed，观察用户直接表达的长期兴趣或已有认识，处理对 Feed 内容的喜欢、不喜欢和追问，以及收藏、取消收藏和查看收藏。用户明确请求 Personal Feed，或当前消息直接表达这些意图时使用；普通话题中的“喜欢”或“不喜欢”不要自动触发 Feed 反馈。
---

# Personal Feed

Personal Feed 是独立 MCP 服务。只通过已加载的 `mcp__personal_feed__*` 工具使用它；不要自行读写其状态、调用 HTTP、操作浏览器或模拟筛选结果。

## 请求 Feed

用户明确要求 Personal Feed 时，调用 `mcp__personal_feed__request` 一次，并将当前用户消息原文不改动地作为 `currentText`。该调用已观察本轮语境，同一轮不再调用 `observe_context`。

- `one_link`：只呈现返回的这一条内容。
- `business_empty`：说明本轮暂时没有符合条件的内容；不自行补推荐。
- `incomplete`：按工具返回的阶段说明未完成；不把它说成“没有内容”。

## 观察上下文

仅当当前用户消息直接表达长期兴趣或用户已有的认识时，调用 `mcp__personal_feed__observe_context`。`currentText` 必须是当前用户消息原文，不要归纳、重写或拼接历史会话。`ignored` 和 `already_observed` 都是正常结果，不要当成错误。

## 处理反馈

喜欢、不喜欢或对 Feed 内容的语义反馈调用 `mcp__personal_feed__process_feedback`：

- `currentText` 始终是当前用户消息原文。
- 仅当当前消息或当前显式引用里有定位目标所需的文字时才传 `referenceText`；不从更早的隐含会话里猜。
- 返回 `needs_input` 时，只向用户询问返回的 `question`。用户回答后，将新的用户原文作为 `currentText`，并将上次返回的 `continuationToken` 原样传回。不向用户展示、改写或自行保存 token。
- `pass`、`completed`、`discarded` 和 `incomplete` 按原意回复，不在工具成功前声称已记录。

收藏和取消收藏只调用 `mcp__personal_feed__record_feedback`，`operation` 只能是 `save` 或 `unsave`。它不代替喜欢或不喜欢。仅在当前消息或当前显式引用能唯一定位 URL 时调用；无法唯一定位时先用一个简短问题追问。

查看收藏调用 `mcp__personal_feed__list_saved`；未给数量时不传 `limit`，由服务使用默认值 20。

## 不可用

如果 `mcp__personal_feed__*` 工具不存在或暂时不可用，如实说明 Personal Feed 未安装或服务暂时不可用。不用网页搜索、临时脚本、本地文件或自己的推荐来伪造 Personal Feed 结果。
