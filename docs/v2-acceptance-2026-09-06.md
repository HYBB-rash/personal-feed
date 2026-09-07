# 第二版返工与验收记录

依据：[第二版验收清单](/home/herman/Documents/Repo/Projects/DSHPlugins/个人Feed/第二版验收清单.md)，完整读取 453 行，A01—A11 各分支分别判定。

## 口径与候选

- 用户授权执行返工、独立验收、必要的本地构建及服务切换；不提交或推送。
- 用户明确选择只用其真实认识、关注变化和主观判断。受控测试资料仅用于临时测试，不能替代真实推荐质量、真实负面反馈或用户验收。
- 开始基线：`3b05ca322cfee77718234fa262872955bbac5e73`，已有诊断相关未提交改动及问题记录；保留预先存在的 `docs/d02-gap-analysis.md`。
- 运行基线：`personal-feed.service`，PID `3222600`，`diagnostics-20260906T211756/lib/cli.js serve`。这是返工前版本；后续候选与运行证据另记。
- 日常状态 `/home/herman/.local/state/personal-feed` 不参与试写、清空或故障注入。验收目录逐场景隔离，旧失败不删除。
- 主 Agent 负责核心、真实调用、环境和收口；内部协作 Agent 负责 MCP/Skill 及受控故障链；独立 Reviewer 复核候选。

## 已确认问题与返工证据

| 问题 | 原行为与失败证据 | 修改及当前验证 |
|---|---|---|
| A02 无可续答问题 | 模型缺少问题时，空白、只有关注、只有认识三个起点均返回没有问题/token 的 personal_context；新测试首次 6 失败、2 通过 | 服务为可确定缺少的类别补追问，保留明确事实；模型语义缺口必须有具体问题；补足后一次续做，重复 token 不重放 |
| A11 来源原因丢失 | 三类 observer 原因到应用均只剩 source_window；新增三例全部 RED | 透传封闭 reason；获取、部分材料、正文不足经过 MCP 呈现 |
| 回答失败重显旧问题 | 失败结果的旧问题未经区分直接显示 | 明确这次回答未处理成功，并标注上次保留的问题；保留有效关联供用户继续回答 |
| 结构诊断太粗 | context_schema 不区分顶层、变更集合、新增和替换；新增 6 例 RED | 固定结构位置及应用校验分类，不记录字段值、动态未知字段名、正文或凭据 |
| 空闲服务退出拖延 | 关闭后的 deadline timer 仍保活；新增计时器清理测试 RED，实际进程退出也曾超过 7 秒 | idle 后清理 timer；单测 GREEN，实际 SIGTERM 退出另由受控进程验收 |
| 接入说明过期 | Skill/MCP 文档声称默认应用没有澄清或续做 | 同步当前能力与边界；已安装副本及当前连接在运行候选准备时核验 |

定向验证：`nix develop --command pnpm exec vitest run tests/context-acceptance.spec.ts` 13/13；此前相关六文件回归 98/98（该批早于新增关闭计时器用例）。最终完整检查尚待候选收口执行。以上均为受控技术证据。

## 各分支状态

| 分支 | 当前状态 | 尚需的实际证据 |
|---|---|---|
| A02-1 两类都没有 | 实际澄清与续做通过 | 用户亲验；续做后判断未完成，A01 独立待验 |
| A02-2 只缺认识 | 实际澄清与续做通过 | 用户亲验；续做后正文不足，另有可补充问题 |
| A02-3 只缺关注 | 实际澄清与续做通过 | 用户亲验；续做正常完成，本次没有合格内容 |
| A07-1 新增关注 | 待验 | 用户真实新增关注；普通更新不推荐，后续真实原文能体现新增内容 |
| A07-1 新增认识 | 待验 | 用户真实新增认识；后续原文有可区分的使用效果 |
| A07-2 普通更新澄清 | 待验 | 无原 Feed 时问答结束不自行推荐 |
| A01 | 待验 | 本次真实调用取得可打开原文，用户判断具体价值和信息增量 |
| A08 | 已操作，使用效果待验 | 全新任务调用同服务且未重填信息；本次正常空结果，缺可判断原文 |
| A09 | 已操作，使用效果待验 | 正常重启后配置/事实一致且未重填信息；本次正文不足，缺可判断原文 |
| A06 | 待验 | 用户对实际 Feed 的真实负面反馈及原因，后续同主题原文 |
| A04 | 待验 | 用户真实局部纠正，保留其他认识，前后原文有可区分效果 |
| A03 | 待验 | 用户真实更改长期关注，当次及后续两条可判断原文 |
| A05 | 待验 | 隔离且符合暂停条件的真实存疑表达，含糊和明确回答后原请求续做 |
| A10-1 / A10-2 | 技术调用与恢复通过 | 用户最终亲验；仅覆盖明确受控条件 |
| A11-1—A11-5 | 技术调用与恢复通过 | 用户最终亲验；不代表所有真实网络故障已覆盖 |

