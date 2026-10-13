# 修改记录

记录用户提出并已落地的修改。后续每次完成用户请求后，在本文件追加一条记录。

## 2026-10-13

- 优化长任务期间的终端输出刷新：`terminal.output` 事件按线程暂存并以 100ms 批量提交到运行活动面板，连续同标签输出合并为一条，单条输出限制为 20,000 字符；遇到状态、工具或消息边界事件会先冲刷对应线程，保持活动顺序。新增运行活动批处理与长度上限回归测试。

- 侧栏「查看文档」入口右侧显示已打开的文档数：数量为 0 时不渲染任何徽标，入口保持原样。计数直接取 `useDocumentTabs` 的页签集合（该状态位于 `App`，面板让出聊天区后已打开的文档仍保留），`HistorySidebar` 只新增 `documentViewerOpenCount` 入参、经 `railItemCounts` 映射后由 `renderRailItem` 渲染，不自己持有状态；徽标样式 `.sidebar-nav-count` 追加在 `styles.css` 侧栏入口区块，亮/暗主题各一条。回归测试 `tests/document-viewer-inline-panel.test.ts` 新增「数量透传、为 0 时不渲染、样式类名存在」断言，该文件 23 项通过，完整 `vitest run` 109 个文件 1646 项通过；类型检查仍只剩既有基线报错，本次改动文件未新增报错。

- 「查看文档」的源文件外部改动提醒改为在「切回来」时检查：取消面板打开期间每 4 秒轮询源文件时间戳的做法，删掉 `DOCUMENT_SOURCE_CHECK_INTERVAL_MS` 常量与 `window.setInterval`/`clearInterval`，改为面板每次打开（收起后卸载、切回来重新挂载）时检查一次。命中后仍只在页签条下给一条提醒，由用户选择「重新加载」或「保留当前内容」，不自动覆盖正在编辑的文本。检查函数依赖稳定的 `applyTabs`（依赖为空数组），所以 effect 只在挂载时执行一次，不会随编辑重跑。回归测试同步改为断言「不含定时器与间隔常量」，并守住「面板由 `documentViewerPresence.value` 条件渲染」这一触发点前提——若将来改成常挂载，该断言会失败以防检查点失效；相关用例 24 项通过，完整 `vitest run` 109 个文件 1650 项通过、1 项跳过。

- 「查看文档」补上读取大文件时的加载特效：加载中不再复用通用空态，改为面板自带的加载视图（转圈、点名「正在读取「文件名」」、一条往返扫描的进度轨），页签栏同步在对应页签上显示读取指示，切到别的页签也能看出这份还没读完，因此不再从 `panels` 引入 `WorkspaceEmptyState`。样式新增 `.document-viewer-loading*`、`.document-tab-loading` 与 `document-viewer-loading-scan` 关键帧，并把新动画一并纳入 `prefers-reduced-motion` 降级。回归测试 `tests/document-viewer-inline-panel.test.ts` 新增「加载视图 + 页签指示 + 样式契约」用例，该文件 25 项通过，完整 `vitest run` 109 个文件 1662 项通过、1 项跳过；`apps/desktop` 类型检查未出现本次改动文件的报错。

## 2026-10-12

- 「查看文档」的两处调整：①空白页另存为的默认文件名由 `.md` 改为 `.txt`，与空白页按纯文本起手保持一致，保存分支与默认名推导（`getUntitledDocumentSuggestedFileName`）不变；②拖入文件改为总是新开页签，`openPaths` 增加 `openDuplicatePaths` 选项，拖入（`openDroppedPaths`）时只在同一批拖入内部去重、不再命中面板里已打开的同路径页签，因此已经有文件打开时再拖入也会各占一个新页签，文件对话框仍按路径去重以避免重复打开同一个文件。回归测试同步更新 `tests/document-viewer-inline-panel.test.ts`（默认名断言改为 `.txt`，新增拖入不去重的三条断言），该文件全部通过，完整 `vitest run` 无回归。
- 「查看文档」标题栏的「+」改为新建空白页，不再打开文件选择框：点它直接得到一个未落盘的「未命名 N」页签（默认按纯文本源码编辑），并新增一个独立图标按钮负责打开已有文件，两者共用 `.document-viewer-open-button` 样式；空白页保存时走另存为，默认文件名按标题推导成 `未命名 N.md`，另存成功后页签换成新路径与文件名。连点「+」会复用已有的干净空白页，不会堆出一排空页签；页签在未落盘时标题提示为「尚未保存到磁盘」。新增 `getUntitledDocumentTitle`、`getNextUntitledDocumentTitle`、`getUntitledDocumentSuggestedFileName` 三个工具函数集中处理未命名标题与默认文件名，`saveTab` 在没有路径时委托给 `saveTabAs`，不重复实现落盘逻辑。归属改动：`workspace/document-viewer-utils.ts`、`hooks/use-document-tabs.ts`、`workspace/document-viewer-panel.tsx`；回归测试 `tests/document-viewer-inline-panel.test.ts` 扩到 21 项并全部通过。

