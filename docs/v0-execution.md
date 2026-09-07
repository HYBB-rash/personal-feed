# Personal Feed V0 执行记录

核对时间：2026-09-07 14:19 +08:00。负责人：当前主会话。

当前状态（2026-09-07 15:37 +08:00）：V0 S1/S2 实现、独立 review 及最终受控自验完成；真实接入待验，尚不能称 V0 已可交付用户验收。最终完整检查为 330 TS / 36 Python、类型检查、构建通过；当前候选及边界见文末。此前工具能力和待执行表述均属历史记录。

以下基线、测试与进程盘点为首次只读接手时记录；后续执行以文末续记为准。

本文件是本轮唯一工作记录。目标仍引用[渐进开发计划](/home/herman/Documents/Repo/Projects/DSHPlugins/个人Feed/需求V2-渐进开发计划.md)，不复制或重开全局门禁。后续最小设计和执行证据索引追加在本文件；业务证据沿用 [v2-acceptance-2026-09-06.md](v2-acceptance-2026-09-06.md)。资料库原文及验收台用户记录未修改。

## 基线与依据

- 主机 `nixos`；checkout `/home/herman/Projects/personal-feed`；分支 `main`，相对 `origin/main` 领先 12；HEAD `1d6ec6f32bca1c95cb84bc908cef42c8f350ed38`。HEAD 不是完整候选，权威是含未提交及未跟踪文件的当前工作树。
- 接手前已有 30 个 tracked 修改文件、10 个 untracked 文件。`git diff --stat` 为 729 insertions / 871 deletions，仅表示相对 HEAD 的既有 tracked 差异，不属于本轮成果。本轮只新增本文件，不 stage、commit、reset、clean 或建立漏掉 dirty 基线的新 worktree。
- 相关未跟踪实现已纳入核对：`src/interaction.ts`、`tests/native-interaction.spec.ts`、`tests/service/elicitation.spec.ts`。另外 7 个既有未跟踪文档保留；没有用历史结论代替源码。
- 已读适用规范：`/home/herman/AGENTS.md`、仓库 `AGENTS.md`；仓库内未找到嵌套 AGENTS。已读协作 Skill 及其 `references/COORDINATION.md`。
- 已读目标：渐进计划、需求定义 V2、第二版系统架构、第二版最小系统设计、当前用户验收台全部内容。原计划的 S1/S2 优先于 V2 后续范围；不实现 S3-S6。
- `~/.agents/skills` 跟随链接列举得到 9 份 SKILL.md，读取实际 name/description 并检索全文中的“哲学 / philosophy / 软件开发”，没有定位到用户记忆中的 Skill。现有名称：`agent-orchestration`、`chrome-research`、`first-principles-gate`、`nix-agent`、`nix-agent-init`、`nix-dev-base`、`personal-feed`、`requirement-definition`、`vertical-split-postcard`。未声称其中任何一个是“软件开发哲学”，未安装或创建替代 Skill。
- 用户已明确允许以仓库 AGENTS、已确认的 V2 文档及本次交接约束作为替代依据继续设计开发；Skill 缺失仍如实保留，不再阻塞设计。

六个源码指纹与渐进计划逐一一致：

| 文件 | SHA-256 |
| --- | --- |
| `src/application.ts` | `7228e58f90934948fc5ba111ea3ab83d7577ee9bb1a0bf65fff46965d9af7685` |
| `src/service/mcp.ts` | `3185124586592228616a53442442fc926499273528837a3136f34fe55510a32c` |
| `src/python-x-observer.ts` | `90aee7a9e25bcd8877bc1b1860712af1777acf1558efbeaf585a58c2013b6733` |
| `python/x_personal_feed_observer.py` | `3908fcda0d5d5f89ae534e1d8d2ebff00cf54baf1d7e4000b6c67faed529ad40` |
| `python/x_personal_feed_observer_cli.py` | `6cdcb471daa82d124cdbfae5aa329e56891aa0f9a725a64cb7b4b6c178963941` |
| `src/openai-compatible-model.ts` | `5989c4453d3bb08dad852c53e6d641e011543fa2820fc5342f39c615bf952de5` |

当前验收台 SHA-256 为 `9efafa4adae831e45958bf78e95ad0014d0195789d7aac0dded1704e1d302d20`，不同于原计划的 `f0e051...`；已重读当前文件，不推测修改原因。DATA revision 仍是 `2026-09-07-exploration-acceptance-1`，共 20 项。报告导出与备份恢复仅读过实现，尚未在隔离浏览器副本操作验证。