## 执行记录

后续每次追加时间、候选、状态目录、前置条件、实际输入、实际结果、判断与恢复情况。真实输入和原文链接可按验收需要记录在本文；任何关联 token 或凭据都不写入。模型与服务日志只保留安全分类及计数。

### 候选一与 A02-1 第一次真实入口：不通过

- 2026-09-06 22:44：完整 `nix develop --command pnpm check` 通过，249 项 TypeScript、28 项 Python、类型检查及构建。第一次完整检查曾有两条旧 MCP fixture/期望未同步而失败；修正后完整重跑通过。构建保留既有 `define` 选项告警。
- 独立复审发现 A11-2 夹具没有先取得材料，已退回修复。修改后的夹具通过真实 Python observer/CLI，先取得一条正文，再发生 snapshot 失败；新增前置先 RED 后 GREEN。Reviewer 只读复核确认该问题关闭。
- 候选构建：`/home/herman/.local/share/personal-feed-dev/builds/v2-rework-20260906T224521`；lib 内容指纹 `cc4a2fef7b914ccaccdf99b059df526a3a6be42ad78fc1c0b0803e9657f530b4`。13 个 sourcemap 源文件与当前源码一致，Python 副本逐文件一致。
- 激活：PID `3274742`，独立状态 `/home/herman/.local/state/personal-feed-acceptance/a02-1-20260906T224521`，起点两类事实均为零；五个原生 MCP 工具可用。已安装 Skill 与仓库一致。
- 实际通过当前 Codex 原生 `request` 发送：`给我一次个人 Feed`。
- 实际返回：`incomplete/context_observation`，无问题。安全日志为 `model_failure/observe_context/model_incomplete`，随后 `application_failure/model_incomplete`；事实仍为零、没有进入 X 获取。
- 判定：A02-1 本次不通过。与先前缺字段不同，本次模型明确返回 `incomplete`。静态检查发现提示词存在将“无法判断充分性”与“缺少个人信息”混淆的空间；本轮修复假设是需明确缺信息是正常的不足与追问，而不是解释失败；先保留本次 RED，再修改并复验。
- 日常状态指纹仍为 `dafc2278c57f7b67da67abf2b588924eb0d98f6690838b6e449f59db0b1bacb8`，未改变。原环境及已安装 Skill 备份位于 `/home/herman/.config/personal-feed/backups/v2-acceptance-20260906T224318`。

### 候选二与续答字段故障：不通过，返工中