- 按随手记的观感重排「查看文档」面板的标题栏与空态：标题栏左侧只留一个居左的「+」图标按钮（原来的「打开文件」文字按钮已移除），同时去掉标题栏里的面板名称与说明文案整行，把识别出的文档类型与「预览 / 源码」切换统一收在右侧；空态从一行素文字改成居中的引导卡片，含图标、标题、支持的格式徽标（Markdown / HTML / C# / SQL / JSON / 纯文本）与一个文字化的打开入口，徽标由 `DOCUMENT_EMPTY_BADGES` 统一提供。样式层补齐 `.document-viewer-open-button`、`.document-viewer-empty-*` 与 `.document-viewer-kind-chip`，并删掉已无引用的 `.document-viewer-choose-button`；回归测试同步新增标题栏与空态断言，`tests/document-viewer-inline-panel.test.ts` 16 项、完整 `vitest run` 107 个文件 1612 项全部通过。

- 新增「查看文档」内联面板，侧栏入口排在「接口卡片」下方：不做弹窗，而是接管聊天区显示与操作，并与随手记、接口卡片互斥——打开时会收起这两者、退出分享模式并收起终端抽屉，再点一次或按 Esc 收起，点左侧任意会话或「新建任务」也直接切回聊天。面板按文件后缀名决定渲染方式：Markdown 与 HTML 可在「预览 / 源码」之间自由切换，C#、SQL 等代码文件复用既有 hljs 语法高亮，其余按纯文本显示；读取走只读的 `window.codexh.readDocumentFile` / `chooseDocumentFile`，不提供编辑。新增 `workspace/document-viewer-panel.tsx` 与 `workspace/document-viewer-utils.ts`，配色与布局沿用 `.document-viewer-sheet` 既有作用域，仅在 `styles.css` 补齐内联容器的尺寸与让位规则；新增回归测试 `tests/document-viewer-inline-panel.test.ts`，覆盖侧栏顺序、面板挂载位置、互斥与切换逻辑、Esc 关闭、后缀到渲染方式的映射以及样式契约。

- 修复输入框右侧「清空本次聊天」按钮提示已清空、聊天记录却没有变化的问题：清空动作此前只删掉了快照缓存与增量游标，本地快照基线仍被紧随其后的全量读取当作“服务端比本地旧”的依据，于是刚在服务端删除的消息又被合并回界面。现在改为复用 `invalidateThreadSnapshotForFullRefresh` 一并作废快照缓存、增量游标、在途读取请求与运行时消息映射，并丢弃本地快照基线与已上屏消息 id；新增回归测试覆盖“基线残留会复原旧记录、清空后服务端空列表保持为空”。替换了原先分别 `delete snapshotCursorByThreadRef`、`delete persistedRuntimeMessagesRef` 与删除快照缓存的三行局部清理写法。

## 2026-10-10

- 调整完全访问的默认值：新建任务（普通对话与项目任务一致）默认开启“完全访问”，空状态界面重新默认预勾选；空白页手动关闭后创建的首个任务会按当前选择持久化，创建后仍可随时手动修改。

- 工具调用明细组默认折叠：取消“运行中自动展开、完成后仍保持展开”的行为，转录中的工具活动组只保留一行摘要，明细仅在用户点击摘要后展开；正在运行的调用也不再自动撑开详情。同步更新对应回归测试（运行中的组保持折叠、不再自动展开）。