## 当前代码差额

| 当前工作树事实 | V0 要求与最小核验入口 |
| --- | --- |
| `src/application.ts:346` 的 interactive request 调用准备问答，background request 要求 include 兴趣及 asserted 认识并调用 assessContext | 空或部分不确定了解也直接发现；`feed-selection`、`context-acceptance`、`native-interaction` 新行为 RED；定时模板不写入画像 |
| `src/openai-compatible-model.ts` 的 JUDGMENT_SYSTEM / decodeJudgment 和 `src/model-response-schema.ts` 要求三个严格门槛，unknown 增量直接 incomplete | 放宽发现准则和必要解码；不扩大反馈重构；模型适配及 strict output 测试 |
| Python `_surface_observe` 能取得可信 occurrences，但 `observe` 遇非 complete 面立即退出，`_incomplete` 只序列化状态、不保留正文 | Python 本身保留可信部分及限制；坏面之后的可用材料边界也需测试，不能只改 TS |
| `src/python-x-observer.ts:110` 在 incomplete wire 上立即结束；validSurfaces 禁止其携带 occurrences；单条 insufficient 导致全部候选丢弃 | 先冻结 Python → TS → 应用交接样例，然后穿透验证；整体结构不可信仍不得拼凑材料 |
| `src/application.ts` 的循环遇单条抛错或 incomplete 立即返回；uniqueCandidates 遇一条无效也整批退出 | A11-1 两分支分别保住后续好候选，返回真实 URL 和必要限制；整体来源/材料/判断失败分别核验 |
| 应用加载所有 `candidates.jsonl` 标识作永久过滤，成功判断后续写该账本 | 取消永久准入屏蔽及无用途续写，只保留本次必要去重；旧文件不删、不迁移，不新增 TTL、已展示池 |
| 应用耗尽候选直接 business_empty；one_link 与 MCP 校验均没有限制字段 | V0 无兴趣结果须明确后续探索尚未就绪，用既有类别；V1 可直接删过渡分支，不建开关 |
| `src/service/mcp.ts` blanket catch 覆盖 generic Error、输出校验、取消及日志异常；`server.ts` 本地 abort 与客户端协议取消不同 | S1 首先验证按工具、按失败来源的合法结束；收藏/列表没有 incomplete，不可套统一 fallback；日志异常不得推翻成功 |
| recordFeedback/listSaved 只在入队前查 signal；收藏已有幂等与独立状态路径 | 契约实验核对排队、提交、客户端取消、本地 timer、关闭；保留 A15 语义，不把内部错误伪报成功或存储故障 |
| `tests/service/acceptance-boundaries.spec.ts` 用旧 A11-1/2/3 指代整体来源/partial/正文不足，fixture 预填画像 | 以当前验收台分支含义重新映射，新增专用空状态和局部成功；旧测试名/旧 PASS 不是新版覆盖证明 |

这些是阅读所得事实，不是已运行的新行为失败证据。现有反馈 changes、精确替换、generation 保护、收藏及 native interaction 的非发现用途保留；不顺手删掉 V1 尚需的更新行为。

## 执行依赖与 Owner

以下是计划分配，不表示子 Agent 已启动或已接受写入权。开发写入者最多两个，总活跃 Agent 最多四个；主负责人不同时修改 owner 文件。

| 顺序 | 结果与依赖 | 唯一 owner / 文件边界 |
| --- | --- | --- |
| 0 | 取得 Skill 替代依据确认；核实可用模型配置和子 Agent 文件/Nix/指定测试能力 | 主负责人；当前只写本记录 |
| 1 | 核心 owner 先给基于当前代码的最小设计：调用/数据流、接口差额、错误/取消语义、2-3 个反例；随后 S1 最小契约实验及门槛 RED/GREEN | 核心 owner：`src/application.ts`（含共享类型）、`src/openai-compatible-model.ts`、`src/model-response-schema.ts`、`src/service/{mcp,server,contracts}.ts`、必要的 `src/{main,index,interaction,errors}.ts`；对应 TS 测试，但不含来源 owner 的适配测试 |
| 2 | 先冻结一个可信 partial wire → XObservation → 应用结果样例，再允许两 owner 并行；不在本次只读准备中提前选 schema | 核心 owner 独占共享 TS 类型及 `tests/fixtures/v2-boundaries.ts`；主负责人在本记录确认交接，不抢写实现 |
| 3 | Python partial 保留 → TS 适配最小 RED/GREEN；与核心应用工作按冻结合同并行 | 来源 owner：`python/x_personal_feed_observer.py`、`python/x_personal_feed_observer_cli.py`、对应两个 `python/test_*.py`、`src/python-x-observer.ts`、`tests/python-x-observer.spec.ts` |
| 4 | 应用逐条失败继续、移除 processed 过滤、V0 无结果过渡；CLI/HTTP 受控贯通及 A15/取消回归 | 核心 owner，含 `tests/service/acceptance-boundaries.spec.ts`；跨层问题交主负责人协调，修正返原 owner |
| 5 | 最终候选形成后才启动新上下文只读 reviewer，按文件位置/可达失败/影响返回；原 owner 修复后主负责人复核必要检查 | 独立 reviewer 无可写文件；不得把实现者“已通过”作为审查前提 |
| 6 | 本版逐分支自验、真实原文核对、隔离验收台导出/恢复、交用户复验；达到 V0 即停止 | 主负责人维护本记录及已有验收证据；说明未验及恢复，不勾用户业务通过 |