- 构建 `v2-rework-20260906T224951`，lib 指纹 `df5e209560682555ac9139ad482430b1768fd875307bde630ee3881e8c0e696a`，独立状态 `a02-1-retry-20260906T224952`。
- 真实 Codex 请求得到两类缺口问题；含糊回答没有建立事实；用户先前明确提供的长期关注被保存，下一问仅针对认识。随后用用户原有认识回答，返回 `incomplete/context_observation` 并保留旧问题关联，没有保存认识或进入 X。故仍不通过。
- 为澄清结构新增 6 项 RED 测试，再细分为缺 remaining、对象形状、问题、范围、引用字段五类固定诊断。相关 102 项测试通过。
- 隔离真实模型实验（读取既有关注，输入用户原有认识；unresolvedScope 按问题重建，并非原请求完全重放）复现 `clarification_invalid/remaining_missing`。不写应用状态、不调用 X、不记录模型原文。
- 随后仅对带 clarification 的调用追加明确的必填字段检查约束，保留严格解码及“无关补充不解决旧问题”。同一隔离实验返回 applied、4 条新增、仍需追问，未再发生结构错误；这只证明该实验响应结构有效，不证明 A02 完成或模型充分性判断正确。独立 Reviewer 静态复审未发现破坏语义或隐私边界；再次 102 项定向测试通过。
- 官方资料已通过本机 Chrome 打开：[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。文档承诺 JSON 格式并提示可能空内容，没有承诺应用必填字段或语义正确。因此没有将开启 JSON 模式当作本次漏字段问题的修复。

### 候选三、浏览器恢复与受控分支

- 候选 `v2-rework-20260906T230143`，lib 指纹 `9f69baa407a16d3489aed4bd7dcfbda4429af9a9db3d891dfa0b5c02cc09b8cb`。独立 A02-1 状态 `a02-1-contract-20260906T230143` 从零开始：原请求追问两类、含糊回答 ignored、明确关注 applied 2、明确认识 applied 3；生成次数 4，存有关注 2 / 认识 3，原请求自动续做一次。嵌套 Feed 为 `source_window/observation_failed`，未得到可判断原文。此轮只证明澄清与续做链，不算完整 A02 通过。
- A02-2 独立状态 `a02-2-contract-20260906T230332`：普通关注 applied 1，没有 Feed；请求只追问认识；含糊回答 ignored；明确认识回答失败，固定诊断 `context_schema/changes_shape`，事实未提交且保留旧问题关联。该分支不通过。隔离重建范围的再次模型诊断输出完整 additions/replacements 并通过，只说明存在波动，不能覆盖原失败。
- 上述 A02 原有真实表达统一为：关注“一个人怎样用 AI 完成有叙事、有表达的短视频；重视能反复使用的方法、实际制作过程和失败经验”；认识使用用户原文中 AI 画面/配音、镜头衔接/节奏、单助手贯穿流程、多个助手分工需明确交接并检查结果。没有代写新的用户偏好或经验。
- 2026-09-07：确认采集端口 9222 无监听。用户随后授权启动浏览器。我首次错误选用 `.local/share/personal-feed-chrome`，发现没有 X 状态后关闭该确切 PID，改用 `.config/google-chrome-debug`。核实登录页表单为零、账号菜单 1、帖子 19；独立浏览探针随后完整通过三个来源。没有迁移或复制 Cookie，没有更换账号。启动是本次人工运维，未给服务新增浏览器启动器。
- 浏览器恢复后一次原生 Feed 完成来源但返回 `incomplete/judgement_execution`；当次没有固定模型错误日志，不能断言是结构错误、超时或语义 unknown，更不能算正常空结果。A01 仍无有效原文。
- A10-1、A10-2 和 A11-1—A11-5 各用独立临时状态、受控 observer/loopback 模型，经过当前 Codex 原生工具调用。逐项前置、实际文字/结构、恢复结果见 [调用证据](v2-boundary-call-evidence.json)。每项恢复后都取得受控 one_link，再恢复真实验收状态，结束辅助进程。所有日常状态指纹核验一致。
- 两种空结果均正确返回 business_empty；获取失败、部分观察、正文不足正确分开；判断 HTTP 503 返回 judgement_execution；损坏临时账本得到 MCP isError。A11-2 额外确认已拿到一条材料后 snapshot 失败。A11-4 实际回复仍含英文内部阶段名，退回改成中文；新测试先 11 RED / 47 PASS，修改后 58/58，尚需用新候选复验呈现。其他六个分支的技术调用与恢复通过，不替代真实 X 质量或用户最终验收。

### 严格结构化输出返工

- 仅追加提示词仍出现不同漏字段，故保留这些失败，新增显式可选 strict_tool 模型传输，默认仍为 json_content。固定唯一函数只承载原有结果，不执行外部工具；本地严格解码、个人事实冲突与续答判断不放宽。
- 已在本机 Chrome 阅读 [Tool Calls strict](https://api-docs.deepseek.com/guides/tool_calls/#strict-mode-beta) 及 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)。官方要求 Beta 端点、strict=true、封闭且属性必填的对象；思考模式默认启用。
- 合成兼容实验：指定具体 tool_choice 得到 HTTP 400，明确原因是思考模式不支持该选择；改为 auto 后 HTTP 200、唯一固定函数、两种空数组及 remaining:null 均符合 Schema。不改变思考模式，不把 endpoint 自动转换写进产品。
- 使用实际新增 Schema 的隔离真模型实验，对用户原有认识返回 applied 4、sufficient:true、remaining:null，无诊断；仍只是一次隔离解释证据。
- 接入测试先 4 RED / 5 PASS，实现后 9/9；验证配置选择、continuation 必填、严格对象、唯一函数、拒绝自由文本回退/多函数/错名/坏 JSON，以及保留原有语义字段校验。完整检查与新候选真实重验继续追加。

### 候选四

- 2026-09-07 07:27 完整 `pnpm check` 通过：271 TypeScript、28 Python、类型检查、构建。复审发现安装入口会丢掉 responseFormat，已补齐 CLI 到私有 EnvironmentFile；安装测试先 8 RED / 10 PASS，再 18/18，最后类型检查与构建通过。复审关闭该 P2。构建仍有原有 tsdown define 告警。
- 构建 `v2-rework-20260907T073056`，lib 指纹 `4e1c04d09d36cf1725c906a7a437a27c0e2049c44e6fd7dc6ee3bc074ceb6d2b`；14 个 sourcemap 源文件和 Python 副本匹配。真实验收配置显式选择 strict_tool 与同供应商 Beta 端点，模型名称及思考设置不变；受控夹具仍用原 JSON 内容接缝。
- A11-4 新候选原生调用已复验，实际文字为“Personal Feed 对内容是否符合条件的判断未完成。”恢复后得到受控 one_link；已恢复真实验收配置并结束辅助进程。七项受控分支均具备前置、原生调用与恢复证据。
- A02-1 新状态 `a02-1-strict-20260907T073150` 的逐步结果继续追加；保留候选一、二、三的所有旧失败。
- 该 A02-1 原生追问链：请求两类信息 → 含糊回答 ignored → 明确关注 applied 1、只追問认识 → 原有认识 applied 3，并自动续做，无剩余追问关联。嵌套 Feed 最终仍为 judgement_execution 未完成，故完整使用效果待验。
- 两次真实请求在判断阶段未完成，而此前没有区分“结构非法”与“模型明确 unknown”的日志。新增五项诊断测试先 5 RED / 23 PASS，再补固定 judgment_schema / judgment_unknown（仅标出价值、关注或增量门槛）；相关 76 项及类型检查通过。此修改不改变判断、返回值或重试行为；下一候选带该诊断继续定位。

### 三种 A02 实际链条收口

- 新诊断候选 `v2-rework-20260907T073658`，lib 指纹 `dbfa6ae2d7b31042a22290fd3f5e86e6a85ee0d9663cbf748e46ad489e720e66`，只增判断诊断，不改变业务结果。A02-2 / A02-3 分别使用 `a02-2-strict-20260907T073658`、`a02-3-strict-20260907T073925`，均从各自独立状态开始。
- 三个分支的实际原文、问题、结果和是否存在续答关联见 [澄清调用证据](v2-context-call-evidence.json)，没有记录关联 token。
- A02-2：单独保存关注，无 Feed；请求只问认识，含糊回答 ignored；明确认识 applied 3 后自动续做，返回正文不足。仍保留的具体工具/熟练度问题不是 Feed 的等待条件：独立复核 [D00 合同](d00-handoff.md#3-问题回答与原请求的关联) 确认允许此种并存，且用户原文未回答具体工具。呈现将明确区分原请求已执行与可继续补充的问题。
- A02-3：单独保存认识，无 Feed；请求只问关注，含糊回答 ignored；明确关注 applied 2 后自动续做，正常得到 business_empty。个人状态为关注 2 / 认识 3；该新状态首个 Feed 的处理账本共 18 条，指纹 `e690d28e2da5a2aff1a6c822b7aed5a73b56bf4bf6adc4ea0f696a62435e4330`，本轮无模型错误日志。
- 判据复核修正此前过严的记录口径：A02 明确允许原请求续做后如实说明后续实际未完成原因，不要求一定取得 A01 的有效原文。因此三种缺口、含糊不冒认、明确部分保留、原请求自动续做均有实际通过依据；不能因 A01 仍待验把这些行为说成不通过。用户最终亲验仍未进行，所有旧失败继续保留。

### 最后候选与 A08 / A09

- 并存问题与 Feed 的文字单独返工：先说明原请求已继续执行，再呈现结果，并标记“仍可补充的问题（继续回答不会重复执行本次 Feed）”。新增 3 项 RED，修复后 MCP 61/61；此变化不改结构化结果。随后类型检查、构建通过。
- 当前候选 `v2-rework-20260907T074501`，lib 指纹 `3d6c3c5814ae453a1caace533ac8856a0202cb39549f176faa1e65fa1a01c115`；14 个源文件映射及 Python 副本一致。已安装 Skill 与仓库副本一致。
- A08 新任务“ A08 个人 Feed 换任务验收 ”，任务 ID `01a0791c-b910-7e52-acb6-1853b3cce720`，同项目独立工作目录 `/home/herman/.codex/worktrees/0a89/personal-feed`。唯一初始输入为“给我一次个人 Feed”，未复制此处个人信息或聊天历史（工具自身带来源任务标记）。该任务读取已安装 Skill 后，实际调用 `personal_feed/request` 一次，参数保留原文；83.551 秒后任务完成，没有追问画像，回复“这次暂时没有符合条件的个人 Feed 内容。”
- A08 对应服务日志为 request / business_empty / 66459ms，与任务 MCP 调用耗时 66463ms 一致；运行在同一验收服务与状态。最初任务列表未显示新任务，后来通过其实际任务 ID 读取及原生 wait 工具确认已完成，不能把列表延迟记成服务故障。
- A09 在 A08 完成后正常重启同一 `personal-feed.service`：PID `3433651` → `3435008`，可执行文件、PERSONAL_FEED 配置、状态目录及个人事实均一致。事实指纹 `e6f9b9c785cf75eb8f2f454ad9f3224de61ad3a1743428f10e566bf996ba18bb`。从当前 Codex 任务发送“给我一次个人 Feed”，没有重填信息或触发画像追问，实际返回 source_window / material_insufficient。
- A08/A09 的信息保留及正常调用已有技术证据；两项要求的真实原文使用效果仍待验，不能据“未重填”直接勾选整项。A01 也保持待验：本轮没有获得可供用户判断价值和信息增量的推荐原文。最近正常空结果的 A02-3 账本 18 条均为 not_qualified；没有用外部手选链接代替 Feed。

## 当前交付边界与待补条件

- 已完成客观返工及上述实际链条；不报告 A01—A11 整体验收通过。A03/A04/A05/A06/A07 的真实新增关注、认识变化、存疑或负面反馈没有由代理编造；需要相应用户表达和可判断前后原文的分支继续待验。已询问用户是否有关于 AI 短视频制作的新认识或修正，尚未得到该输入。
- 所有受控故障已解除，临时辅助进程已退出；A08 任务已完成，没有后台重试或自动化。保留单个本机验收服务、恢复后的 `.config/google-chrome-debug` 浏览器和全部旧验收记录。日常状态未改变。
- 验收记录收口时源代码改动未提交、未推送；随后用户要求先提交本次修复，再亲自验收。本次本地提交包含修复、测试与验收证据，预先存在的 `docs/d02-gap-analysis.md` 不纳入提交。完整检查 271 TS / 28 Python 后，安装、判断诊断、并存呈现各自完成受影响回归，最后类型检查和构建通过；没有把早期完整检查冒充后续所有测试都重新跑过。

### 用户亲验：没有入口标签页时自动开页

- 2026-09-07，用户任务“获取个人 Feed”（`01a07934-785e-7081-ad45-1745cc24de8a`）补充认识后返回 applied，附带 Feed 为 source_window / observation_failed。个人状态已保存为关注 1、认识 4。现场浏览器已登录，但只有推文详情页；只读探针确认可用入口页为零，旧采集器返回 incomplete。原调用未记录更细原因，不能把现场复现当作原调用的完整根因证明。
- 用户明确要求采集器自己打开页面。修复后，没有可用入口页时，在同一已连接浏览器中通过固定 loopback CDP PUT 新开一个 X 首页；开页计入原截止时间、受同一导航锁保护，不重试。已有可用入口页仍复用，开页失败保持原有未完成类别，不新增浏览器进程启动或账号管理。
- 新增 5 项回归测试，先失败、实现后通过；全部 33 项 Python 测试通过。覆盖无页面、只有详情页、复用、开页失败、截止时间、固定请求和非法返回。没有重跑无代码变化的 TypeScript 检查。
- 独立实机观察前可用入口页 0，自动创建 1 页，原有页面保持不变；for_you / following / explore 均 complete，分别观察到 5 / 6 / 6 条。此次只运行采集器，没有调用模型或写入个人验收状态，不代替推荐质量验收。
- 已切换到 `v2-rework-20260907T082230`，PID `3445123`；14 个 TypeScript 映射和 Python 副本匹配。此次仅 Python 运行代码变化，lib 指纹沿用 `3d6c3c5814ae453a1caace533ac8856a0202cb39549f176faa1e65fa1a01c115`。保留用户亲验状态目录，重启前后状态指纹一致，关注 1、认识 4，模型配置与日常状态不变。新修复尚未提交。


### 2026-09-07 10:13：先核验 Personal Feed，再做 DSH 接入验收

用户确认最终使用入口应以 DSH 为准，并要求先做好 Personal Feed 自身验收。此次只核验当前源码与隔离自动测试，没有启动 DSH、切换现用 Feed 服务或修改个人信息。

- 当前源码 `1d6ec6f32bca1c95cb84bc908cef42c8f350ed38`，完整 `nix develop --command pnpm check` 通过：287 项 TypeScript、33 项 Python、类型检查和构建。包含隔离的真实 HTTP MCP 服务、临时存储与受控来源/模型故障及恢复；不代表真实模型推荐质量或 DSH 对话通过。构建仍有既有 `define` 选项告警。
- 当前仍由调用方传回续答关联；真实普通对话曾丢失关联并停止，旧 A02 的正确传参测试不能覆盖该失败。见[实际失败调查](a02-continuation-investigation-2026-09-07.md)。
- 刚确认的新方案尚未实现：请求接口没有每次调用的交互策略，也没有服务主动提问及接收答案的通用能力。当前资料不足的请求仍会产生追问，不能据本轮绿灯认定“后台不提问、主动交流由固定程序收答”已经通过。
- 下一阶段服务验收需要成对证明：相同缺资料输入，后台结束本轮且不提问、不等待；主动交流允许必要问答，明确答案更新个人信息，仅在有原推荐请求时续做；普通更新不推荐；重复提交不重复执行，取消/中断如实结束，已保存信息供后续请求使用。先使用隔离调用方验证这些服务责任，再以本地 DSH 验证实际接入，Telegram 填写体验另验。
- A01 的真实内容价值和新增认识、纠正、反馈后的实际使用效果仍需对应真实材料与用户判断；本轮未获取新 Feed，也未把历史待验项改成通过。


## 2026-09-07 V0 当前工作树开发与自验

本节按新版验收台分支记录，前文旧 A11 编号与旧 PASS 不代替本节。执行计划、最小设计、候选指纹与运行方式集中在 [v0-execution.md](v0-execution.md)。本轮未修改用户验收台中的业务通过记录。

### 验收台导出与恢复

使用原 HTML 字节相同的 `/tmp/personal-feed-v0-ui/index.html`，Chrome 独立 loopback `127.0.0.1:48627`，保存 1 条 wait 状态的 UI 测试记录，标记 `V0-UI-ROUNDTRIP-20260907`。实际导出的 Markdown 已核验用例章节及测试标记；JSON 已核验唯一尝试和 wait 类别。证据副本：`/tmp/personal-feed-v0-ui/PersonalFeed-验收记录-2026-09-07.md`、`/tmp/personal-feed-v0-ui/backup.json`。

恢复导入在 filechooser.setFiles 阶段被 Chrome 扩展的本地文件权限拒绝，应用导入逻辑没有执行，因此恢复仍待验。已关闭本轮测试标签页并终止该确切临时 HTTP 进程；隔离副本/下载文件保留复核，原页面与用户记录未修改。


### V0 最终候选的主负责人受控自验（15:37 +08:00）

候选位于 `/home/herman/Projects/personal-feed` 完整 dirty 工作树，运行/测试/依赖清单 SHA-256 `fe7d618d7b9ff8c7a67e4f4b22a7ccbc8d44085db11f51fe60b9aa09fb625a5c`，详情与复验命令见 [执行记录](v0-execution.md)。独立 reviewer 三项返修均关闭后，主负责人全检 330 TS / 36 Python、类型检查、构建通过；并亲自发起以下六组实际 HTTP MCP 调用。它们均为隔离受控来源/模型，fixture 链接不能当作 A01 真实原文。

| 用例分支 / fixture | 初次实际结果 | 同服务解除故障后 |
| --- | --- | --- |
| A11-1 局部正文不足 / partial_body_shortage | one_link，保留后续 102，limitations=material_insufficient | one_link 202，无限制 |
| A11-1 单条判断失败 / single_judgement_failure | 首条模型503，后续102为one_link，limitations=judgement_incomplete | one_link 202，无限制 |
| A11-2 整体来源失败 / whole_source_failure | incomplete / source_window / observation_failed，无链接 | one_link 202，无限制 |
| A11-2 全部正文不足 / all_body_insufficient | incomplete / source_window / material_insufficient，无链接 | one_link 202，无限制 |
| A11-2 整体判断失败 / whole_judgement_failure | incomplete / judgement_execution，无链接 | one_link 202，无限制 |
| A02 专用空状态直接发现 / empty_context_direct_discovery | 无问答，one_link 101 | one_link 202，无限制 |

连接分别为 `127.0.0.1:35043 / 42747 / 39899 / 39225 / 41371 / 43821`，端点均 `/mcp`，现已关闭。每组独立 stateDir 与完整可读/结构化结果、模型/来源事件保存在 [controlled-calls.json](/tmp/personal-feed-v0-evidence/controlled-calls.json)。每次前置均为空 facts / generation=0；六组均未更改个人了解，没有 observe/assess 模型调用；五个工具均可列出，解除故障后复用原 MCP 连接成功。临时状态均已删除，全部客户端/服务/fixture 已关闭。

A15 在第一组恢复后的实际链接上执行：save→saved，重复save→already_saved，list→completed且仅一条202，unsave→unsaved，重复unsave→already_unsaved，list→completed且空。个人状态始终不变；该结果是收藏兼容回归，不证明兴趣学习，也没有把收藏写入个人了解。

取消/超时由最终 HTTP 与 elicitation 定向及全检覆盖：前三工具如实 incomplete；收藏/列表未新增结果类别，超时通过当前请求的传输失败结束；同 session 另一问答及后续调用正常。服务关闭已以真实SDK复现并修复客户端pending反例，不能将这些发现范围证据扩称 V1 的 A11-3 全路径通过。

当前判定：**实现与受控自验完成／真实接入待验**。A01 未产生真实原文，A02 真实空状态分支尚未调用；没有替用户勾选价值或业务通过。一次最终候选真实模型/X发现的具体步骤与影响已准备在执行记录，等待该外部动作授权。验收台报告导出成功，备份恢复仍在浏览器本地文件权限处阻塞。原有历史失败和待验项全部保留。