- 任务完成后工具调用随文字一起收起：撤销“折叠回合保留工具活动组摘要”的做法，回合折叠时工具调用明细与过程文字一并收起，转录只留下结论与文件摘要；展开回合仍可查看完整工具明细。同步更新回归测试。

- 修复中文会话中深度思考内容漂移为英文的问题：共享的中文输出兼容提醒现在除可见回复外，还以“必须用简体中文思考”的强制措辞要求模型把展示在“深度思考”面板中的推理内容（`reasoning_content`、`<think>` 块）保持为简体中文——即使系统指令、工具输出与历史消息是英文，推理、分析与规划内容也一律使用简体中文；覆盖 DeepSeek、Kimi、Hunyuan、Qwen、Agnes、Gemini 等适配器；`packages/provider-adapters/src/models/output-language.ts` 统一生效，新增 `deepseek-flash` 思考请求回归测试；相关测试文件 192 项全部通过，完整 `vitest run` 通过（103 个测试文件、1566 项用例通过、1 项跳过）。

## 2026-10-03

- 收紧可见浏览器的调用条件：普通研究和无关任务不再向模型提供 `browser.*` 控制工具；只有用户明确要求打开/操作网页，或当前执行中的前端实现计划确需浏览器验证时才开放。提示词明确区分后台网页读取与可见浏览器，并将普通聊天右侧工作区默认标签改为“深度思考”，避免展开面板时误落到浏览器。

## 2026-09-16

- 修复任务结束后最终总结偶发已进入渲染状态却仍需切换聊天才可见的问题：终态延迟会关闭运行期自动滚动，但界面仍停在底部时，后到的最终消息现在会在布局阶段继续定位到最新内容；长时间线的虚拟窗口也会在尾部新增时同步推进并挂载新尾项，不再等待后续滚动事件碰巧修正范围。用户已手动向上查看历史时仍保持原位置。新增终态后内容增长和虚拟尾项挂载回归测试。

## 2026-09-15

- 继续修复任务终态后最终总结需切换聊天才显示的竞态：非丢弃的 `assistant.completed` 以及父线程进入 idle/completed/failed 时，渲染器现在使旧增量请求失效、清除该线程的快照游标并保留已收到的运行时消息，随后强制下一次读取完整快照；子线程状态回显不会误清父线程缓存。这样即使最终 `message.created` 事件漏送，当前聊天也会直接从持久化记录恢复总结。新增终态完整刷新、旧请求失效、运行时消息保留和子线程隔离回归测试。

- 将任务栏「完全访问」对齐 Codex 的 Full access 运行时预设：开启后整轮直接使用 full-access 路径权限、允许 shell 出站并跳过普通文件和命令审批，不再依赖聊天请求是否被关键词识别为写入任务；删除、密钥路径和明确授权操作继续由独立安全策略保护。完全访问开关的异步保存现在按线程串行化，发送消息会等待最新设置落盘，保存失败会回滚界面并停止发送；空白页开启后创建首个聊天也会先持久化权限。新增沙箱映射、联网命令免审批和设置写入顺序回归测试。

- 修复网页读取时右侧 Browser 工作区为空且 Agent 可能长期卡住的问题：明确区分后台正文提取 `web_search.open_page` 与可见标签页 `browser.open_tab`，前者的运行文案改为“读取网页”，并在模型工具提示中要求需要展示或交互网页时使用后者；隐藏 Chromium 渲染和后备 HTTP 抓取现在共享 20 秒加载截止时间，超时会停止加载并返回可恢复失败，不再无限占用当前对话。新增网页加载截止时间和工具语义回归测试。

- 修复文件或目录读取连续失败后直接显示内部重复调用错误的问题：读取类工具在重复上限时暂停并询问用户，可选择提供正确路径、调整工作区范围或权限、换用其他方式，或停止任务；继续时清除该目标的重复计数并恢复模型决策，停止时显示中文说明且不暴露英文内部恢复错误。工作区范围在执行前连续拦截的读取也纳入同一恢复流程，并新增提示与停止消息回归测试。

