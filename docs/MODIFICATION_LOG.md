# 修改记录

记录用户提出并已落地的修改。后续每次完成用户请求后，在本文件追加一条记录。

## 2026-08-14

- 新增子任务等待 watchdog：父任务在等待子任务时按 30 秒轮询，子任务运行 60 秒后开始巡检；连续 120 秒没有新的工具事件、shell stdout/stderr 增量、测试输出或进程状态变化时自动中断，并将终态标记为 `interrupted`，保留已有消息、工具结果和中断原因。shell/test 有持续进展时可在 10 分钟后按 5 分钟窗口继续检查，但单个子任务总运行时间达到 30 分钟一定中断。子任务模型请求改为有限超时，主任务仍可由用户手动停止。终端输出事件现携带进度 heartbeat，子任务卡片会区分排队、启动、等待模型、执行 shell/test、重试、停滞和自动中断，并显示最近进度及自动中断倒计时。新增 watchdog 判定测试；`tests/agent-runtime.test.ts` 与 `tests/thread-ui-state.test.ts` 共 323 项通过。

- 优化主项目的 DeepSeek 兼容层，并仅将 `deepseek-harness` 作为实现参考：Provider 新增可持久化的 `deepseekProtocol` 配置。未配置或选择 `native` 时保持原有 DeepSeek 原生扩展行为；OpenAI 兼容 Provider 可在设置页选择“标准 OpenAI 兼容”，此模式不再发送 `thinking`、`reasoning_effort` 或工具调用历史中的 `reasoning_content`，以兼容拒绝 DeepSeek 私有字段的标准 Chat Completions 网关。DeepSeek 原生请求参数处理保留在 `packages/provider-adapters/src/models/deepseek.ts`，共享工具历史序列化在 `packages/provider-adapters/src/index.ts` 按该配置处理。新增 Provider 配置往返持久化和标准兼容协议回归测试；`tests/provider-adapters.test.ts`（147 项）与 `tests/model-storage.test.ts`（12 项）通过。

## 2026-08-11

- 修复生成 `.xlsx` 后被标准完成校验误判为“未交付、未验证”的问题：恢复 turn 现在会继承并只读复验已有的文件路径证据；项目工作区会针对用户明确请求的产物格式检测本轮由脚本生成的文件，普通对话恢复轮则仅复验当前任务输出目录；`.xlsx` 改为实际打开工作簿并抽取表名及前几行内容验证，而非仅检查文件大小。这样已生成且可读取的工作簿会直接进入交付证据链，不再触发模型重复流式生成。
- 调整普通对话完成策略：普通对话中的文本草稿、说明、清单和分析不再因为“创建/修改”等措辞触发项目文件交付与审计循环；只有用户明确要求 `.xlsx`、`.docx` 等文件产物时才要求文件存在并完成读取验证。
- 收紧普通对话文件写入权限：仅提及 Excel、Markdown 或格式词不再开放写工具；只有明确要求创建、生成、导出或保存为具体文件/文档/格式时才允许写入。单独要求运行脚本也不会间接获得 `fs.write_file`、`apply_patch`、重命名或删除文件能力。
- 调整普通对话的完全访问默认值：新建普通对话不再默认开启“完全访问”，空状态界面也不再预勾选；用户仍可通过菜单手动开启，项目模式的现有默认保持不变。
- 调整标准完成证据恢复：将“最终结果缺少执行证据”的恢复上限设为 5 次，兼容协议切换不再重置计数；第 5 次仍记录未满足的证据原因，但直接提交当前草稿为最终结果并跳过后续审计，不再因校验耗尽而中断任务。
- 修复偶发切换聊天后历史记录未加载：切换时使上一线程的未完成快照请求失效，并清除目标线程的增量游标以强制首次读取完整历史；异步渲染提交前再次核对当前选中线程，避免慢响应覆盖新对话的快照。

- 修复 Agent 决策 JSON 连续解析失败时在同一 turn 无限重试：每轮最多重试 5 次，第 5 次由内部 `agent.recover_protocol` 无感知地创建新 turn，并从已持久化的任务与工具证据继续；新轮重新获得 5 次预算。该恢复工具也可由模型主动调用，但不会产生用户消息、聊天气泡或确认弹窗。自动续跑最多 5 个新批次，避免无限循环。

- 简化工具完成后的运行状态：移除“决定下一步”措辞，改为直接展示当前读取、验证或其他后续处理状态。