新增共享 fixture/文件在创建前指定唯一 owner；其他 TS 测试必要改动由核心 owner 逐项列入派工，来源以外 Python 文件不得默认扩权。重叠串行；转移前结束原任务。仓库外及已安装用户 Skill 本版不修改。

每次实际派工将包含六项：结果与停止点；当前候选和最少上下文；独占可写文件；只读/禁止范围；最小 RED 与验收证据；结果返回位置和后续 owner。必须写入：“你不是代码库中的唯一 Agent；不要回滚他人修改，遇到重叠先交回主负责人协调。”

原生工具能力：`subagent_spawn` 存在，支持 `model` 和模板；无 reasoning 参数，模板当前均跟随主会话模型。尚未获得 Astra/Sol/Terra 的可核实 provider/model ID，也无法核实主会话是 Astra/high，故不猜 ID 或声称 high 已设置。获准开发后须在派工前报告实际可用配置及调整，再验证子 Agent 的读文件、Nix、测试能力；提示词写 high 不算真实设置。此工具会在侧栏显示原生子对话，结果回主负责人，不额外创建任务平台。当前没有启动子 Agent，未冒充多 Agent 实现或独立评审。

## 验证与停止点

| 分支 | 所需证据 | 当前状态 |
| --- | --- | --- |
| A01 | 同一确切候选真实路径自主取得 URL，主负责人打开核对内容；价值由用户判断 | 未开始，无真实原文样本 |
| A02 直接发现 | 专用空状态，不问画像、不由 Agent 代搜，取得内容 | 未开始；整项含探索，V0 不称整项完成 |
| A11-1 局部正文不足 | Python 保留 → TS 接收 → 应用返回后续好条目及限制；恢复后核实 | 未开始 |
| A11-1 单条判断失败 | 前条失败、后条合适，返回后者；恢复后核实 | 未开始 |
| A11-2 整体来源/全正文不足/整体判断失败 | 三种 fixture 分别结束为准确未完成，无假链接、无伪正常空；每分支恢复 | 未开始 |
| 原发现取消/超时 | 客户端取消与服务 timer 分开验证，有界结束、不自动重试；收藏/列表合法边界另验 | 未开始；A11-3 两阶段全路径留 V1 |
| A15 | save/list/unsave/list 与重复操作，收藏不写兴趣/认识 | 未开始 |
| 验收台辅助功能 | 隔离副本导出 Markdown 文件核验、JSON 备份与实际导入恢复，不动原记录 | 仅静态阅读，未操作 |

每个行为先新增最小失败测试并实际观察 RED，再实现 GREEN。先定向测试，再类型检查；最终候选一次 `nix develop --command pnpm check`（typecheck + TS tests + Python tests + build），后续只因改动/失败扩大或重跑相关范围。不沿用历史测试数量。计划命令形状（尚未运行行为测试）：

```sh
nix develop --command pnpm exec vitest run tests/service/mcp-handoff.spec.ts -t '<新增契约行为名>'
nix develop --command pnpm exec vitest run tests/feed-selection.spec.ts -t '<新增空状态或局部失败行为名>'
nix develop --command python -m unittest discover -s python -p test_x_personal_feed_observer.py -k '<新增partial行为名>'
nix develop --command pnpm exec vitest run tests/python-x-observer.spec.ts -t '<新增交接行为名>'
nix develop --command pnpm exec vitest run tests/service/acceptance-boundaries.spec.ts
nix develop --command pnpm typecheck
nix develop --command pnpm check
```

