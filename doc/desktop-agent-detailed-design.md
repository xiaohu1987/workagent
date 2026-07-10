# codexh 桌面 Agent 详细设计文档

## 0. 文档说明

这是一份合并后的单文档版本，整合了之前的三份内容：

- 产品与架构提示词
- system skills 清单
- Codex 参考实现笔记

这份文档不再是“给另一个模型的提示词”，而是直接面向研发的详细设计文档。目标产品 `codexh` 是一款：

- 参考 Codex 的核心运行逻辑
- 界面风格和桌面工作流参考 Codex
- 支持自定义模型与多 Provider
- 使用 `Electron + SQLite`
- 用户模型配置统一写入 `C:\Users\当前用户\.codexh\config.toml`
- 内置 `skills` 体系
- 核心工程实现尽量向 `D:\学习\codex` 的结构靠拢

## 1. 参考基线

本设计文档的核心工程参考以下本地代码：

- Skill 系统
  - [loader.rs](D:/学习/codex/codex-rs/core-skills/src/loader.rs)
  - [manager.rs](D:/学习/codex/codex-rs/core-skills/src/manager.rs)
  - [render.rs](D:/学习/codex/codex-rs/core-skills/src/render.rs)
  - [injection.rs](D:/学习/codex/codex-rs/core-skills/src/injection.rs)
  - [model.rs](D:/学习/codex/codex-rs/core-skills/src/model.rs)
- Agent Runtime
  - [turn.rs](D:/学习/codex/codex-rs/core/src/session/turn.rs)
  - [mod.rs](D:/学习/codex/codex-rs/core/src/session/mod.rs)
  - [handlers.rs](D:/学习/codex/codex-rs/core/src/session/handlers.rs)
- Tool Call
  - [router.rs](D:/学习/codex/codex-rs/core/src/tools/router.rs)
  - [registry.rs](D:/学习/codex/codex-rs/core/src/tools/registry.rs)
  - [orchestrator.rs](D:/学习/codex/codex-rs/core/src/tools/orchestrator.rs)
  - [spec_plan.rs](D:/学习/codex/codex-rs/core/src/tools/spec_plan.rs)
- MCP
  - [mcp.rs](D:/学习/codex/codex-rs/core/src/mcp.rs)
  - [mcp_tool_call.rs](D:/学习/codex/codex-rs/core/src/mcp_tool_call.rs)
  - [mcp_tool_exposure.rs](D:/学习/codex/codex-rs/core/src/mcp_tool_exposure.rs)
  - [read_mcp_resource.rs](D:/学习/codex/codex-rs/core/src/tools/handlers/mcp_resource/read_mcp_resource.rs)
- 子代理
  - [codex_delegate.rs](D:/学习/codex/codex-rs/core/src/codex_delegate.rs)
  - [spawn.rs](D:/学习/codex/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)

设计原则不是“复制一模一样的代码”，而是抽象其中最稳定、最值得继承的工程结构：

- `Skills Loader + Skills Manager + Skill Injection`
- `Submission Loop + Active Turn + Pending Input Queue`
- `Tool Router + Tool Registry + Tool Orchestrator`
- `MCP Manager + MCP Tool Call Runtime + MCP Resource Access`
- `Child Session / Subagent Thread`

## 2. 产品定位

### 2.1 产品定义

这是一个“面向真实任务执行”的桌面 Agent 工作台，不是聊天聚合器，也不是单纯的模型切换壳。

它的核心能力不是“回答问题”，而是：

- 理解项目上下文
- 组装线程上下文
- 调用本地/远程工具
- 运行命令
- 修改文件
- 发起审批
- 管理子代理
- 将执行过程完整可视化

### 2.2 目标用户

- 需要在本地项目中让 Agent 实际干活的开发者
- 需要处理文档、表格、演示、报告的高级知识工作者
- 需要多模型接入能力的团队与个人
- 希望把私有模型、本地模型、OpenAI 兼容接口统一纳入一个桌面执行环境的用户

### 2.3 与其他产品的区别

- 与普通聊天助手的区别：有线程 runtime、工具编排、终端、文件变更、审批流、恢复能力
- 与 Cursor / Copilot 的区别：不是编辑器内补全，而是完整桌面 Agent 工作台
- 与 Claude Desktop 的区别：不是以聊天为核心，而是以任务执行与工程闭环为核心
- 与 Codex 的区别：参考其运行思想，但不绑定单一模型；支持多 Provider 与用户自定义 skill

### 2.4 双模式设计：项目模式与对话模式

`codexh` 应明确支持两种一等运行模式，这一点要向 Codex 对齐：

- 项目模式
  - 线程绑定到某个项目或 workspace
  - 有明确 `cwd`
  - 有 `runtime_workspace_roots`
  - 自动加载项目级 `.codexh/skills`、项目配置、项目输出目录
  - 可以按项目启用或关闭增强工作流包，例如 `Superpowers`
  - 适合代码修改、测试、repo 分析、worktree、patch、git 工作流
- 对话模式
  - 线程不绑定具体项目
  - 对应 Codex 里的 `projectless` 概念
  - 可以没有 repo，也可以只有临时工作目录
  - 更适合问答、资料整理、文档生成、方案设计、轻量办公任务

两种模式共用同一套核心 runtime：

- submission loop
- active turn
- tool router / orchestrator
- MCP runtime
- skills manager

差异主要体现在：

- 上下文装配
- 默认可见 skill roots
- 文件输出目录
- 权限默认值
- 项目配置与 repo 能力是否启用

内部字段建议：

- `thread_mode`
  - `project`
  - `chat`
- `workspace_kind`
  - `project`
  - `projectless`

其中：

- `thread_mode` 是 `codexh` 自己面向产品与 UI 的模式字段
- `workspace_kind` 用于兼容 Codex 风格的 telemetry / turn metadata 语义

### 2.5 项目模式下的可选 Workflow Pack

