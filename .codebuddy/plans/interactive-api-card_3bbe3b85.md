---
name: interactive-api-card
overview: 新增聊天交互 API 卡片功能(预制表单控件库、AI 按接口文档生成卡片、IPC 代理调用、卡片内展示结果、支持授权 token 填写),并对 2 万行的 App.tsx 按边界做行为保持式模块拆分。
design:
  architecture:
    framework: react
  styleKeywords:
    - 开发者工具美学
    - 深色卡片
    - 主题自适应
    - 微动效
    - 精致状态反馈
  fontSystem:
    fontFamily: PingFang SC
    heading:
      size: 15px
      weight: 600
    subheading:
      size: 13px
      weight: 500
    body:
      size: 14px
      weight: 400
  colorSystem:
    primary:
      - "#42A5FF"
      - "#F28B35"
      - "#33C26F"
    background:
      - "#1C1C1C"
      - "#212121"
      - "#1A1A1A"
    text:
      - "#F4F4F3"
      - "#D7D4DD"
      - "#A09BA9"
    functional:
      - "#33C26F"
      - "#F28B35"
      - "#FF5C5C"
      - "#42A5FF"
todos:
  - id: form-controls
    content: 新建 form-controls.tsx/.css,预制全套表单控件与 Field 包装
    status: completed
  - id: api-card-logic
    content: 新建 api-card.ts:配置解析校验、请求模板替换、auth 注入、响应格式化
    status: completed
  - id: ipc-http-proxy
    content: main 新增 http-proxy.ts 与 http:request 通道,preload 与 env.d.ts 同步暴露
    status: completed
  - id: api-card-component
    content: 新建 ApiCardMessage 组件与样式:授权区、表单提交、卡片内结果展示
    status: completed
    dependencies:
      - form-controls
      - api-card-logic
      - ipc-http-proxy
  - id: markdown-integration
    content: App.tsx 接入 api-card 块:联合类型、fence 解析、渲染分支
    status: completed
    dependencies:
      - api-card-component
  - id: prompt-guidance
    content: agent-runtime 系统提示追加 api-card 输出规约与 auth 约定
    status: completed
  - id: tests-verify
    content: 新增 tests/api-card.test.ts,运行 vitest 与 typecheck 验证
    status: completed
    dependencies:
      - api-card-logic
      - markdown-integration
      - ipc-http-proxy
  - id: split-icons-markdown
    content: 抽取 icons.tsx 与 markdown.tsx 模块,同步更新测试 import 并验证
    status: completed
    dependencies:
      - tests-verify
  - id: split-workspace-lib
    content: 用 [subagent:code-explorer] 核对符号依赖,抽取 lib/ 与 workspace/ 模块并验证
    status: completed
    dependencies:
      - split-icons-markdown
---

## 用户需求

用户希望在桌面 Agent 应用的聊天框中新增交互式接口卡片能力，并对超大渲染文件做合理拆分：

1. 先预制一套常用表单组件；
2. 当用户在聊天中提供接口文档时，AI 根据文档生成一张可交互卡片，用户输入信息后点击"确定"调用接口，返回信息在卡片内展示；
3. 卡片风格必须与程序现有风格保持一致；接口需要授权时，卡片要提供填写授权 token 的位置；
4. App.tsx 文件过大（约 2 万行），需要进行合理的模块拆分。

## 产品概述

在现有聊天消息流中新增一类"API 交互卡片"消息块。AI 回复中包含约定格式的配置块时，聊天界面自动将其渲染为一张与现有图表块风格统一的表单卡片。卡片包含接口标题、描述、按需出现的授权 token 输入区、按接口文档生成的输入项以及"确定"按钮。用户提交后，卡片内显示请求状态、耗时与格式化后的响应内容（或错误信息），可修改参数后再次调用，全程不离开聊天上下文。同时，将渲染层单文件按"图标、markdown 渲染、纯函数库、工作区面板"等边界拆分为多个内聚模块，主文件只保留组合逻辑，行为完全保持不变。

## 核心功能