实际只执行了 pinned Nix 工具版本检查，退出 0：Node `v24.19.0`、pnpm `10.15.0`、Python `3.14.7`、Vitest `3.2.7`、TypeScript `5.9.3`。没有运行本轮 typecheck、业务测试、契约实验或真实服务。

依赖定位指纹：`flake.lock` = `ab726e07664de128146370393658c33d05692addb23dc2d3f266c667e76dad8c`；`pnpm-lock.yaml` = `2b735708722c124b737503f8d4eac1f944fe2b8a944a5d2b13fd5b6cc3a3b797`。

## 真实接入与恢复

当前会话没有可确认的真实模型调用、共享 X 浏览器操作、用户服务启停或安装/状态升级授权；本轮未调用它们，也没有读取模型凭证或日常状态。待候选形成后准备确切动作与影响，再只请求必要授权，不提前索取全部权限。

源码显示真实路径需现有 Chrome CDP `127.0.0.1:9222`、可用 X 登录、模型配置、独立 stateDir、MCP token 和可用 loopback 端口。源码默认工具 timer 为 300000ms、模型请求 30000ms、Python observer 90000ms，这些不是已核实运行配置或完整取消合同。`/readyz` 不证明 X/模型可用。专用状态不隔离共享 X 页面导航；真实观察可能复用现有页，缺页时现有代码可新建 X 标签页，须在动作授权中说明。

真实自验记录必须含候选/checkout、实际 MCP 连接与专用状态、场景、预期、实际、证据位置、恢复情况。受控验证只用临时目录、假进程和 loopback fixture，不接触真实 home、用户 systemd、浏览器账号、模型端点或其他宿主安装。不记录用户文本、X 正文、完整 URL 或秘密到运行日志；人工原文证据不改变日志规则。

真实条件缺失时，可在获准设计开发后继续完成实现、受控验证和独立 review，但最终状态只能是“实现完成 / 真实接入待验”，不能称 V0 已可交付验收。本轮连实现也尚未开始。

收尾盘点：无子 Agent；本轮一-shot 工具命令已结束，无本轮启动的服务/后台进程。工具列出一个既有“终端 1”（ID `f1125b34-17b1-4525-b8bc-c678075c00db`），本轮未操作，不关闭用户终端。用户数据、原验收记录及既有 dirty 修改均保留。

## 获准后执行续记

- 用户确认替代依据后启动原生只读核心预检/设计任务 `sa-5398a587`。工具支持默认子 Agent，但没有 reasoning 参数或可确认的要求模型 ID，已向用户说明实际调整及侧栏可见性。先执行一个既有 MCP 测试确认子 Agent 文件/Nix/测试能力；本阶段没有写入者。
- 最小设计返回后由主负责人落入本记录，核心 owner 开始 S1 最小契约 RED/GREEN；Python→TS→应用样例冻结后才允许来源 owner 并行。所有新增共享类型和 fixture 归核心 owner。未推进 V1。


## 2026-09-07 当前任务接手续记

- 已重读交接提示词、V2 三份目标文档、渐进计划、适用 AGENTS 与 agent-orchestration 协作规则；延续以上计划和文件所有权，不另开计划。当前 checkout / HEAD / dirty 文件与上述基线吻合，其他可见项目任务处于 idle；当前原生 Agent 清单只有主负责人。
- 修改前完整文件副本与 SHA-256 清单：`/tmp/personal-feed-v0-baseline-qrjcriny/{tree,manifest.json,status.txt}`。用于分辨本轮增量和既有 dirty，不能代替最终候选。
- 主负责人 pinned Nix 能力检查：`nix develop --command pnpm exec vitest run tests/service/mcp-handoff.spec.ts`，44/44 通过；这只是现有合同基线，不是新行为验收。
- 本轮开发方式：保留当前完整 dirty checkout，按文件独占写入；核心 Sol/high，来源 Terra/high，review Sol/high 新上下文。原生子 Agent 结果回主负责人，不创建侧边栏任务。
- 本轮真实动作授权仍仅涵盖开发及隔离受控验证；候选形成后再明确真实模型/共享 X 自验的具体步骤与影响。

### 验收台辅助功能实测