- 修复模型在同一轮反复返回“无工具且未结束”的进度文案时被重复写入对话：普通模式和 GPA ACT 现在丢弃此类中间文本，并要求下一次决策明确调用一个新工具或以 `end_turn: true` 返回最终答复；工具绑定的进度消息和 GPA 目标/计划输出不受影响。

- 将标准完成校验恢复上限从 6 次调整为 10 次，将模型输出截断恢复上限从 2 次调整为 5 次，并同步更新测试断言。

- 修复长任务跟进上下文串线：参考 OpenAI Codex 的 thread/resume 与持久化 turn history 方式，后续请求只继承当前线程中同一 `turnRunId` 的上一轮用户请求和最终回复；产物主题校验改用结构化 `effectiveRequest` 提取 anchors，避免 WebForms 重定向任务错误继承 SAP 任务关键词并因 `matched 0` 被判定为无关产物；新增跨 turn 错配回归测试。

- 修复 Electron Renderer 黑屏保护：捕获 React 无限更新（React #185）、全局异常和未处理 Promise 拒绝，显示可恢复诊断页并将错误写入运行日志；主进程记录页面加载失败、Renderer 崩溃和无响应事件，崩溃后自动重载界面，不中断后台任务。
- 补齐 tree-sitter.wasm 及语言 grammar 资源，避免 AST 工具调用因缺少 WASM 触发主进程未处理异常。
- 移除 DeepSeek 兼容层硬编码的 131072 字节请求阈值；`maxRequestBytes` 现在仅按 Provider 配置生效，未配置时不再人为限制请求体大小。
- 继续移除 Provider 请求隐式阈值：不再默认限制工具数量、不再额外预留 4KB、不再在文本协议恢复时强制降到 96KB；普通请求和恢复请求统一使用 Provider 的显式配置。

- GPA 恢复流程下隐藏通用的“之前的任务已停止/继续任务”卡片，避免与 GPA 专用的“重试剩余任务”入口重复显示。
- 将 Provider 请求体超限恢复改为持续自动重试：逐轮压缩附加上下文、按比例减少工具定义并退避重试，不再因一次恢复无效而中断任务；界面显示超出字节数和当前重试次数。
- 修复 Provider 请求仅超出几十字节时仍中断任务的问题：历史上下文无法继续压缩时，自动移除不影响核心请求的传输提示字段并继续当前任务。
- 修复 GPA 计划失败后的重复继续提示：失败重试卡片出现时关闭同一任务的“是否继续”恢复弹窗，并在渲染层保持二者互斥，避免两个继续入口同时显示。
- 将运行状态接入原生工具调用的流式分片：模型刚生成有效工具名时立即显示“准备执行”对应操作，工具实际启动后切换为“正在执行”，完成后再显示结果决策；GPA 阶段无工具调用时展示当前未完成子任务及“等待模型生成下一项工具操作”，不再以静态“正在分析”冒充实时进度。
- 将 Agent 决策 JSON 无法解析、GPA 结构化输出失败改为自动恢复，避免任务因模型格式错误直接失败；界面显示具体重试原因。
- 在 DeepSeek 兼容层过滤流式输出中的 `[Exec` 和完整 `[Executed tools: ...]` 标记，防止内部兼容文本出现在回复中。
- 将执行中的三点动画改为状态文字，并在流式草稿期间持续展示实时活动面板和最近执行记录。
- 移除函数调用兼容转写中的 `[Executed tools: ...]` 与 `[Verified tool result ...]` 方括号标记，避免它们出现在 LLM 请求日志或被模型回显；保留工具结果与兼容上下文。
- 移除没有正文时的流式草稿占位行，仅保留实时活动面板，避免“模型生成中”和当前执行状态分两行重复显示。
- 移除流式草稿阶段写入的通用活动记录，并在展示层隐藏旧任务中遗留的草稿阶段文案；统一实时状态为单行展示，避免“模型正在生成”和活动面板重复显示。
- 修复 DeepSeek V4 原生工具调用失败后的文本协议兜底：临时关闭 thinking 并保留 `response_format: json_object`，使接口强制返回可解析的 Agent 决策 JSON，而非仅依赖提示词约束。
- 将运行状态中的“最近更新 X 前”精简为纯计时 `X`，减少执行信息的文字冗余。
- 将泛化的“正在请求模型决策”替换为本轮工具上下文：显示已完成操作数量和最近工具结果；首轮无工具时显示“正在分析任务并规划下一步”，并兼容已在执行中的旧状态。
- 继续审计并移除兼容层隐式输出阈值：DeepSeek、Kimi、Agnes、Gemini 不再强制把 `max_tokens` 提升到 8192 或按上下文窗口计算下限，统一原样使用模型的 `defaultMaxOutputTokens`；Provider 请求体和工具数量仍仅按显式 `maxRequestBytes`、`maxTools` 配置限制。
- 阈值审计结论：Provider 请求链路不再写死请求字节上限、工具数量上限、请求压缩安全余量或协议恢复字节上限；剩余固定数字仅用于重试次数、上下文压缩比例、工具结果/日志预览等运行安全策略，不会改变未配置 Provider 的请求体上限。