- 预制常用表单控件库：单行文本、多行文本、数字、密码、下拉选择、单选、复选、开关、日期、时间、键值对编辑器（headers/动态参数）、JSON 编辑器，统一 label、必填标记与错误提示外观
- 聊天消息新增 api-card 块：AI 按约定格式输出配置，前端解析为交互卡片；配置非法时展示错误卡片而非崩溃
- 授权区：配置声明需要授权时，表单顶部展示独立的 token 输入（密码式遮蔽、可切换显示）,token 仅留在本次会话的卡片内，不持久化、不写入聊天记录
- 卡片表单渲染与必填校验，支持默认值、占位提示、选项配置
- 点击确定后组装请求（路径参数、query、header、body 模板替换、授权注入）并调用接口，带加载状态与超时控制
- 卡片内结果区展示状态码、耗时、格式化后的响应或错误详情，可折叠查看原始内容，支持修改后重试
- App.tsx 行为保持式拆分：图标、markdown 渲染管线、项目文件/对话/配置纯函数、工作区面板分别迁入独立模块，现有功能与测试不受影响

## 技术栈选择

- 渲染进程：React 19 + TypeScript + 原生 CSS（沿用项目现有 CSS 变量多主题体系与 electron-vite 构建，不引入任何新组件库/样式框架）
- 桌面壳：Electron（主进程 `net.fetch` 发起 HTTP 请求，规避渲染进程跨域；`net` 已在 main/index.ts 第 1 行引入）
- AI 侧：`packages/agent-runtime` 系统提示词引导模型输出 api-card 配置块（复用 7391 行 echarts 引导语的成熟做法）
- 测试：vitest(`tests/` 现有 37 个用例），类型检查 `pnpm typecheck`

## 实现方案

整体复刻现有 `echarts` 自定义消息块的成熟链路：**fence 解析 → 专用组件渲染 → 纯函数可测 → 错误卡片兜底**。

1. **块识别**:AI 输出 ```` ```api-card ```` 围栏代码块，内容为严格 JSON 配置；`parseMarkdownBlocks`(App.tsx 18801 行，已导出）在闭合围栏且语言为 `api-card` 时产出 `{ kind: "api-card", content }`，未闭合围栏保持 code 块，与 echarts 行为一致。
2. **配置解析**:`parseApiCardConfig` 纯函数，校验 JSON 合法性、体积上限（64KB)、危险键（`__proto__`/`constructor`/`prototype`，与 EChartsMessageChart.tsx 第 9 行 FORBIDDEN_CONFIG_KEYS 同款防护）、method/url/fields/auth 结构，返回 `{ ok: true, config } | { ok: false, error }`。
3. **授权注入**：配置含 `auth` 块时，卡片渲染独立授权区（密码输入）；`buildApiRequest(config, values, authToken)` 按类型注入——bearer 注入 `Authorization: Bearer <token>`,apiKey 注入指定 header 或 query 参数，basic 注入 `Authorization: Basic <base64>`(btoa)。token 仅存组件 state。
4. **请求构建**:`buildApiRequest` 纯函数，先做必填校验，再将 `{{fieldName}}` 占位符替换进 url 路径、query、header 值与 bodyTemplate；路径/query 值做 `encodeURIComponent`,body 替换后整体 `JSON.parse` 校验，失败返回明确错误。
5. **接口调用**：新增 `apps/desktop/src/main/http-proxy.ts`（对齐 main/ 下 git-service.ts/update-service.ts 的服务文件惯例）,`http:request` handler 用 `net.fetch` 代理：仅允许 http/https、方法白名单、30s 超时（`AbortSignal.timeout`)、响应体 1MB 截断，返回结构化结果。preload 暴露 `requestHttp`,`env.d.ts` 补类型。
6. **结果展示**：卡片内结果区展示状态徽标（2xx 绿/4xx 橙/5xx 红）、耗时、格式化 JSON（超长截断+details 折叠原文）；网络/校验错误展示错误区；全部状态留在卡片组件内，不写入聊天时间线（符合用户选择）。
7. **AI 引导**：在 `packages/agent-runtime/src/index.ts` 7391 行 echarts 引导语后追加 api-card 输出规约：触发条件（用户提供接口文档且需要交互输入）、严格 JSON、字段类型清单、`{{field}}` 模板规则、`auth` 块约定、安全约束（不臆造密钥/令牌，需要授权时声明 auth 由用户填写）。
8. **App.tsx 拆分**：功能落地并验证后，按既有边界分三批做纯搬移（不改任何逻辑）:

- 批次一：`icons.tsx`(19589-20417 全部图标，零依赖最安全）+ `markdown.tsx`(MarkdownBlock 类型、parseMarkdownBlocks、renderMarkdownInline、highlightMarkdownCode、CopyTextButton、renderMarkdownBlock/renderMarkdownDocument 及 LRU 缓存，api-card 的 fence/case 随搬移自然落入该模块）;
- 批次二：`lib/`(project-files、conversation、config-utils 等已 export 的纯函数）;
- 批次三：`workspace/`(RightWorkspacePanel、Terminal/Browser/Git/Files 工作区、FilePreviewDialog、UsageStatisticsPanel 等面板组件，均为显式 props 的函数组件，逐个核对外层符号引用后抽取）。
已验证渲染层无循环依赖（仅 main.tsx 引用 App)；三个测试文件（renderer-markdown/thread-ui-state/mcp-config）从 App 导入的符号同步改为新路径。每批后跑 `pnpm typecheck` + `pnpm test`。

## 实现要点

- **性能**：配置解析用 `useMemo(configText)` 缓存（同 EChartsMessageChart 325 行）;App.tsx 18396 行已有 markdown 渲染 LRU 缓存，缓存的是不可变 ReactNode，卡片组件 state 按挂载位置隔离（与 CopyTextButton 同理），共享缓存安全；表单状态为卡片局部 state，不触发消息列表重渲染；结果 JSON 美化仅在成功后执行一次并截断；主进程 1MB 截断防止大响应拖垮 IPC。
- **日志/安全**：主进程不输出请求头（可能含 token)；错误通过 IPC 返回值带回，不抛裸异常；模板替换为纯字符串操作，无 eval;JSON 解析拒绝危险键；token 不持久化、不进入聊天消息与日志。trade-off:http/https 不做域名白名单（桌面 Agent 场景，卡片由用户自己提供的文档生成，与 echarts 信任级别一致）。
- **影响面控制**:App.tsx 功能接入仅加 1 个联合类型成员、fence 分支、renderMarkdownBlock 1 个 case、import 1 行；非法配置渲染错误卡片（仿 InvalidEChartsConfig)，向后兼容现有消息；拆分批次为纯搬移，行为保持，失败可整批回退。

## 架构设计

```mermaid
flowchart LR
  A[AI 回复含 api-card 围栏块] --> B[parseMarkdownBlocks<br/>App.tsx → 拆分后 markdown.tsx]
  B --> C[ApiCardMessage 组件<br/>parseApiCardConfig 校验]
  C --> D[form-controls 控件渲染表单<br/>+ 授权 token 区]
  D --> E[用户填写 + 确定<br/>buildApiRequest 模板替换/必填校验]
  E --> F[window.codexh.requestHttp<br/>preload IPC]
  F --> G[main: http-proxy.ts<br/>net.fetch 代理 超时/截断]
  G --> H[目标接口]
  H --> I[卡片内结果区<br/>状态码/耗时/格式化响应]
```

拆分后模块关系：`main.tsx → App.tsx（组合）→ {icons, markdown, lib/*, workspace/*, api-card-message, form-controls, EChartsMessageChart}`，单向依赖无环。

## 目录结构

```
apps/desktop/src/renderer/
├── form-controls.tsx        # [NEW] 预制表单控件库。实现 Field 包装(label/必填红点/错误/帮助文本)与 TextInput、TextArea、NumberInput、PasswordInput、SelectInput、RadioGroup、CheckboxGroup、Switch、DateInput、TimeInput、KeyValueEditor(键值对增删行)、JsonEditor(带校验多行输入)。全部受控纯展示,无业务耦合,供卡片及后续表单场景复用。
├── form-controls.css        # [NEW] 控件样式。全部使用 --surface-card/--border/--text-muted/--blue 等现有变量适配多主题;聚焦态 --blue 描边+光晕;hover/active 用 --motion-fast 过渡。
├── api-card.ts              # [NEW] 卡片纯逻辑(导出供 vitest)。ApiCardConfig/ApiCardField/ApiCardAuth 类型;parseApiCardConfig(64KB 上限、危险键、结构校验);buildApiRequest({{field}} 替换、query 编码、body JSON 校验、必填校验、auth 注入);formatApiResponseBody(美化/截断)。
├── api-card-message.tsx     # [NEW] ApiCardMessage 组件。useMemo 解析配置,失败渲染错误卡片;成功渲染头部(标题+方法徽标+描述)、授权区(auth 存在时)、表单、确定/重置;提交走 window.codexh.requestHttp;本地 state 管理 values/token/errors/loading/result;结果区状态徽标+耗时+格式化 JSON+折叠原文,支持修改重试。
├── api-card-message.css     # [NEW] 卡片样式。圆角卡片 chrome 对齐 .message-chart(echarts-message-chart.css),颜色全部走 CSS 变量;方法徽标分色(GET 蓝/POST 绿/PUT 橙/DELETE 红);结果区 mono 字体;出现动效用 --motion-base 淡入上移。
├── App.tsx                  # [MODIFY] 功能接入:约 447 行 MarkdownBlock 联合类型 +{ kind: "api-card"; content: string };约 18855 行 fence 闭合分支支持 api-card;约 92 行 import ApiCardMessage;约 18537 行 renderMarkdownBlock +case "api-card"。拆分阶段:移出图标/markdown/lib/workspace 符号并改为 import,仅保留 App() 主组件与组合逻辑。
├── env.d.ts                 # [MODIFY] Window.codexh 新增 requestHttp 类型声明(契约同 IPC)。
├── icons.tsx                # [NEW|拆分] 约 50 个 SVG 图标组件(自 App.tsx 19589-20417 纯搬移),App.tsx 改为 import。
├── markdown.tsx             # [NEW|拆分] MarkdownBlock 类型、parseMarkdownBlocks、renderMarkdownInline、highlightMarkdownCode、CopyTextButton、renderMarkdownBlock、renderMarkdownDocument 及 LRU 缓存(自 App.tsx 纯搬移),api-card 分支随搬移落入此文件。
├── lib/project-files.ts     # [NEW|拆分] buildProjectFileTree/resolveProjectFilePath/buildProjectFolderManifest/getLatestFileSnapshot/buildFileSnapshotDiff*/getProjectFileChangeKinds 等纯函数。
├── lib/conversation-utils.ts# [NEW|拆分] buildContextUsage/formatComposerAttachments/buildTimelineEntries/buildConversationTurnSections/reconcile* 系列等对话纯函数。
├── lib/config-utils.ts      # [NEW|拆分] parseMcpJsonConfig/serializeMcpJsonConfig/normalizeDraftConfig/createEmptyProvider/createModelProfile/buildConfigToSave 等配置归一化助手(19149-19588)。
├── workspace/               # [NEW|拆分] 按领域分文件(terminal/browser/git/files/usage/composer)承接 RightWorkspacePanel、FilePreviewDialog、GitChangesWorkspace、ProjectFilesWorkspace、UsageStatisticsPanel、MemoryPagination、TerminalPanel、ComposerModelPicker 等面板组件,props 契约不变。
apps/desktop/src/main/
├── http-proxy.ts            # [NEW] 通用 HTTP 代理。校验 url 仅 http/https、方法白名单,net.fetch 发起请求,30s 超时、1MB 响应截断,返回结构化结果;不记录请求头;对齐 main/ 服务文件惯例。
├── index.ts                 # [MODIFY] 引入 http-proxy,在现有 ipcMain.handle 列表(约 432 行 threads:send 附近)注册 "http:request"。
apps/desktop/src/preload/
├── index.ts                 # [MODIFY] api 对象新增 requestHttp: (payload) => ipcRenderer.invoke("http:request", payload)。
packages/agent-runtime/src/
├── index.ts                 # [MODIFY] 7391 行 echarts 引导语后追加 api-card 系统提示:JSON schema、字段类型清单、{{field}} 模板规则、auth 块约定、触发条件与安全约束。
tests/
├── api-card.test.ts         # [NEW] vitest 用例:parseApiCardConfig 合法/非法/超限/危险键/auth 结构;buildApiRequest 路径/query/header/body 替换、必填校验、三种 auth 注入;formatApiResponseBody 截断;parseMarkdownBlocks 对 api-card 闭合/未闭合围栏(参照 renderer-markdown.test.ts 写法)。
├── renderer-markdown.test.ts# [MODIFY] 拆分后将从 App 导入的符号改为 markdown.tsx 与 lib/* 新路径。
├── thread-ui-state.test.ts  # [MODIFY] 拆分后导入路径改为 lib/conversation-utils 等新模块。
├── mcp-config.test.ts       # [MODIFY] 拆分后导入路径改为 lib/config-utils。
```

## 关键代码结构

```ts
// api-card.ts:卡片配置契约(AI 输出与解析器共用)
export type ApiCardFieldType =
  | "text" | "textarea" | "number" | "password"
  | "select" | "radio" | "checkbox" | "switch"
  | "date" | "time" | "keyvalue" | "json";

export interface ApiCardField {
  name: string; label: string; type: ApiCardFieldType;
  required?: boolean; defaultValue?: unknown;
  placeholder?: string; help?: string;
  options?: Array<{ label: string; value: string }>; // select/radio/checkbox
}

export interface ApiCardAuth {           // 授权约定:token 由用户在卡片内填写
  type: "bearer" | "apiKey" | "basic";
  in?: "header" | "query";               // apiKey 专用,默认 "header"
  name?: string;                         // apiKey 参数名,默认 "X-API-Key"
  label?: string; placeholder?: string; required?: boolean;
}

export interface ApiCardConfig {
  title: string; description?: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;                           // 支持 {{field}} 路径参数
  auth?: ApiCardAuth;
  headers?: Record<string, string>;      // 值支持 {{field}}
  query?: Record<string, string>;        // 值支持 {{field}}
  bodyTemplate?: string;                 // JSON 字符串模板,含 {{field}}
  fields: ApiCardField[];
}

export type ParsedApiCardConfig =
  | { ok: true; config: ApiCardConfig }
  | { ok: false; error: string };
```

```ts
// IPC 契约(http-proxy.ts / preload / env.d.ts 三处一致)
export interface HttpRequestPayload {
  method: string; url: string;
  headers?: Record<string, string>;
  body?: string;                         // 已序列化
}
export type HttpRequestResult =
  | { ok: true; status: number; statusText: string;
      headers: Record<string, string>; bodyText: string;
      truncated: boolean; durationMs: number }
  | { ok: false; error: string };
```

## 设计风格

沿用应用现有的开发者工具美学与深色卡片语言（多主题 CSS 变量体系），卡片 chrome 与聊天中的 ECharts 图表块（.message-chart）保持同一视觉家族：8px 圆角、1px 细边框、头部标题栏+操作按钮区。与 echarts 块硬编码深色不同，api 卡片全部颜色经 --surface-card、--border、--text-muted、--green、--orange、--blue 等现有变量实现，自动适配明暗多套主题，确保"风格与程序一致"。控件聚焦态描边发光、按钮 hover 提亮、结果区淡入上移，提供精致的状态反馈与微动效。

## 布局与块设计（自上而下）

- **卡片头部**：接口标题（15px/600)+ HTTP 方法徽标（GET 蓝/POST 绿/PUT 橙/DELETE 红，圆角胶囊）+ 可选描述（13px,--text-muted)，右上角折叠按钮，底部 1px 分隔线
- **授权区**(auth 存在时）：独立分区带小锁图标与"授权"标签，密码式 token 输入（右侧眼睛切换明文），帮助文本说明注入方式；token 仅留内存，刷新/重挂载即清空
- **表单区**：单列纵向排布，label 在上控件在下，必填项标红点；聚焦时控件 --blue 描边+2px 光晕；校验错误红色 12px 置于控件下方；KeyValueEditor 为可增删的两列行；switch/checkbox 用自定义滑块与方框
- **操作区**：右对齐"确定"主按钮（蓝底白字，hover 提亮，loading 转圈禁用并防抖）+"重置"幽灵按钮
- **结果区**：提交后出现，顶部状态条（状态码徽标 2xx 绿/4xx 橙/5xx 红 + 耗时 ms + 截断标记），下方 mono 字体格式化 JSON（最大高度滚动）,details 折叠查看原始文本；失败显示红描边错误卡片；修改参数后结果保留至重新提交

## 交互与动效

- 按钮/控件 hover、active 使用 --motion-fast(140ms）过渡；结果区出现用 --motion-base(190ms）淡入上移（参照 motion-list-item-in)
- 提交中按钮 loading 并忽略重复点击；超时/失败给出可操作的中文错误文案；非法配置渲染与 InvalidEChartsConfig 同款错误卡片

## Agent Extensions

### SubAgent

- **code-explorer**
- Purpose: 在拆分 2 万行 App.tsx 的批次二/三中，系统性核对每个待抽取面板组件与纯函数引用的外层符号（类型、常量、工具函数、CSS 类名）,输出精确的依赖清单与新模块 import 映射；同时复核三个测试文件待更新的导入符号
- Expected outcome: 产出每个新模块（lib/project-files、lib/conversation-utils、lib/config-utils、workspace/*）的符号清单与依赖边，保证拆分纯搬移、无遗漏、无循环依赖，typecheck 与 vitest 一次通过