- 原 HTML 复制为 `/tmp/personal-feed-v0-ui/index.html`，独立 loopback `127.0.0.1:48627`，Chrome 新测试页，初始 0/20。只保存一条明确标为 `wait` 的 UI 测试记录（标记 `V0-UI-ROUNDTRIP-20260907`），未勾产品通过，未动原页面或日常记录。
- 实际点击“导出报告”和“备份进度”，下载文件已读回：`/tmp/personal-feed-v0-ui/PersonalFeed-验收记录-2026-09-07.md` 包含标记和用例章节；`/tmp/personal-feed-v0-ui/backup.json` 含 1 条 wait 尝试。
- 恢复：先将隔离副本版本改为 `RESTORE-BEFORE-MARKER`，点击恢复后成功取得 filechooser，但 `setFiles` 被 Chrome 扩展拒绝 `Not allowed`，未能到达应用导入或确认步骤。工具指引要求给扩展开启 Allow access to file URLs；本轮未修改扩展权限。**报告导出已核验；备份恢复仍待浏览器权限就绪后复验。**

### 冻结的最小跨层设计（实现前）

复用当前 observer → Python wire → TS XObserver → application → MCP，不新增服务、模块平台或长期状态。核心 owner 独占共享类型；来源 owner 只消费该类型。

```text
Python schemaVersion:1 / kind:incomplete
  for_you partial + 可信 occurrences（原 sourceUrl/author/publishedAt/body）
  following failed（无 occurrences）
  explore unknown（无 occurrences）
TS → {status:'incomplete',stage:'source_window',reason:'partial_observation',
      candidates:[可信原文候选],limitations:['partial_observation']}
应用 → 逐条判断 → {status:'one_link',url:实际候选canonicalUrl,
                  limitations:['partial_observation','judgement_incomplete']}
```

- `partial|complete|natural_zero` 面可带已验证 occurrences 和现有时间字段；natural_zero 数组必须空；failed/unknown 禁止 occurrences。请求身份、三面顺序、任一条目结构不可信时整包 observation_failed，不拼任意残片。
- `XObservation` incomplete 分支兼容增加 candidates/limitations 可选字段；observation_failed 不带候选。有可信可用条目时携带来源限制数组，枚举为 partial_observation / material_insufficient，可同时存在。无可用候选时保留既有 stage/reason；主 reason 优先 partial_observation，再 material_insufficient，具体整体正文不足例需实测。
- `one_link` 可选 `limitations` 数组仅含 partial_observation / material_insufficient / judgement_incomplete，去重；无问题省略。用一个字段同时表达两类局部问题，不新增顶层类别，不用日志替代用户可见限制。
- 请求只读取本次个人了解快照（允许空、uncertain），不将调用模板写入事实，不做充分性评估/表单。自愿更新仍走独立原入口。
- 单条判断失败继续；取消/整次 signal abort 立即终止，不拿 partial 绕过截止。耗尽兴趣候选无结果时使用既有 incomplete 类别说明 V0 后续探索未就绪，V1 直接删除该过渡分支。
- 移除历史 processed 的读取屏蔽与无用途判断账续写，只保留本次去重；旧文件原样保留，不建立替代池或 TTL。

区分行为的例子：① failed 面夹带正文 → 整包拒绝；② insufficient 条目后有好条目 → 返回后者并标正文不足；③ 首条判断抛错、次条合适 → 返回次条并标判断局部失败；④ partial 与判断失败并存 → 两项限制都保留。

S1 按工具的错误与取消最小实验由核心 owner 先完成，再落实现；收藏/列表没有 incomplete，禁止统一fallback。客户端协议取消、本地timer、服务关闭和提交完成必须分别留证。

### 角色预检与 S1 实验进展

- 核心 `/root/core`，实际派工参数 `gpt-5.6-sol/high`，定向原测试 `mcp-handoff -t 'retains the needs_input category without cross-call tokens'` 1 passed / 43 skipped；文件可读，Nix 可执行。共享 SourceLimitation/FeedLimitation 与 one_link limitations 已经新测试 RED→GREEN。
- 来源 `/root/source`，实际 `gpt-5.6-terra/high`：Python observer 基线 11/11、TS adapter 10/10，均 pinned Nix。执行前给出单总 deadline、可信面保留、非法整包拒绝设计，开始 RED。
- 核心提出收藏/列表停用本地 timer、generic 保留 isError；主负责人否决：会突破本轮有界结束与仅三种 MCP 错误约束，**没有批准该方案实施**。
- 根据已发现的跨层合同冲突，增派 `/root/cancel_contract`，实际 `gpt-6-astra/xhigh`，仅只读 SDK/服务并允许 /tmp 受控实验，不写仓库。总活跃 4、代码写入者 2。其初步 SDK 事实：SSE POST headers 之后正常 EOF/stream error 不必结束对应 callTool，故仅 close/destroy 不足以证明 timer 内结束；继续核实最小可行接缝，不以理论关闭代替实验。