- 修复任务已经结束但当前聊天不显示最终总结、必须切换聊天后才出现的问题：正式助手消息到达时立即提交当前会话快照；后台刷新检测到新增消息或运行状态进入终态时也改为普通优先级提交，避免最终消息渲染被低优先级 transition 延迟或打断。新增正式回复、过程消息、新消息快照及终态快照的回归测试。

## 2026-09-07

- 修复白色主题下聊天输入区“推理强度”控件仍显示深色背景的问题：触发器、展开菜单及选项现在使用浅色半透明表面，并保留悬停、选中和勾选状态的可读性。

## 2026-09-04

- 修复浅色主题下动态（实时角色/背景）模式右侧工作区不透明的问题：实时背景现在与图片背景共用同一套右层面板遮罩变量（`--app-bg-right-panel` 等），文件树、Git 面板等嵌套表面在背景模式下保持透明，不再叠加成近似纯白的右侧区域。

## 2026-08-14

- 修复浅色主题实时背景下右侧文件夹与 Git 模块内部仍显示白色的问题：将项目根目录列表、文件行、筛选框、Git 分支选择器、提交输入区、同步摘要和变更列表纳入实时背景的透明嵌套表面规则，继续由右侧外层面板统一承载背景遮罩。

- 简化 GPA ACT 收尾流程：验证继续在各计划项执行过程中完成；全部 PLAN 任务标记完成后，运行时立即阻止新的工具调用和额外验证轮次，只要求模型基于已有结果输出最终总结。最终总结校验仅保留结束状态、非空总结和完整任务 ID，不再因缺少补充证据引用、单元测试报告或浏览器截图而重复执行；计划栏同步改为“正在生成完成总结”。新增总结模式回归测试，`tests/agent-runtime.test.ts` 共 257 项通过。
- 修复 DeepSeek Responses 思考模式在工具调用后偶发 `400 The reasoning_text ... must be passed back` 并中止长任务的问题：流式适配器现在从 `response.output_item.added/done` 和 `response.reasoning_text.delta/done` 持续保留完整 reasoning item，即使网关在最终 `response.completed` 中省略该项，下一次工具结果请求仍会原样回传；旧任务或异常恢复历史确实缺少 reasoning item 时，不再重放必然被拒绝的原生函数调用，而是将已有工具结果降级为普通上下文后继续执行。新增流式缺失终态和旧历史恢复回归测试，`tests/provider-adapters.test.ts` 共 150 项通过，生产构建通过。
- 优化 Git 写操作的明确授权体验：未在用户消息中明确要求的暂存、还原、提交、推送、拉取、合并、变基、worktree 与对应 shell 命令不再直接显示英文策略错误，而是暂停任务并展示脱敏后的操作、可能影响及“拒绝 / 授权并继续”卡片。明确授权仅覆盖当前工具调用，不受完全访问、自动审批、会话审批或记住审批影响，也不会自动超时；批准后复用该次授权跳过当前命令的一次常规审批，拒绝或停止任务时均保证命令未执行。审批记录新增 `explicit_authorization` 类型，旧记录兼容为普通审批；完全访问提示同步说明必须由用户明确决定的操作仍会询问。

- 新增子任务等待 watchdog：父任务在等待子任务时按 30 秒轮询，子任务运行 60 秒后开始巡检；连续 120 秒没有新的工具事件、shell stdout/stderr 增量、测试输出或进程状态变化时自动中断，并将终态标记为 `interrupted`，保留已有消息、工具结果和中断原因。shell/test 有持续进展时可在 10 分钟后按 5 分钟窗口继续检查，但单个子任务总运行时间达到 30 分钟一定中断。子任务模型请求改为有限超时，主任务仍可由用户手动停止。终端输出事件现携带进度 heartbeat，子任务卡片会区分排队、启动、等待模型、执行 shell/test、重试、停滞和自动中断，并显示最近进度及自动中断倒计时。新增 watchdog 判定测试；`tests/agent-runtime.test.ts` 与 `tests/thread-ui-state.test.ts` 共 323 项通过。