## 2026-08-13

- 调整 GPA 澄清卡片的文本兼容解析，向 OpenAI function calling 的结构化调用方式对齐：`request_user_input` 仍是唯一权威入口；仅在模型未调用工具且文本使用“澄清 / 待确认 / 待补充 / 待决策”等明确 Markdown 标题区块时，才将其中的编号问句提升为卡片。支持 `1 | **字段：** 问题？` 这类编号与加粗标签组合写法；区块外的普通问句不再按语义词猜测并触发卡片。新增对应正反例回归测试。

- Fix long-thread freezes caused by oversized tool history: all tool results, including `git.diff`, code search, file reads, and database output, are now limited to 8,000 characters before persistence into model context; old persisted tool messages are compacted again while history is assembled. Raw replay is also capped at 48,000 tokens per request even for models that advertise a million-token context window. Full raw tool records remain available in execution details, but they no longer inflate every later provider request or renderer update.

- Fix queued-message visibility during active tasks: message submission now receives the live runtime's authoritative queue result instead of inferring it from a potentially stale thread snapshot. When a message is accepted behind an active task, the renderer immediately displays the persisted queue item and reconciles it on the next snapshot; normal sends still become conversation messages and no send is converted into guidance or an interruption.

- Add file-tree diff snapshot preview: changed file nodes in the right-side project folder now reuse the existing `apply_patch` snapshots. Hovering a file with a snapshot for 3 seconds opens a syntax-highlighted diff popover with added/deleted counts; moving into the popover keeps it open, and files without a snapshot remain unchanged.

- Enforce project-code completion with unit tests: after a project task delivers source-code changes, completion now requires successful unit-test evidence and a final test report that states the command, pass status, and result summary. Builds, typechecks, file read-back, empty `project.verify`, and unsubstantiated prose cannot satisfy this gate. The requirement is carried through GPA ACT evidence and protocol-recovery state; unlike advisory completion auditing, it cannot be bypassed when recovery attempts are exhausted.

- Fix false GPA/project-task completion after an empty `project.verify`: when no configured or discoverable verification command exists, the tool now explicitly reports `executed: false`; the agent runtime excludes that result from post-delivery verification evidence. A project task can therefore complete only after real verification command success (or other valid read-back/test/build evidence), instead of treating a no-op verification call as proof.

- Fix conversation process visibility: submitting a new task immediately collapses every prior turn in that thread; when a running task reaches a terminal state, its process is collapsed once while retaining the user request and final answer. Historical threads therefore open with conclusions visible and execution details collapsed, and switching threads does not leak disclosure state.
- Fix queued submissions being treated as interruptions: realtime presentation no longer replaces its live scene for a message that belongs behind an active task. These messages remain FIFO queued; only the empty composer exposes the explicit stop action.
- Diagnose database password decryption behavior: database credentials remain in `credentials.json` as Electron `safeStorage` ciphertext and are protected by the current Windows user profile (DPAPI). The inspected configuration still contains both database credential records and matching references; the app must be run under the same Windows account/profile that saved them. No plaintext or app-defined fallback encryption was introduced.

- Fix desktop freezes during long streamed responses: ordinary draft snapshots now publish at most once every 100ms, while start, retry, and phase changes publish immediately. This removes per-token full-text IPC, renderer stalls, and excessive runtime log writes.
- Fix stale Git changes in the right workspace: Git snapshots are now bound to their source thread. Switching chats immediately hides the prior repository's branch and diff, and stale snapshot/action responses cannot overwrite the newly selected project.
- Restrict GPA Git mutations to explicit user requests: staging, reverting, committing, pushing, pulling, PR creation, and worktree changes are hidden and blocked by default, including equivalent shell commands. Read-only Git inspection remains available for verification.
- Hide the right-side Git workspace until the current task directory is successfully identified as a Git repository with a resolved repository root. Unknown, non-Git, and stale snapshots no longer display a branch or change list.
- Tighten Git panel ownership further: the resolved Git root must exactly match the selected task's project directory. A repository detected only above or below that directory is treated as unrecognized and is hidden.