S1 有界分析得出的最小接缝：仅对 record_feedback/list_saved 当前 HTTP 响应推迟 flushHeaders，并关闭该 transport 的 SSE keepalive；首次正常结果或允许的 MCP error write 仍自动发出响应头。timer/关闭/未分类内部异常时先销毁当前 response，再 closeSSEStream(requestId)，SDK 随后的 missing-stream 分支清理 mappings。不能只正常关闭 SSE（客户端可能仍等自己的 timeout），也不能伪写业务结果。HTTP 路由标识只留适配层内存。分析工具实验：普通 SSE EOF/销毁在 160ms 仍 pending、350ms 才客户端 RequestTimeout；延迟 flush 后约 42ms reject fetch TypeError，正常保存约 42ms 返回 saved；mapping 清理 size 0。仓库实现和并发/取消/关闭回归仍由 core 后续证明，分析不是产品实现通过。分析临时进程已退出。

### 来源 owner 定向结果（整合前）

来源 owner 返回 Python observer 13/13、Python CLI 18/18、TS adapter 12/12 定向通过。包含已拿到正文后同面失败、首面 partial 后后续可用、单面 navigate/probe 失败继续，以及截止后停止。wire 校验增加精确字段、ISO时间、URL与authorHandle一致性；整体身份/结构不可信仍拒绝。当时 typecheck 两处失败位于 core 正在编辑的 application sourceLimitations optional 处理，已交 core，不能把来源定向绿灯当作整仓通过。

来源最终交回（已停写）：

- RED：两个新的 Python 局部恢复反例在旧代码报 `KeyError: occurrences`；TS “正文不足仍保好条目”深度比较失败，实际缺 candidates/limitations。failed face 夹带正文的旧拒绝行为仍保留。
- GREEN：`nix develop --command python -m unittest discover -s python -p test_x_personal_feed_observer.py` 13/13；对应 CLI 文件 18/18；`nix develop --command pnpm exec vitest run tests/python-x-observer.spec.ts` 12/12；`nix develop --command pnpm test:python` 36/36；diff --check 0。
- 实际改动 5 文件：`python/x_personal_feed_observer.py`、两份 observer/CLI Python tests、`src/python-x-observer.ts`、`tests/python-x-observer.spec.ts`。CLI 生产代码现有身份透传已足够，无需额外改动。
- 此阶段未做真实 X/模型调用。来源 owner 保持可接受原责任返修，不再后台写入。

### 真实自验准备（只读，尚未调用）

当前本机 `personal-feed.service` active，PID 3451873，43180 有监听；CDP 9222 有监听。当前 EnvironmentFile 为 `/home/herman/.config/personal-feed/manual-a02-2-20260907T083643.env`，只核对模型配置键存在且可读，未输出秘密、未调用端点。以上只证明本机入口/配置可定位，不证明运行版本等于本候选、X登录有效或模型可用；日常服务未启停。

候选稳定后的最小真实自验：使用最终源码/构建，独立临时状态与随机 loopback MCP端口、临时MCP token；仅沿用已配置模型连接，执行一次空状态发现（最多现有总上界300秒），打开该次组件自行返回的原文核对。结束只停止本轮确切临时进程；不替换43180日常服务，不升级/合并/推送，不写日常个人状态。共享X浏览器会被导航，缺可用时间线时会按现有代码开一个X页；专用stateDir不隔离共享浏览器，也不会自动共用不同stateDir的导航锁，真实操作前需确保该次共享使用范围。上述真实模型/共享X动作尚未获本会话明确授权，待实现、review、受控自验完成后提出具体动作请求。

核心受控贯通已交回的场景名：`partial_body_shortage`、`single_judgement_failure`、`whole_source_failure`、`all_body_insufficient`、`whole_judgement_failure`、`empty_context_direct_discovery`，六场景同服务 recover 均返回 one_link。此为开发 owner 的定向验证；主负责人准备的 `/tmp/personal-feed-v0-controlled.mjs` 将在最终候选独立 review 后复用同一 fixture，逐场景设专用空context并记录连接/结果/恢复，同时做 A15 与状态/日志检查，不新造第二套fixture。

来源证据复核更正：owner 明确实际 RED 仅覆盖 partial 正文保留与不足条目夹好条目；精确字段、严格ISO日期、authorHandle与URL一致性是额外收紧，没有对应新反例或先失败证据，不能声称已TDD。主负责人决定删除这些非V0必要增量，退回原owner局部撤回这些guard（不恢复整份文件），保留旧有条目校验及新的partial面合同，完成后重跑adapter定向。此前“严格时间/作者身份都可信”的表述不作为最终候选能力声明。结构可信在最终合同指实际已校验的请求身份、三面顺序、合法面种类、occurrences与body等原有形状和URL格式，不额外宣称完整语义验证。