`codexh` 的项目模式应支持“按项目启用 / 关闭”的工作流增强包，首个明确支持的对象是 [obra/superpowers](https://github.com/obra/superpowers)。

设计目标：

- 只在 `项目模式` 下可启用
- 以“项目级开关”存在，而不是全局强制开启
- 开启后影响该项目后续线程的技能注入、启动引导、工作流约束
- 关闭后恢复 `codexh` 默认行为

为什么按项目启用：

- `Superpowers` 本质上是一套面向软件开发项目的流程方法论
- 它更适合代码仓库、worktree、测试、计划、评审这类项目场景
- 对于 `对话模式` 下的轻问答、资料整理、办公型线程，不应该默认强加这套流程

## 3. 强制技术约束

### 3.1 固定技术底座

- 桌面框架：`Electron`
- 本地数据库：`SQLite`
- Agent Runtime：独立后台服务进程或 Electron 主进程内的独立 runtime 层
- 技术语言建议：`TypeScript` 为主，必要的高性能执行器可用 `Rust` 或 `Go` 补充

### 3.2 SQLite 是本地主要结构化事实源

`codexh` 采用“`SQLite + ~/.codexh/config.toml + 文件系统`”三层持久化模型：

- `C:\Users\当前用户\.codexh\config.toml`
  - 保存用户级模型配置
  - 保存 Provider 定义、模型列表、默认模型、路由策略、用户级开关
- `SQLite`
  - 保存会话历史、执行轨迹、工具调用、MCP 记录、skill 元数据、审批记录
- 文件系统
  - 保存 skill 内容、附件、大日志、diff、截图、输出产物、缓存工件

除明文密钥外，以下数据持久化到 SQLite：

- 用户全部对话历史
- 线程消息
- turn 运行记录
- tool call 记录
- command run 记录
- MCP 调用记录
- skill 元数据与安装记录
- 审批记录
- 回放与恢复点

以下数据不存 SQLite，而是放到 `C:\Users\当前用户\.codexh\config.toml`：

- ProviderConfig
- ModelProfile
- 默认模型选择
- 模型路由规则
- 用户级模型能力开关

建议：

- `api_key` 不直接明文写入 SQLite
- `config.toml` 可保存 `api_key_env`、`credential_ref`、`base_url`、`headers_template`
- 真正密钥优先接入系统凭据管理器或环境变量

大对象策略：

- 大文本、长日志、diff、截图、附件文件保存在磁盘
- SQLite 只保存路径、hash、大小、索引和摘要

### 3.3 skills 目录是一级系统能力

`codexh` 应用级目录建议固定在：

```text
C:\Users\当前用户\.codexh\
  config.toml
  knowledge\
    global\
      bundles\
      imports\
      cache\
  outputs\
  plugins\
    installed\
    disabled\
    cache\
  skills\
    system\
    imported\
    installed\
    disabled\
    drafts\
  cache\
  logs\
  tmp\
```

其中，应用必须有如下逻辑上的 skill roots：

```text
C:\Users\当前用户\.codexh\skills\
  system\
    programming\
    office\
    platform\
  imported\
  installed\
  disabled\
  drafts\
```

其中：

- `C:\Users\当前用户\.codexh\skills` 是用户 skill 的统一根目录
- `imported / installed / disabled / drafts` 都属于用户 skill 的子目录
- `system` 目录用于系统预置 skill

插件包目录建议：

- `C:\Users\当前用户\.codexh\plugins\installed\<plugin-id>\`
- `C:\Users\当前用户\.codexh\plugins\disabled\<plugin-id>\`

对 `Superpowers`，建议安装形态为：

- `C:\Users\当前用户\.codexh\plugins\installed\superpowers\`
  - 保留其插件清单
  - 保留其 `skills/`
  - 保留其 hook / assets / references

另外，还应支持项目内 skill roots：

- `<repo>/.codexh/skills`
- `<repo>/.agents/skills`
- `<repo>/.codex/skills`（兼容导入旧生态时可选开启）

这是直接参考 [loader.rs](D:/学习/codex/codex-rs/core-skills/src/loader.rs) 的多 root 发现思路，而不是单个目录扫描。

### 3.4 聊天输出产物存放规则

像 Codex 一样，`codexh` 也应为“聊天生成的最终交付物”提供固定落盘位置。

这里的输出产物包括：

- Markdown / txt / json / csv
- docx / xlsx / pptx / pdf
- png / jpg / svg / html
- zip 包、导出包、报告、脚手架文件

默认存放策略：

- 当前线程绑定项目时：
  - 存到 `<repo>/.codexh/outputs/<thread_id>/`
- 当前线程不绑定项目时：
  - 存到 `C:\Users\当前用户\.codexh\outputs\<thread_id>\`
- 用户明确指定保存位置时：
  - 以用户指定路径为准

配套规则：

- 最终要交付给用户查看、打开、导出的文件放 `outputs`
- 中间过程文件、临时脚本、渲染缓存放 `tmp`
- 大日志、调试快照、网络缓存放 `logs` 或 `cache`
- UI 中应提供单独的“Outputs / 产物”面板，支持打开文件、打开所在目录、再次引用到聊天

### 3.5 本地知识库与 OKF Bundle

`codexh` 应集成一个本地知识库能力，允许用户导入文档并生成符合 [OKF 0.1 规范](https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/okf/SPEC.md) 的知识包。

这里的“生成 OKF”不是导出单个文件，而是生成一个完整的 **OKF bundle**：

- 目录树
- `index.md`
- 可选 `log.md`
- 一组带 YAML frontmatter 的 concept markdown
- 交叉链接
- 可选 `viz.html`

参考来源：

- [OKF README](https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/okf/README.md)
- [OKF SPEC v0.1](https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/okf/SPEC.md)

知识库的两个核心目标：

- 让用户能把本地文档整理成长期可维护的知识包
- 让 Agent 能以渐进加载的方式检索和引用知识，而不是每次把整堆附件塞进上下文

推荐作用域：

- `global knowledge base`
  - 存在 `C:\Users\当前用户\.codexh\knowledge\global\bundles\`
  - 适合个人长期知识库、规范库、手册库
- `project knowledge base`
  - 存在 `<repo>/.codexh/knowledge\bundles\`
  - 适合项目文档、需求说明、架构记录、接口说明、运维手册

建议支持导入的源文档类型：

- `md`
- `txt`
- `pdf`
- `docx`
- `pptx`
- `xlsx`
- `csv`
- `html`
- `json`

V2 再考虑：

- 图片 OCR
- 音视频转写
- 网页批量抓取后生成 OKF

大原则：

- OKF bundle 保存在磁盘
- SQLite 保存知识库、导入任务、文档映射、索引、线程绑定元数据
- Agent 面向知识库时优先读取 `index.md -> concept.md`，遵循 progressive disclosure

## 4. 总体架构

### 4.1 分层

系统分为 5 层：

1. Renderer Layer
  - React UI
  - Thread 视图
  - Diff 面板
  - Terminal 面板
  - Knowledge Base 页面
  - Settings / Provider / Skills 页面

2. Electron Bridge Layer
   - preload 暴露受控 IPC
   - 事件订阅桥
   - 文件选择、通知、菜单、托盘

3. Desktop Control Layer
   - Electron 主进程
   - 窗口管理
   - SQLite 连接管理
   - `codexh` home 目录管理
   - 文件监控
   - Secret 存储
   - Runtime 监督

4. Agent Runtime Layer
   - Session Runtime
   - Turn Runner
   - Tool Router / Registry / Orchestrator
   - MCP Manager
   - Skills Manager
   - Subagent Manager

5. Execution Layer
   - Shell / Unified Exec
   - Filesystem Patch
   - Git
   - Browser
   - MCP Servers
   - Extension Tools
   - Custom Tools

### 4.2 进程建议

- Renderer：UI
- Main Process：窗口、SQLite、IPC、安全边界、文件观察
- Agent Runtime Worker：每个 thread 或每组 thread 的运行器
- Optional Exec Worker：终端与高风险工具调用隔离
- Optional Browser Worker：浏览器自动化隔离

建议：V1 先用“主进程调度 + 单独 Node worker 执行 runtime”，不要一开始做过度分布式。

## 5. 信息架构与 UI

### 5.1 主界面

- 左侧
  - 最近项目
  - 新建对话
  - 新建项目会话
  - 工作区
  - 知识库
  - 线程列表
  - 收藏
  - 归档
  - 后台任务

- 中间
  - 当前线程消息流
  - Agent 过程块
  - 工具执行块
  - Browser / Web 预览区
  - 审批卡片
  - 子代理卡片

- 右侧
  - 当前任务详情
  - 上下文面板
  - 文件引用
  - Knowledge 引用
  - Diff 摘要
  - Outputs / 产物列表
  - Model / Skill / Tool 配置

- 底部
  - Terminal
  - Event Log
  - Tool Call Trace

### 5.2 关键交互

- 线程支持前台 / 后台切换
- 用户可以在 turn 执行中继续 steer 新输入
- 每次 tool call 可以展开看参数、审批、输出、耗时、结果
- 每次文件变更可以查看 patch 和 unified diff
- 可以中断 turn、重试 turn、从失败点恢复

### 5.3 知识库交互

知识库页面建议支持：

- 导入文件 / 文件夹
- 选择导入范围
- 选择导入目标
  - 全局知识库
  - 当前项目知识库
- 预览将生成的 OKF bundle 结构
- 查看 `index.md`
- 查看 concept 文档树
- 搜索知识库
- 导出 bundle
- 打开 bundle 所在目录
- 生成或刷新 `viz.html`

线程内建议支持：

- 为线程绑定一个或多个知识库
- 引用某个 concept 到当前上下文
- 搜索知识库并插入结果
- 让 Agent 先查看 `index.md` 再逐步展开 concept

## 6. Skill 系统设计

### 6.1 目标

Skill 不是“一段 prompt”，而是：

- 任务说明
- 引导策略
- 参考文件
- 脚本能力
- 工具依赖
- policy 元数据

的组合体。

### 6.2 Skill 文件结构

参考 `D:\学习\codex` 的结构，建议每个 skill 目录长这样：

```text
<skill-name>/
  SKILL.md
  agents/
    openai.yaml
  references/
  scripts/
  assets/
  skill.lock.json
```

说明：

- `SKILL.md`：必填，主说明文件
- `agents/openai.yaml`：可选，界面与默认 prompt 元数据
- `references/`：按需读取的补充文档
- `scripts/`：脚本工具
- `assets/`：图标或模板
- `skill.lock.json`：本地安装来源、版本、hash、更新时间

### 6.3 SKILL.md 规范

frontmatter 至少包含：

- `name`
- `description`

可选：

- `metadata.short-description`

如果 `name` 缺失，则回退为目录名。这一点直接参考 [loader.rs](D:/学习/codex/codex-rs/core-skills/src/loader.rs) 的默认行为。

### 6.4 agents/openai.yaml 元数据

建议支持：

- `interface.display_name`
- `interface.short_description`
- `interface.default_prompt`
- `interface.icon_small`
- `interface.icon_large`
- `interface.brand_color`
- `dependencies.tools`
- `policy.allow_implicit_invocation`
- `policy.products`

这直接参考 [update-v8-version/openai.yaml](D:/学习/codex/.codex/skills/update-v8-version/agents/openai.yaml) 和 [loader.rs](D:/学习/codex/codex-rs/core-skills/src/loader.rs) 的解析结构。

### 6.5 Skill Root 与 Scope

建议 scope：

- `repo`
- `user`
- `system`
- `admin`

Root 建议：

- `repo`
  - `<repo>/.codexh/skills`
  - `<repo>/.agents/skills`
  - `<repo>/.codex/skills`（兼容旧 skill）
- `user`
  - `C:\Users\当前用户\.codexh\skills\imported`
  - `C:\Users\当前用户\.codexh\skills\installed`
  - `C:\Users\当前用户\.codexh\skills\disabled`
  - `C:\Users\当前用户\.codexh\skills\drafts`
- `system`
  - `C:\Users\当前用户\.codexh\skills\system\*`
- `admin`
  - 企业管理目录，V3 再启用

### 6.6 加载优先级与注入优先级分离

参考 `D:\学习\codex`：

- 加载/覆盖优先级应偏向离项目近的 skill
  - `repo > user > system > admin`
- Prompt 预算不足时，模型可见 skill 元数据的保留顺序可以单独设计
  - 可采用 `system > admin > repo > user` 的展示优先级，确保基础系统技能不被完全挤掉

这是对 [loader.rs](D:/学习/codex/codex-rs/core-skills/src/loader.rs) 和 [render.rs](D:/学习/codex/codex-rs/core-skills/src/render.rs) 的组合抽象。

### 6.7 同名 skill 与 namespace

- 同名 skill 允许并存
- skill 唯一标识不使用 `name`，而是：
  - `skill_id`
  - `source_scope`
  - `source_path`
  - `version`
  - `content_hash`
- plugin 自带 skill 自动 namespace
  - 例如：`github:gh-fix-ci`

这直接参考 [loader_tests.rs](D:/学习/codex/codex-rs/core-skills/src/loader_tests.rs) 中的 duplicate name 和 plugin namespace 逻辑。

### 6.8 Skill 选择与注入

Skill 选择分三步：

1. 显式选择
   - 用户在 UI 中点选 skill
   - 用户在文本中提到 `$skill-name`
   - 用户通过 path 选择 skill

2. 隐式选择
   - 基于任务与 skill 描述匹配
   - 仅对 `allow_implicit_invocation != false` 的 skill 生效

3. 注入执行
   - 先把“可用 skill 列表”以预算化方式注入上下文
   - 命中 skill 后，必须完整读取 `SKILL.md`
   - 再按需读取 `references/`、`scripts/`、`assets/`

### 6.9 Skill Prompt Budget

参考 [render.rs](D:/学习/codex/codex-rs/core-skills/src/render.rs)：

- 默认将“可见 skill 元数据”限制在上下文窗口的约 `2%`
- 预算不够时：
  - 先截断 description
  - 再省略部分低优先级 skill
- UI 给出 warning：
  - skill 描述被截断
  - skill 列表被裁剪

### 6.10 Skill 与 SQLite

SQLite 保存：

- `skills`
- `skill_versions`
- `skill_sources`
- `skill_install_records`
- `skill_permissions`
- `skill_enablement`
- `skill_trigger_stats`

文件系统保存：

- `SKILL.md`
- `scripts/`
- `references/`
- `assets/`
- `C:\Users\当前用户\.codexh\skills\...` 下的安装内容

原则：

- 内容在磁盘
- 元数据、索引、状态在 SQLite

### 6.11 项目模式下的 Superpowers 集成

`Superpowers` 不应被仅仅当成“又一组 skills”，而应作为 `项目模式` 下的可选 Workflow Pack / Plugin 对待。

参考来源：

- 项目主页与安装说明
  - [obra/superpowers README](https://github.com/obra/superpowers)
- Codex 插件清单
  - [plugin.json](https://raw.githubusercontent.com/obra/superpowers/main/.codex-plugin/plugin.json)
- Codex SessionStart hook
  - [hooks-codex.json](https://raw.githubusercontent.com/obra/superpowers/main/hooks/hooks-codex.json)
- 启动引导 skill
  - [using-superpowers](https://raw.githubusercontent.com/obra/superpowers/main/skills/using-superpowers/SKILL.md)

从上述文件可以看出，`Superpowers` 对 `Codex` 的集成核心是：

- 提供一组 `skills/`
- 在 `SessionStart` 的 `startup | resume | clear` 时做启动引导
- 用 `using-superpowers` 建立“先检查 skill，再行动”的流程约束

因此在 `codexh` 中建议这样落地：

1. 安装
   - 支持从 GitHub 仓库安装 `https://github.com/obra/superpowers`
   - 安装到 `C:\Users\当前用户\.codexh\plugins\installed\superpowers\`
   - 解析 `.codex-plugin/plugin.json`
   - 扫描 `skills/`、hooks、assets、references

2. 启用条件
   - 仅允许在 `thread_mode = project` 的项目模式下启用
   - 对话模式线程不自动启用

3. 启用后的行为
   - 将 `superpowers/skills` 挂入该项目线程的 capability roots / skill roots
   - 在项目线程 `startup`、`resume`、`clear` 时执行等价的启动引导
   - 将 `using-superpowers` 作为项目工作流 bootstrap 注入

4. 关闭后的行为
   - 不再对新 turn 自动注入 `using-superpowers`
   - 不再自动暴露 `superpowers:*` skills
   - 已经存在的历史消息保留，但后续线程恢复默认 `codexh` 行为

UI 建议：

- 在项目详情页或线程右侧设置区增加：
  - `Workflow Packs`
  - `Superpowers`
  - `Enable for this project` 开关
- 提供：
  - `安装`
  - `启用`
  - `停用`
  - `更新`
  - `查看来源`

非常重要的工程建议：

- `codexh` 不要把 `Superpowers` 的 shell hook 执行强耦合为唯一实现路径
- 对 `SessionStart` 类 bootstrap，优先做原生适配层
- shell hook runner 仅作为兼容 fallback

原因：

- `Superpowers` 当前对 Codex 的上游集成依赖 `SessionStart` 启动链路
- 在 Windows / sandbox 环境中，外部 shell hook 的稳定性可能不如原生适配
- `codexh` 是 Electron 桌面应用，完全可以把“启动时注入 using-superpowers”这类动作原生化

建议抽象：

- `WorkflowPackAdapter`
  - `install()`
  - `enable_for_project(project_id)`
  - `disable_for_project(project_id)`
  - `on_thread_start(thread_id, mode)`
  - `on_thread_resume(thread_id)`
  - `collect_skill_roots(project_id)`
  - `collect_startup_context(project_id)`

`SuperpowersAdapter` 是第一个实现。

### 6.12 本地知识库与 OKF 生产流程

`codexh` 的本地知识库应把“导入文档”和“生成 OKF bundle”作为同一条产品流水线，而不是两个互相独立的功能。

导入流程建议：

1. 选择文件 / 文件夹 / 项目 docs 目录
2. 识别文件类型
3. 提取文本和基础元数据
4. 按文档、标题、章节做 concept 切分
5. 为每个 concept 生成符合 OKF 的 frontmatter
6. 写入 OKF bundle 目录树
7. 生成 `index.md`
8. 更新可选 `log.md`
9. 写入 SQLite 元数据与检索索引
10. 可选生成 `viz.html`

建议的 concept frontmatter 最少包含：

```yaml
---
type: Reference
title: <显示标题>
description: <一句话摘要>
tags: [<tag1>, <tag2>]
timestamp: <ISO 8601>
resource: <原文件路径或来源 URI，可选>
source_path: <本地源文件路径>
source_hash: <sha256>
import_run_id: <导入任务 id>
okf_version: "0.1"
---
```

说明：

- `type` 是 OKF 规范里的必填字段
- `title`、`description`、`resource`、`tags`、`timestamp` 是推荐字段
- `source_path`、`source_hash`、`import_run_id` 属于 producer-defined 扩展字段

推荐 bundle 目录结构：

```text
<bundle-root>/
  index.md
  log.md
  references/
  manuals/
  specs/
  playbooks/
  source_docs/
  viz.html
```

对一般导入文档，建议默认落到：

- `references/`
- `manuals/`
- `specs/`
- `playbooks/`

切分策略建议：

- 短文档：一个源文档生成一个 concept
- 长文档：按一级/二级标题切分为多个 concept
- 表格型文档：可以额外生成 schema / examples 段落
- 一个源文件可以对应多个 concept，但必须保留 source mapping

### 6.13 知识检索策略

本地知识库检索建议采用三层策略：

1. 结构化导航
   - 先读 `index.md`
   - 再读目标 concept
   - 最符合 OKF 的 progressive disclosure 思路

2. 全文检索
   - 使用 SQLite FTS5
   - 支持标题、description、tags、body 搜索

3. 语义检索
   - 可选 embedding index
   - V1 可先不强依赖
   - V2 支持本地 embedding 模型或远程 embedding provider

推荐默认：

- V1：`OKF 导航 + SQLite FTS5`
- V2：`OKF 导航 + FTS5 + Embedding`

Agent 使用知识库时的约束建议：

- 优先读取 bundle 的 `index.md`
- 避免一次把整个 bundle 注入上下文
- 先返回命中的 concept 摘要，再决定是否展开正文
- 引用命中的 concept 时要保留 concept id 和 bundle id

## 7. 默认 System Skills 方案

### 7.1 预装 Programming Skills

建议首批预装：

- `create-plan`
- `repo-map-codex`
- `deep-planning-codex`
- `verification-plan-codex`
- `adversarial-plan-review-codex`
- `webapp-testing`
- `codebase-migrate`
- `deploy-pipeline`
- `changelog-generator`
- `mcp-builder`
- `gh-fix-ci`
- `gh-address-comments`

来源：

- [ComposioHQ/awesome-codex-skills](https://github.com/ComposioHQ/awesome-codex-skills)
- [dachent/skills](https://github.com/dachent/skills)

### 7.2 预装 Office Skills

建议首批预装：

- `docx-win`
- `pptx-win`
- `xlsx-win`
- `paperjsx`
- `content-research-writer`
- `email-draft-polish`
- `meeting-notes-and-actions`
- `theme-factory-codex`
- `web-artifacts-builder-codex`

### 7.3 参考 `D:\学习\codex` 的专业工程 Skills

这组更适合作为“专业模式预装包”：

- [code-review](D:/学习/codex/.codex/skills/code-review/SKILL.md)
- [code-review-breaking-changes](D:/学习/codex/.codex/skills/code-review-breaking-changes/SKILL.md)
- [code-review-change-size](D:/学习/codex/.codex/skills/code-review-change-size/SKILL.md)
- [code-review-context](D:/学习/codex/.codex/skills/code-review-context/SKILL.md)
- [code-review-testing](D:/学习/codex/.codex/skills/code-review-testing/SKILL.md)
- [babysit-pr](D:/学习/codex/.codex/skills/babysit-pr/SKILL.md)
- [codex-pr-body](D:/学习/codex/.codex/skills/codex-pr-body/SKILL.md)
- [codex-bug](D:/学习/codex/.codex/skills/codex-bug/SKILL.md)
- [codex-issue-digest](D:/学习/codex/.codex/skills/codex-issue-digest/SKILL.md)

建议定位：

- `review` 套件
- `github watch` 套件
- `issue triage` 套件
- `release / maintenance` 套件

### 7.4 用户安装 skill

支持三种方式：

- 本地导入
- GitHub 导入
- 对话安装

安装流程：

1. 下载/复制到临时目录
2. 校验目录结构
3. 解析 `SKILL.md`
4. 解析 `agents/openai.yaml`
5. 扫描依赖与脚本
6. 计算 hash
7. 写入 SQLite 元数据
8. 移动到目标 root
   - 默认移动到 `C:\Users\当前用户\.codexh\skills\installed\...`
9. 通知 Skills Manager 刷新缓存

## 8. Tool 系统设计

### 8.1 目标

Tool 系统必须参考 `D:\学习\codex` 的思路，拆成以下层次：

- `ToolSpec`
- `ToolRouter`
- `ToolRegistry`
- `CoreToolRuntime`
- `ToolOrchestrator`
- `ToolOutput`
- `ToolResult Recorder`

### 8.2 工具分层

1. ToolSpec
   - 给模型看的 schema
   - 包含名称、参数、说明

2. ToolRegistry
   - 维护真正可执行的工具处理器
   - 根据 tool name 查找 handler

3. ToolRouter
   - 从当前 turn 的 feature / config / env / mcp / extension 组装出可见工具集合
   - 将模型返回的 `ResponseItem` 转为内部 `ToolCall`

4. ToolOrchestrator
   - 统一处理审批、沙箱、网络策略、重试

5. ToolRuntime / Handler
   - 实现具体工具逻辑

### 8.3 ToolRouter 设计

参考 [router.rs](D:/学习/codex/codex-rs/core/src/tools/router.rs)：

- 输入
  - turn_context
  - mcp_tools
  - deferred_mcp_tools
  - extension tool executors
  - dynamic tools

- 输出
  - `model_visible_specs`
  - `ToolRegistry`

- 关键职责
  - `build_tool_call`：把模型返回的 function call / custom tool call / tool_search call 变成统一的 `ToolCall`
  - `tool_supports_parallel`
  - `create_diff_consumer`

### 8.4 ToolRegistry 设计

参考 [registry.rs](D:/学习/codex/codex-rs/core/src/tools/registry.rs)：

- 使用 `ToolName -> Handler` 映射
- 注册时禁止同名重复 handler
- 每次 dispatch 前做：
  - active turn 计数
  - pre-tool hooks
  - payload 类型检查
  - telemetry
  - post-tool hooks
  - tool lifecycle 事件发送

关键设计决策：

- 不让每个工具自己管日志、审批、重试
- 工具只关心自己的业务逻辑
- 宿主统一做 lifecycle 和 policy

### 8.5 ToolOrchestrator 设计

参考 [orchestrator.rs](D:/学习/codex/codex-rs/core/src/tools/orchestrator.rs)：

统一执行流程：

1. approval
2. sandbox selection
3. attempt
4. network approval
5. failure / denial retry
6. deferred cleanup

这是 V1 就必须有的能力，否则 shell、patch、browser、custom tool、MCP tool 的安全逻辑会分裂。

### 8.6 工具类别

V1 必备：

- filesystem read/write
- code search
- knowledge search
- knowledge read
- shell / exec
- apply_patch
- git
- browser
- http
- tool_search
- request_user_input
- request_permissions
- multi_agents
- MCP resource tools
- MCP tool call bridge

### 8.7 浏览器能力分层

浏览器能力建议直接参考 `D:\学习\codex` 的三条现有线索来设计：

- `web_search` 工具协议
  - [tool_spec.rs](D:/学习/codex/codex-rs/tools/src/tool_spec.rs)
- `in_app_browser` / `browser_use` / `browser_use_external` feature
  - [lib.rs](D:/学习/codex/codex-rs/features/src/lib.rs)
- `browser-use` / `Playwright` 风格的 MCP 审批与连接器元数据
  - [mcp_tests.rs](D:/学习/codex/codex-rs/core/src/session/mcp_tests.rs)
  - [mcp_tool_call_tests.rs](D:/学习/codex/codex-rs/core/src/mcp_tool_call_tests.rs)

`codexh` 应把浏览器能力拆成 3 层：

1. `web_search`
   - 面向搜索、查资料、打开网页内容、页内查找
   - 主要是模型可见的 hosted tool 或 standalone web search
   - 典型动作：
     - `search`
     - `open_page`
     - `find_in_page`
   - 适合：
     - 资料检索
     - 文档比对
     - 新闻/官网核实
     - 页面文本抽取

2. `in-app browser`
   - 面向桌面应用内网页预览与轻量交互
   - 建议基于 `Electron BrowserView` 或 `WebContentsView`
   - 由 `codexh` 自己维护 tab、导航历史、截图、页面状态
   - 适合：
     - 打开本地 `localhost`
     - 预览生成出来的 HTML
     - 查看 Agent 正在分析的网页
     - 让用户和 Agent 共享同一网页上下文

3. `browser automation via MCP`
   - 面向需要确定性步骤的浏览器自动化
   - 不建议把 Playwright 执行器硬编码进核心 runtime
   - 优先通过 MCP / connector 接入：
     - `Browser Use`
     - `Playwright`
     - 其他浏览器控制插件
   - 适合：
     - 点击、输入、上传、下载
     - 登录流程
     - 端到端测试
     - 多步网页任务

设计原则：

- `web_search` 负责“找信息”
- `in-app browser` 负责“看页面”
- `browser automation` 负责“做操作”
- 三层共享统一的审批、artifact、日志与 turn 事件体系

### 8.8 浏览器工具矩阵

建议的浏览器工具矩阵如下：

- `web_search`
  - `search_query`
  - `open_page`
  - `find_in_page`
- `browser`
  - `open_tab`
  - `navigate`
  - `reload`
  - `go_back`
  - `go_forward`
  - `capture_screenshot`
  - `read_page_text`
  - `list_tabs`
  - `focus_tab`
- `browser_automation`
  - `browser_navigate`
  - `browser_click`
  - `browser_type`
  - `browser_select`
  - `browser_wait_for`
  - `browser_eval`
  - `browser_upload`
  - `browser_download`
  - `browser_snapshot`

ToolRouter 暴露策略建议：

- Provider 支持 hosted `web_search` 时：
  - 优先暴露 hosted `web_search`
- 无 hosted `web_search` 但本地有 standalone web search 时：
  - 暴露本地 `web_search`
- 桌面版且开启 `in_app_browser` feature 时：
  - 暴露 `browser` namespace
- 检测到 `Browser Use` / `Playwright` MCP server 时：
  - 暴露 `browser_automation` 相关 MCP tools
  - 工具数量过多时进入 deferred exposure，并通过 `tool_search` 发现

审批建议：

- `web_search.search_query`
  - 默认低风险，可按策略免审批
- `web_search.open_page`
  - 中低风险，可按域名和网络策略决定
- `browser.open_tab` / `browser.navigate`
  - 中风险，建议记录来源和目标 URL
- `browser_automation.click/type/upload/download/login`
  - 高风险，必须进入统一审批流

### 8.9 Tool Result 标准化

参考 `ToolOutput -> to_response_item` 的思路：

- 每个工具最终必须能转成统一的模型可见结果
- 同时也要能输出：
  - UI 日志 preview
  - 结构化 code mode result
  - hook payload
  - telemetry tags

浏览器工具额外要求：

- 截图统一落 `artifacts`
- 页面标题、URL、tab_id、origin 进入结构化结果
- 自动化步骤要能输出 step trace
- 打开过的网页可被再次引用到同一线程上下文

知识库工具额外要求：

- 返回 `bundle_id`
- 返回 `concept_id`
- 返回 `source_path`
- 返回命中片段和相关分数
- 支持“只返回摘要”和“展开正文”两种模式

## 9. MCP 系统设计

### 9.1 目标

MCP 不应该只是“能连一个 server”，而要作为一等能力纳入：

- tool exposure
- tool call
- resource access
- elicitation
- approval
- auth refresh
- connector policy

### 9.2 McpManager

参考 [mcp.rs](D:/学习/codex/codex-rs/core/src/mcp.rs)：

职责：

- 聚合 config 中的 MCP server
- 聚合 plugin 注册的 MCP server
- 聚合 extension overlay 的 MCP server
- 输出：
  - configured servers
  - runtime servers
  - effective servers

设计建议：

- `ProviderConfig` 和 `McpServerConfig` 分开管理
- runtime config 可叠加 thread 级 overlay
- 支持 Set / Remove overlay
- 支持 legacy compatibility built-ins

### 9.3 MCP Tool Exposure

参考 [mcp_tool_exposure.rs](D:/学习/codex/codex-rs/core/src/mcp_tool_exposure.rs)：

关键点：

- 不是所有 MCP 工具都直接暴露给模型
- 如果数量过多，要 deferred 到 `tool_search`
- 参考阈值：`100` 个 direct tool

设计建议：

- `direct_tools`
- `deferred_tools`

当 direct tools 太多时：

- Prompt 中只暴露 `tool_search`
- 让模型先搜索，再动态挂载或调用

### 9.4 MCP Tool Call 生命周期

参考 [mcp_tool_call.rs](D:/学习/codex/codex-rs/core/src/mcp_tool_call.rs)：

建议流程：

1. 解析模型参数
2. 构造 `McpInvocation`
3. 查 metadata
4. 评估 connector policy / app policy
5. 判断 approval mode
6. 发起 MCP 审批或自动放行
7. 如有需要，重写入参
8. 构造 request meta
   - thread id
   - sandbox state
   - trace metadata
9. 调 `session.call_tool`
10. sanitize result
11. 如需要，触发 auth elicitation
12. 记录 telemetry / event / history

### 9.5 MCP Approval 模型

MCP tool approval 支持：

- `Auto`
- `Prompt`
- `Approve`
- `Approve for session`
- `Approve and remember`

对于 host-owned connectors，要额外支持：

- auth elicitation
- install / connect URL
- refresh accessible connectors

### 9.6 MCP Resource 能力

V1 直接支持：

- `list_mcp_resources`
- `list_mcp_resource_templates`
- `read_mcp_resource`

参考：

- [read_mcp_resource.rs](D:/学习/codex/codex-rs/core/src/tools/handlers/mcp_resource/read_mcp_resource.rs)

说明：

- 资源型读取不走大而全工具 schema
- 以 `server + uri` 为主
- 返回统一的结构化资源结果

### 9.7 MCP 与 Skill 的关系

Skill 可以声明：

- `dependencies.tools`
- MCP transport
- MCP URL / command

当 skill 依赖的 MCP 不存在时：

- 系统提示缺失依赖
- 允许用户确认后自动安装
- 安装记录写入 SQLite

### 9.8 浏览器自动化优先通过 MCP / Connector 接入

参考 `D:\学习\codex` 当前的工程走向，`codexh` 不应在 V1 把浏览器自动化硬写死在 core 里，而应优先支持：

- `Browser Use`
- `Playwright`
- Chrome / WebView 类浏览器连接器

设计建议：

- core runtime 只抽象 `BrowserAutomationBridge`
- 真实自动化工具由 MCP server 提供
- MCP 元数据中保留：
  - `connector_id`
  - `connector_name`
  - `tool_name`
  - `tool_title`
  - `tool_description`
- Guardian / approval 层按“浏览器自动化工具”统一归类

这能和 Codex 代码里已有的浏览器相关连接器元数据对齐：

- `browser-use`
- `access_browser_origin`
- `browser_navigate`

优势：

- 核心 runtime 更轻
- 容易替换 Playwright、Browser Use、Chrome 扩展等不同实现
- 审批、日志、MCP elicitation 路径保持统一

### 9.9 知识库与 MCP / Skill 的关系

知识库能力本身优先作为 `codexh` 内建模块实现，而不是先做成 MCP server。

原因：

- 本地知识库与本地文件导入、SQLite 索引、线程绑定高度耦合
- 它属于桌面应用的核心内容层，而不只是一个外接工具

但仍建议保留两种扩展点：

- Skill 可以声明“优先使用某个知识库”
- MCP 可以作为外部知识源导入器
  - 例如从企业文档系统、云盘、Wiki 导入后再转 OKF

推荐抽象：

- `KnowledgeBaseManager`
- `OkfBundleWriter`
- `KnowledgeImporter`
- `KnowledgeSearchEngine`
- `KnowledgeContextBinder`

## 10. Agent Runtime 设计

### 10.1 顶层概念

参考 `D:\学习\codex`，运行时核心对象为：

- `Session`
- `Submission Loop`
- `Active Turn`
- `TurnContext`
- `TurnState`
- `InputQueue`
- `History`
- `Turn Runner`

### 10.2 Submission Loop

参考 [handlers.rs](D:/学习/codex/codex-rs/core/src/session/handlers.rs)：

所有外部动作先进统一队列：

- 用户输入
- 中断
- 审批结果
- patch 审批
- request_user_input 回答
- dynamic tool response
- compact
- rollback
- thread settings
- inter-agent communication

这意味着 UI、子代理、审批弹窗、后台工具，都不直接改 session 状态，而是通过 `Submission` 进入 runtime。

### 10.3 Active Turn

一个线程同一时刻最多一个 active turn。

Turn 类型：

- `regular`
- `review`
- `compact`
- `subagent`

状态：

- `pending_init`
- `running`
- `waiting_tool`
- `waiting_approval`
- `waiting_user_input`
- `compacting`
- `interrupted`
- `aborted`
- `completed`
- `failed`

### 10.4 TurnContext

建议字段：

- `turn_id`
- `thread_id`
- `workspace_id`
- `model_info`
- `provider_info`
- `reasoning_effort`
- `approval_policy`
- `sandbox_policy`
- `tool_mode`
- `multi_agent_version`
- `environment_selections`
- `skill_context`
- `plugin_context`
- `session_source`
- `parent_thread_id`
- `truncation_policy`
- `compaction_policy`

### 10.5 TurnState

建议字段：

- `pending_input`
- `tool_calls_count`
- `in_flight_tool_calls`
- `waiting_approval_ids`
- `waiting_dynamic_tool_ids`
- `has_memory_citation`
- `mailbox_delivery_phase`
- `step_count`
- `token_usage_snapshot`
- `turn_diff_snapshot`

### 10.6 InputQueue / Pending Input

参考 [mod.rs](D:/学习/codex/codex-rs/core/src/session/mod.rs) 中 `steer_input` 逻辑：

- turn 运行时，用户新输入不一定中断当前 sampling
- 新输入先进入 `pending_input`
- 合适时机再注入当前 turn

好处：

- 保持流式响应与工具执行的可控性
- 不把 runtime 做成“用户每说一句就强行杀 turn”

### 10.7 Turn Runner

参考 [turn.rs](D:/学习/codex/codex-rs/core/src/session/turn.rs)。

执行流程：

1. pre-sampling compaction
2. 记录上下文更新
3. 构建 skill / plugin / extension injection
4. 运行 startup hooks
5. 记录输入
6. 进入 sampling loop
7. 处理工具调用和消息流
8. 判断 follow-up
9. 必要时 compact 后继续
10. stop hooks
11. turn complete / aborted / failed

### 10.8 Sampling Loop

核心规则：

- 每轮 sampling 前，从历史构造 prompt
- 使用 turn-scoped client session，复用 transport 状态
- 流式接收 response events
- 如果模型产出 tool call，则异步执行并回注结果
- 如果 `end_turn = false`，继续下一轮
- 如果还有 pending input，也继续 follow-up

### 10.9 Tool Futures Drain

参考 `drain_in_flight`：

- 工具调用不一定同步阻塞整个流
- 允许 in-flight tool futures
- 结束 sampling 后 drain 所有 in-flight 工具结果
- drain 结果写回 history

### 10.10 Compact 机制

参考 `pre-sampling compact` 和 `mid-turn compact`：

- turn 开始前，如果上下文逼近阈值，先 compact
- sampling 后，如果 token 超限且仍需 follow-up，则先 compact 再继续

这是保持长线程稳定性的关键，不建议 V1 省略。

### 10.11 中断与恢复

中断：

- runtime 接收到 interrupt op
- abort 当前 task
- 清理 in-flight state
- 保留历史和恢复点

恢复：

- 基于历史 + turn snapshot + pending input + tool results 重建上下文
- 新建一个 continuation turn

### 10.12 History / Context Invariants

参考：

- [history.rs](D:/学习/codex/codex-rs/core/src/context_manager/history.rs)
- [event_mapping.rs](D:/学习/codex/codex-rs/core/src/event_mapping.rs)

设计要求：

- 必须区分三层记录
  - `messages`：面向 UI 的人类可读消息层
  - `response_items`：面向模型可回放的原始上下文层
  - `turn_events`：面向 runtime 时间线与审计的事件层
- 不是所有注入线程的文本都算“普通用户消息”
  - 环境上下文
  - skills instructions
  - hook prompt
  - 权限提示
  - 模型切换提示
  - 这类 contextual fragments 必须可识别、可裁剪、可回滚
- `History` 内部应维护 `history_version`
  - compact
  - rollback
  - replace history
  - 上述任一操作都会递增版本
- `History` 还应维护 `reference_context_item`
  - 用于下一轮 turn 的上下文 diff
  - 如果 rollback 裁掉了混合 contextual developer bundle，则必须清空 baseline，强制下一轮 full reinjection
- prompt 构建前必须做 normalize
  - 保证 function call / output 成对
  - 去除当前模型不支持的输入模态
  - 截断超长 tool output
  - 保留 tool result 的结构化边界，而不是把所有结果拍平成纯文本
- 推理摘要、工具摘要、hook 提示不应只以最终 `messages` 形式存在
  - 必须能在 `response_items` 或 `turn_events` 中追溯原始来源

### 10.13 Runtime Event Stream 与 Snapshot

参考：

- [events.rs](D:/学习/codex/codex-rs/core/src/tools/events.rs)
- [codex_delegate.rs](D:/学习/codex/codex-rs/core/src/codex_delegate.rs)

建议事件类型：

- `session_configured`
- `turn_started`
- `turn_completed`
- `turn_aborted`
- `raw_response_item`
- `token_usage`
- `message_delta`
- `reasoning_delta`
- `tool_begin`
- `tool_end`
- `file_change`
- `approval_requested`
- `approval_resolved`
- `request_user_input`
- `browser_updated`
- `warning`
- `error`

设计要求：

- Renderer 主要消费 append-only 事件流，而不是频繁全量重算线程状态
- 线程详情页采用 `snapshot + incremental events` 模型
  - 初次进入加载快照
  - 后续只订阅增量事件
- 每个事件至少包含：
  - `event_id`
  - `thread_id`
  - `turn_run_id`（可空）
  - `created_at`
  - `event_type`
  - `payload_json`
  - `sequence_no`
- `turn_events` 必须可以支持重放，至少能重建：
  - 工具执行时间线
  - 审批卡片状态
  - browser tab 更新
  - artifact 生成
  - turn 完成/失败状态
- 子代理事件回流父线程时，必须保留：
  - `origin_thread_id`
  - `source_thread_id`
  - `parent_thread_id`
  - 避免 UI 将其误判为父线程本地产生的工具事件

## 11. Agent Loop 伪代码

```ts
async function submissionLoop(session: Session) {
  while (true) {
    const sub = await session.queue.take();
    switch (sub.type) {
      case "user_input":
        await enqueueOrStartTurn(session, sub);
        break;
      case "interrupt":
        await interruptActiveTurn(session);
        break;
      case "approval_response":
        await resolveApproval(session, sub);
        break;
      case "dynamic_tool_response":
        await resolveDynamicTool(session, sub);
        break;
      case "shutdown":
        return;
    }
  }
}

async function runTurn(session: Session, turn: TurnContext) {
  await maybePreSamplingCompact(session, turn);
  await recordContextUpdates(session, turn);
  await injectSkillsPluginsExtensions(session, turn);
  await runStartupHooks(session, turn);

  let canDrainPendingInput = false;

  while (true) {
    const pendingInput = canDrainPendingInput ? takePendingInput(turn) : [];
    await recordInputs(session, turn, pendingInput);

    const prompt = await buildPromptFromHistory(session, turn);
    const streamResult = await runSamplingRequest(session, turn, prompt);

    await recordStreamOutputs(session, turn, streamResult);
    await drainInFlightToolCalls(session, turn);

    const followUp = streamResult.needsFollowUp || hasPendingInput(turn);
    if (!followUp) {
      await runStopHooks(session, turn);
      return completeTurn(session, turn);
    }

    if (tokenLimitReached(session, turn)) {
      await runMidTurnCompact(session, turn);
    }

    canDrainPendingInput = true;
  }
}
```

## 12. 子代理设计

### 12.1 原则

子代理不是函数，而是 child session / child thread。

参考：

- [codex_delegate.rs](D:/学习/codex/codex-rs/core/src/codex_delegate.rs)
- [spawn.rs](D:/学习/codex/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)

### 12.2 继承规则

子代理继承：

- 环境选择
- approval policy
- sandbox policy
- thread lineage
- 部分历史
- 默认模型

子代理可覆盖：

- role
- model
- reasoning effort
- prompt

### 12.3 模式

- `interactive child session`
- `one-shot child session`
- `fork full history`
- `fork last N turns`
- `fork no history`

### 12.4 内建角色

- `explorer`
- `implementer`
- `reviewer`
- `planner`
- `watcher`

### 12.5 父子关系

- 子代理事件回流父线程
- 审批由父线程托管
- 子代理不能自我中断
- 父线程可以中断子线程

## 13. 模型与 Provider 抽象

### 13.1 支持范围

- OpenAI compatible API
- Anthropic
- Gemini
- OpenRouter
- Ollama
- vLLM
- 自建 HTTP Gateway

### 13.2 模型对象

`ModelProfile` 建议字段：

- `model_id`
- `provider_id`
- `display_name`
- `context_window`
- `supports_streaming`
- `supports_tool_calling`
- `supports_parallel_tool_calls`
- `supports_json_output`
- `supports_multimodal_input`
- `supports_reasoning_summary`
- `pricing`
- `health_status`
- `default_temperature`
- `default_max_output_tokens`

### 13.3 路由策略

- 全局默认模型
- workspace 默认模型
- thread override
- role-specific model
- planner / executor / summarizer 分离
- subagent 独立模型

### 13.4 模型配置持久化

`codexh` 的用户级模型配置不入 SQLite，统一存放到：

- `C:\Users\当前用户\.codexh\config.toml`

建议 `config.toml` 至少覆盖：

- `providers`
- `models`
- `default_model`
- `workspace_defaults`
- `routing`
- `feature_flags`
- `credentials` 的引用信息

存储原则：

- 用户主动维护的 Provider 和模型定义写入 `config.toml`
- API Key 优先使用环境变量或系统凭据管理器，`config.toml` 仅保存引用
- SQLite 不建立 `provider_configs`、`model_profiles`、`thread_model_overrides` 三张配置表
- 为了回放 turn，可在 `turn_runs` 中保存无密钥的 `resolved_model_snapshot_json`
- 最近使用记录、健康状态缓存、连通性测试结果可以写入 SQLite，但它们属于运行时状态，不属于用户模型配置

## 14. Terminal / Patch / Git

### 14.1 Terminal

- 使用 pty 驱动
- 支持流式 stdout/stderr
- 支持长命令、挂起、取消
- 与 turn 绑定命令 run 记录

### 14.2 Patch

首选 patch 方式：

- 文本文件：`apply_patch`
- 结构化文件：可选 AST 编辑
- 大文件或特殊格式：整文件替换作为 fallback

### 14.3 Git

支持：

- diff
- stage
- commit
- revert
- worktree
- 脏工作区保护

### 14.4 工作流

推荐标准流：

1. repo map
2. create plan
3. patch / command
4. run tests
5. review diff
6. commit

## 15. 审批与安全

### 15.1 审批对象

- shell exec
- apply_patch
- destructive file ops
- git push / force actions
- MCP tool with app side effects
- browser side effect actions
- external network

### 15.2 审批策略

- allow once
- allow for session
- allow and remember
- deny
- guardian / auto review

### 15.3 统一 orchestrator

所有工具统一走审批与沙箱判断，不允许各自实现分叉逻辑。

### 15.4 MCP 特有风险

- 外部应用副作用
- 数据出境
- OAuth / auth elicitation
- server-owned user flow

### 15.5 项目信任等级与默认权限

参考 [codex_thread.rs](D:/学习/codex/codex-rs/core/src/codex_thread.rs) 中的 `permission_profile`、`active_permission_profile`、`sandbox_policy` 抽象。

建议引入 `project_trust_level`：

- `untrusted`
- `trusted`
- `full-access`

映射规则建议：

- `project_trust_level` 决定线程默认：
  - file system sandbox
  - network policy
  - approval policy
  - 是否允许额外权限申请
- `chat / projectless` 线程默认按 `untrusted` 启动，除非用户显式提升
- 项目模式线程从 `project` 记录继承 trust level
- fork / subagent 默认继承父线程 trust level，不允许静默放宽
- 用户修改 trust level 时，不直接改运行中 turn，而是以 `thread_settings` submission 进入队列
- UI 必须明确展示当前：
  - trust level
  - sandbox mode
  - approval policy
  - network reachability

### 15.6 审批记忆与 Canonicalization

参考：

- [command_canonicalization.rs](D:/学习/codex/codex-rs/core/src/command_canonicalization.rs)
- [apply_patch.rs](D:/学习/codex/codex-rs/core/src/apply_patch.rs)

设计要求：

- 系统必须构造稳定的 `approval_key`
  - 由 `tool_kind + canonicalized_payload + project_scope` 组成
- `allow once`
  - 只对当前请求 ID 生效
- `allow for session`
  - 只写入当前 app runtime 的内存态
- `allow and remember`
  - 持久化到 SQLite
  - 默认按 `project_id + approval_key` 作用域匹配
- shell / git / patch 的审批匹配不能简单按原始字符串比较
  - 需要 canonicalize argv
  - 尽量消除 wrapper path、shell 包裹层带来的误差
- browser / MCP / network / patch 审批应使用独立 key 空间
  - 不允许把 shell 的 remembered approval 误用于浏览器或 MCP
- 高风险 destructive 操作、OAuth 流程、外部账户授权默认不允许 `remember`
  - 必须走更严格的审批策略或显式 allowlist

## 16. SQLite 数据模型

### 16.1 核心表

- `projects`
- `workspaces`
- `threads`
- `messages`
- `response_items`
- `turn_runs`
- `turn_events`
- `tool_calls`
- `tool_call_events`
- `command_runs`
- `file_changes`
- `diff_artifacts`
- `skills`
- `skill_versions`
- `skill_install_records`
- `plugins`
- `plugin_versions`
- `project_plugin_bindings`
- `plugin_hook_runs`
- `knowledge_bases`
- `knowledge_import_runs`
- `knowledge_documents`
- `knowledge_concepts`
- `knowledge_fts`
- `thread_knowledge_bindings`
- `mcp_servers`
- `mcp_server_tools`
- `mcp_resources_cache`
- `approval_records`
- `subagent_runs`
- `artifacts`

### 16.2 关键设计

- `messages` 保存用户与助手层级消息
- `response_items` 保存更底层的模型事件片段
- `turn_events` 保存可回放运行轨迹
- `turn_runs` 内保存 `resolved_provider_id`、`resolved_model_id`、`resolved_model_snapshot_json`
- `tool_calls` 保存统一工具调用记录
- 用户模型配置不单独建表，统一由 `C:\Users\当前用户\.codexh\config.toml` 管理
- `artifacts` 保存聊天输出产物、附件、导出文件的元数据索引
- `mcp_servers` 与 `mcp_server_tools` 单独索引，便于 tool search 和依赖管理

`threads` 表建议额外保存：

- `thread_mode`
- `workspace_kind`
- `cwd`
- `runtime_workspace_roots_json`
- `project_id`（可空）
- `workspace_id`（可空）

模式约束建议：

- 项目模式线程要求 `thread_mode = project`
- 对话模式线程要求 `thread_mode = chat`
- 对话模式通常对应 `workspace_kind = projectless`
- 项目模式通常对应 `workspace_kind = project`

插件相关建议：

- `plugins`
  - 插件基础元数据、来源、安装路径、manifest 摘要
- `plugin_versions`
  - 版本、hash、更新时间
- `project_plugin_bindings`
  - `project_id`
  - `plugin_id`
  - `enabled`
  - `enabled_at`
  - `disabled_at`
  - `settings_json`
- `plugin_hook_runs`
  - 记录 `startup` / `resume` / `clear` 等 hook 或原生 bootstrap 的执行结果

知识库相关建议：

- `knowledge_bases`
  - `knowledge_base_id`
  - `scope`
  - `project_id`
  - `display_name`
  - `bundle_root`
  - `okf_version`
  - `status`
  - `created_at`
- `knowledge_import_runs`
  - 记录导入任务、来源路径、提取状态、错误信息、生成 bundle 位置
- `knowledge_documents`
  - 记录原始导入文件
- `knowledge_concepts`
  - 记录每个 OKF concept 的 concept id、type、title、path、source document
- `knowledge_fts`
  - FTS5 虚表，索引 title、description、tags、body
- `thread_knowledge_bindings`
  - 记录某个 thread 当前可见的知识库集合

建议作用域：

- `scope = global`
- `scope = project`
- `scope = imported`

### 16.3 artifacts 表设计建议

`artifacts` 至少应包含：

- `artifact_id`
- `thread_id`
- `turn_run_id`
- `message_id`
- `tool_call_id`
- `artifact_kind`
- `display_name`
- `absolute_path`
- `relative_path`
- `mime_type`
- `size_bytes`
- `sha256`
- `source_kind`
- `is_user_visible`
- `created_at`

建议行为：

- 所有用户可见交付物都登记到 `artifacts`
- `absolute_path` 指向真实文件路径
- 项目线程优先写入 `<repo>/.codexh/outputs/...`
- 非项目线程优先写入 `C:\Users\当前用户\.codexh\outputs\...`
- 文件被用户手动删除后，UI 下次刷新时将 `artifacts` 状态标记为 `missing`

### 16.4 浏览器状态表建议

如果 `codexh` 做桌面内嵌浏览器，建议增加以下表：

- `browser_sessions`
  - 记录 browser session、隔离分区、所属 thread
- `browser_tabs`
  - 记录 tab_id、session_id、current_url、title、favicon、is_active
- `browser_navigation_events`
  - 记录导航、重定向、失败、下载触发、页面完成事件
- `browser_action_runs`
  - 记录 Agent 发起的浏览器动作及其审批结果

说明：

- 浏览器截图、下载文件、页面导出仍统一登记到 `artifacts`
- `browser_tabs` 保存轻量状态，不保存大块 HTML
- 页面文本快照建议作为 artifact 或缓存文件，而不是直接塞进 SQLite

### 16.5 知识库与 OKF 存储建议

知识库内容应遵循“bundle 在磁盘，索引在 SQLite”的原则。

磁盘保存：

- OKF bundle 全量文件
- 原始导入文件副本或引用路径
- `viz.html`
- 可选 embedding cache

SQLite 保存：

- 知识库元数据
- concept 元数据
- source mapping
- FTS 索引
- thread 绑定关系

推荐目录：

- 全局：
  - `C:\Users\当前用户\.codexh\knowledge\global\bundles\<knowledge_base_id>\`
- 项目：
  - `<repo>/.codexh/knowledge\bundles\<knowledge_base_id>\`

如果用户导出 bundle：

- 可以直接把整个目录作为可移植 OKF bundle 分享
- 不要求对方使用 `codexh` 才能阅读
- 这是 OKF 作为 vendor-neutral 格式的核心价值

## 17. Electron 工程结构建议

```text
apps/desktop/
  src/main/
    app/
    browser/
    config/
    ipc/
    db/
    knowledge/
    plugins/
    runtime/
    skills/
    mcp/
    exec/
    security/
  src/preload/
  src/renderer/
    pages/
    components/
    stores/
    hooks/
packages/
  agent-runtime/
  browser-runtime/
  knowledge-runtime/
  plugin-runtime/
  tool-runtime/
  mcp-runtime/
  skills-runtime/
  provider-adapters/
  shared-types/
```

说明：

- `main/browser`：BrowserView、tab manager、navigation events、screenshot capture
- `main/config`：读取、校验、写回 `C:\Users\当前用户\.codexh\config.toml`
- `main/runtime`：session loop、turn runner、subagent manager
- `main/knowledge`：导入器、OKF writer、索引器、bundle manager、thread binder
- `main/plugins`：插件安装、启停、manifest 解析、workflow pack adapter
- `main/skills`：loader、manager、watcher、installer
- `main/mcp`：manager、connection pool、resource cache
- `main/db`：SQLite schema 与 DAO
- `browser-runtime`：浏览器工具抽象、页面状态桥接、automation adapter 接口
- `knowledge-runtime`：knowledge tools、FTS 检索、bundle traversal、OKF utilities
- `plugin-runtime`：plugin manifest、hook bridge、project binding、startup bootstrap
- `renderer`：纯 UI，不直接接触高风险执行

### 17.1 Renderer / Main IPC 合同

参考 Codex 的线程与事件驱动思路，`codexh` 应把桌面端 IPC 明确分成三类：

1. Query IPC
   - `listThreads`
   - `getThreadSnapshot`
   - `listSkills`
   - `getConfig`
   - `listPlugins`
   - `listKnowledgeBases`

2. Command IPC
   - `createThread`
   - `sendMessage`
   - `interruptThread`
   - `resolveApproval`
   - `answerUserPrompt`
   - `installPlugin`
   - `setProjectPluginEnabled`
   - `importKnowledge`
   - `openBrowserTab`
   - `navigateBrowserTab`

3. Subscription IPC
   - `runtime_event_stream`
   - `thread_snapshot_invalidated`
   - `background_task_updated`

实现约束：

- Renderer 不直接访问：
  - SQLite
  - 文件系统写入
  - BrowserView
  - MCP transport
  - Shell / Patch / Git 执行器
- preload 只暴露窄接口，不暴露 `ipcRenderer` 原始能力
- IPC payload 必须版本化并做 schema 校验，建议：
  - request schema
  - response schema
  - event schema
- 高风险动作必须只允许通过 main/runtime 发起，不能由 renderer 绕过审批链路
- UI 层所有线程状态恢复都优先走：
  - `getThreadSnapshot`
  - 然后接 `runtime_event_stream`
  - 而不是自行拼装本地缓存真相

## 18. 版本规划

### V1

目标：

- 跑通单线程 Agent 核心闭环
- Electron + SQLite 基础稳定
- `C:\Users\当前用户\.codexh\config.toml` 读写稳定
- `C:\Users\当前用户\.codexh\skills\system` 与 `...\skills\installed` 加载可用
- 本地文档导入并生成 OKF bundle 可用
- SQLite FTS5 知识检索可用
- hosted / standalone `web_search` 可用
- 基础 `in-app browser` 预览可用
- 项目模式下可启用 / 关闭 `Superpowers`
- shell / patch / git / basic MCP 可用

必做：

- submission loop
- active turn
- tool router / registry / orchestrator
- MCP tool call
- read_mcp_resource
- skill loader / manager
- model provider adapter

暂缓：

- 团队 skill 分发
- 企业 admin scope
- 复杂签名体系

### V2

目标：

- 让系统更像完整桌面工作台

新增：

- 对话安装 skill
- 子代理并行
- `Browser Use` / `Playwright` MCP 自动化
- embedding 语义检索
- 知识库可视化增强与 graph view
- 更多项目级 workflow packs
- richer MCP auth elicitation
- worktree / advanced git

### V3

目标：

- 平台化

新增：

- skill marketplace
- team shared skills
- enterprise policy
- signed skills
- remote runtime / distributed agent execution

## 19. 研发顺序

### 阶段 1：基础壳

- Electron 主进程
- React renderer
- SQLite 初始化
- Thread / Message UI

### 阶段 2：单线程 Runtime

- submission queue
- active turn
- turn runner
- history store

### 阶段 3：工具系统

- ToolSpec
- ToolRegistry
- ToolRouter
- ToolOrchestrator
- shell / patch / git

### 阶段 4：skills

- skill roots
- loader
- manager
- injection
- system skills 打包

### 阶段 5：MCP

- McpManager
- MCP tool exposure
- MCP tool call
- MCP resource access

### 阶段 6：子代理

- child session
- event forwarding
- parent approval delegation

### 阶段 7：办公能力

- docx / pptx / xlsx system skills
- artifact workflows

## 20. 最终建议

这个产品最重要的不是把 UI 做得像 Codex，而是把以下 4 个骨架做对：

- `Skill Loader + Injection`
- `Submission Loop + Turn Runner`
- `Tool Router + Tool Orchestrator`
- `MCP Runtime + Resource + Approval`

如果这 4 层做稳了，这个桌面 Agent 会真正具备 Codex 风格的执行力；如果只做了聊天界面、模型切换和终端面板，它最终会退化成一个“能发命令的聊天壳”。