- 优化主项目的 DeepSeek 兼容层，并仅将 `deepseek-harness` 作为实现参考：Provider 新增可持久化的 `deepseekProtocol` 配置。未配置或选择 `native` 时保持原有 DeepSeek 原生扩展行为；OpenAI 兼容 Provider 可在设置页选择“标准 OpenAI 兼容”，此模式不再发送 `thinking`、`reasoning_effort` 或工具调用历史中的 `reasoning_content`，以兼容拒绝 DeepSeek 私有字段的标准 Chat Completions 网关。DeepSeek 原生请求参数处理保留在 `packages/provider-adapters/src/models/deepseek.ts`，共享工具历史序列化在 `packages/provider-adapters/src/index.ts` 按该配置处理。新增 Provider 配置往返持久化和标准兼容协议回归测试；`tests/provider-adapters.test.ts`（147 项）与 `tests/model-storage.test.ts`（12 项）通过。
- 将设置页的“接口协议”和“DeepSeek 协议”合并为一个选择器：保留 OpenAI 兼容接口、Anthropic、Gemini、Mock 等原有平级选项，并新增平级的“DeepSeek 原生扩展”选项；选择 DeepSeek 原生扩展时使用 OpenAI Chat Completions 传输并开启 DeepSeek 原生字段。
- 优化带聊天背景时的运行过程显示：每条终端活动保持独立记录，但优先用经过单行压缩和长度限制的 `$ 输入命令` 替代重复的“终端输出”标签；点击命令摘要可在原位置展开或收起该条终端输出；运行活动面板增加半透明底和模糊，避免状态、终端记录和计时文字直接叠在背景图片上。
- 修复 DeepSeek 在工具执行后偶发 `400 No tool output found for tool call` 并直接停止任务：OpenAI 兼容消息在发送前会校验每个工具调用与结果的配对，只发送结果完整的调用批次并保持调用/结果连续，丢失结果的中断调用不再进入请求，孤立结果降级为普通上下文；运行时同时识别 DeepSeek 的 `tool call` 错误文案及常见 `tool_call_id` 配对错误，首次遇到时自动切换文本工具历史并重试，不再误判为不可恢复异常。新增缺失结果、部分配对、孤立结果与消息交错回归测试；完整测试共 809 项通过。

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
- 将泛化的“正在请求模型决策”替换为本轮工具上下文：显示已完成操作数量和最近工具结果；首轮无工具时显示“正在思考”，并兼容已在执行中的旧状态。
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

- Add a document viewer beside the API cards: a sidebar entry below API cards opens a chat-area panel instead of an overlay dialog. Files render by extension — Markdown reuses the chat renderer with preview/source switching, HTML runs in a sandboxed iframe, and code or text files use the existing highlight.js pipeline with line numbers — while several files open as tabs with unsaved-change dots, in-place editing, Ctrl+S save, save-as, LF/CRLF-faithful write-back, and a save/discard prompt before closing a dirty tab or collapsing the panel. The active tab's detected document kind is shown next to the panel title, and reads and writes go through the new `documents:*` IPC channels wired in the main process, preload, and renderer types.

- Rework the API card panel into a two-column workspace: the favorites panel now opens in the chat area as a full-height layout with the favorite list on the left and the selected card's detail on the right. Rows use an `is-selected` state with the method color rail and icon-only actions, the sidebar carries the search box and hint, and the detail column hosts the card editor, so both columns fill the whole panel without outer padding.

- Make the inline panels fill the chat area: the new-task page rule (`.chat-canvas.is-new-task footer { display: flex }`) has the same specificity as the panel hiding rules but is declared later in the stylesheet, so it overrode `display: none` and left the welcome hero, composer, and workspace bar visible below the panel. The hiding rules for the quick notes, API card, and document viewer panels are now declared at the end of the stylesheet with `display: none !important`, so each panel occupies the whole chat area while it is open.
- Reuse the quick-notes skeleton for the API card panel: the favorites panel now renders with the `quick-notes-*` structure (`quick-notes-sheet`, `-inline`, `-layout`, `-list`, `-items`, `-item`, `-editor`, `-footer`) instead of its own `api-favorites-*` skeleton, so list rows, the detail column, and the bottom action row match the quick notes panel one-to-one. API-card-specific styling is scoped to `.api-favorites-inline` with a `:root` prefix and only adds the method rail per `data-method`, the method label color, the search-box spacing, and the detail title/name styles, which keeps quick notes itself untouched.