### 核心 owner 最终交回与评审候选

- core 运行增量仅 `src/application.ts`、`src/openai-compatible-model.ts`、`src/service/mcp.ts`、`src/service/server.ts`；model-response-schema/main/index 的 dirty 是接手前已有实现，不包装为本轮新增。
- RED/GREEN：logger异常2 fail→2 pass；前三工具异常/非法输出/timeout 27 fail→29 pass；来源/判断中止与排队收藏取消7 fail→7 pass；旧acceptance 7 fail→新版6场景通过。无画像、limits、单条失败、processed移除、unknown判断及V0无探索均已定向先失败后通过（细节在原生core结果）。save/list timer与服务close原先客户端仍pending，最终及时transport failure。
- core整合前完整TS：24文件/322项、typecheck、diff-check均过；随后仅一处中文提示改动做对应1/1。主负责人最终 pnpm check 尚未运行，不能将此前TS全绿代替最终候选全检。
- 首次可审候选清单 `/tmp/personal-feed-v0-evidence/candidate-manifest.json`，清单SHA256 `32ff6aa5bede4f0c6bdea5fdbe88c4030df7711d45b6277d6c3729cb8d1f2a46`；本轮差异 `/tmp/personal-feed-v0-evidence/increment.patch`。清单覆盖运行、测试、pinned依赖配置；不含持续更新的文档。修改后须刷新。
- `/root/review` 已按实际参数 gpt-5.6-sol/high、新上下文启动只读独立review，运行写入者停写。主负责人在模型差异中发现 prompt 与 decoder 对兴趣 unknown 后第三项的约定可能冲突，已交reviewer独立核实，未抢写core文件。

### 独立 review 首轮发现及返修

Reviewer 用新的只读上下文独立复现两项：

1. **V0 blocking**：新提示词允许 pass/unknown/unknown，但 decoder 只放行 pass/unknown/not_reached；受控fetch确实返回 incomplete，空画像可能仍被判断门槛阻断。开发测试只覆盖旧组合，不足以支撑新提示词的真实输出。
2. **长连接资源问题**：save/list 在 Zod 输入校验之前登记 pendingResponses，非法输入不进入 handler/finally，已结束 response 仍保留至连接关闭。黑盒实测 invalid record 后 close 才多一次 destroy（0→1），重复非法请求可累积引用。

已交 core 原owner先补最小RED再修复；同时补“同session收藏超时与另一elicitation正常完成”的组合回归。reviewer继续其余只读检查，修复后仅复核相关最终差异。首轮候选清单保留为 `/tmp/personal-feed-v0-evidence/candidate-before-review-manifest.json`，最终指纹待返修完成刷新。

独立review第三项S1 blocking：服务close只等待被track的application promise，早于完整MCP handler响应发送；前三工具已发SSE headers，关闭连接不使SDK对应callTool结算。reviewer真实SDK/HTTP probe得到 `{afterCall:{kind:'pending'},afterClose:'closed'}`，关闭后500ms仍pending，另一个初始probe挂到30s后仅终止其自有临时进程。已交core补最小RED，修正服务关闭必须覆盖实际响应完成的时序；不得以应用Promise完成冒充客户端已结束。


### 最终 review、全检与候选（2026-09-07 15:37 +08:00）

三项原始反例均由 core 原 owner 补 RED 后修复，reviewer 以独立 probe 和回归重新确认：

1. 判断 prompt/decoder 对齐：value=pass 后 interest=pass 或 unknown 均继续接受 increment=pass 或 unknown；合法短路只包括 fail/not_reached/not_reached 与 pass/fail/not_reached。五个解码反例先失败后通过。
2. save/list 的 pending response 在 finish/close 时卸载，即使 Zod 拒绝输入、未进入 handler 也清理，不再等 session 关闭积累引用。
3. service.close 的宽限等待覆盖实际 HTTP response 完成；前三工具的 shutdown/cancelled 结果能在断开前到达 SDK。四个 HTTP 反例先失败后通过。真正重叠的同 session 收藏超时与 elicitation 回答可各自结束，后续 listTools 正常。

只读 reviewer 最终结论：没有剩余阻断，三项原反例和并发组合独立复测通过；TS 182 / Python 31 / adapter 12 / typecheck / diff-check 为定向证据，不冒充全量。随后主负责人亲自运行最终 `nix develop --command pnpm check`：24 文件、330 TS、36 Python、类型检查、构建全部成功（exit 0）。构建仍有既有 tsdown `define` 选项告警；未新增构建配置改动。最终 `git diff --check` 通过。

最终运行/测试/依赖候选共 56 文件：[/tmp/personal-feed-v0-evidence/candidate-manifest.json](/tmp/personal-feed-v0-evidence/candidate-manifest.json)，该清单 SHA-256 为 `fe7d618d7b9ff8c7a67e4f4b22a7ccbc8d44085db11f51fe60b9aa09fb625a5c`。当前 checkout 仍为 `/home/herman/Projects/personal-feed`，HEAD `1d6ec6f32bca1c95cb84bc908cef42c8f350ed38`，权威候选包括已有 dirty；不是已安装 43180 服务版本。清单不含持续更新文档及生成 lib，以免自引用；最终 lib 来自本次通过的构建。

本轮实际增量以接手快照逐文件比较，见 [changed-since-start.json](/tmp/personal-feed-v0-evidence/changed-since-start.json) 与 [increment.patch](/tmp/personal-feed-v0-evidence/increment.patch)。运行改动为核心四文件、TS observer 适配和 Python observer；其他为对应测试、README/MCP/Skill 说明及两份既有记录。接手前已有的 interaction、main/index/model-response-schema 等未作为本轮新增成果；没有创建分支、提交、推送或更换日常服务。

### 主负责人隔离自验与复验方式

亲自通过现有 fixture 的实际 CLI serve → loopback HTTP MCP → application → 受控模型与 Python adapter，分别启动六个独立空状态。原始结构化/可读结果、连接地址、stateDir、模型/来源事件、恢复与 A15 回归见 [controlled-calls.json](/tmp/personal-feed-v0-evidence/controlled-calls.json)，分支判定见 [本轮验收节](v2-acceptance-2026-09-06.md#2026-09-07-v0-当前工作树开发与自验)。只出现 judge 模型事件，没有先做个人了解或充分性问答；六次个人状态均逐字节不变，检查的私密值均未出现在运行日志。这里只证明列出的受控数据检查，不宣称任意输入日志穷尽证明。

以下命令在该 checkout 的 pinned Nix 环境复验（无需真实账号或模型）：

```sh
nix develop --command pnpm check
nix develop --command pnpm exec vitest run tests/service/acceptance-boundaries.spec.ts tests/service/http.spec.ts tests/service/elicitation.spec.ts tests/python-x-observer.spec.ts
nix develop --command node --experimental-strip-types /tmp/personal-feed-v0-controlled.mjs
```

完整检查原始日志：[final-check.log](/tmp/personal-feed-v0-evidence/final-check.log)。最后一条为本轮人工调用记录 driver，复用仓库同一 fixture，保留在 /tmp；前两条是仓库内可长期复验入口。/tmp 清单、基线、patch、调用结果、UI 导出副本仅作本轮证据保留，系统清理临时目录后不保证存在；关键结果与命令已写入这两份仓库记录。

收尾：core/source/review/cancel_contract 四个原生子 Agent 全部 completed，写入者为零；最终测试与 driver 命令均 exit 0，六组临时状态均已删除、客户端与 fixture 服务已关闭。UI 测试页/服务器已关闭，未终止用户原有终端、日常 Feed 或浏览器。没有保留本轮后台任务、自动化或持续重试。

仍缺：A01 由最终候选取得并打开真实原文；A02 专用空状态真实发现；用户阅读价值判断；验收台备份导入恢复。真实自验已准备为独立临时服务、空状态、一次最长300秒请求，复用现有模型并会操作共享X页，结束仅关闭本轮服务；需按交接提示词第6节确认该真实模型/共享浏览器动作授权。未获授权前不调用。A02 整项与 A11-3 探索全路径留到 V1，不因此扩大本轮范围。


### 用户授权本地提交（2026-09-07）

用户在实现交付后明确要求“帮忙把代码先提交好”。提交前核对最终56文件候选清单及31文件本轮增量，均无漂移；延用刚完成的330 TS / 36 Python、类型检查和构建证据，不把提交动作当作真实验收。

本地提交包含完整可运行的 V0 代码、测试、当前合同及本执行/验收记录；其中原生交互、模型schema、main/index和相应测试等依赖是接手前已有修改，完整承接而不冒称本轮新增。其余7份未跟踪调研/历史记录保持未提交。该授权只推进本地提交；真实模型/X自验、推送和服务切换仍未执行。
