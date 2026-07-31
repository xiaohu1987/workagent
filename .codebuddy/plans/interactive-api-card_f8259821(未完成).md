---
name: interactive-api-card
overview: 在聊天框中新增可交互 API 卡片功能:预制一套通用表单控件组件库,AI 根据用户提供的接口文档输出 ```api-card 代码块,前端解析渲染为交互表单卡片,用户填写后点击确定通过主进程 IPC 代理调用接口,返回结果仅在卡片内展示。
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
    content: 新建 form-controls.tsx/css,预制全套表单控件与 Field 包装
    status: pending
  - id: api-card-logic
    content: 新建 api-card.ts:配置解析校验、模板替换构建请求、响应格式化
    status: pending
  - id: ipc-http-proxy
    content: main/index.ts 新增 http:request 通道,preload 与 env.d.ts 同步暴露
    status: pending
  - id: api-card-component
    content: 新建 ApiCardMessage 组件与样式,实现表单提交与卡片内结果展示
    status: pending
    dependencies:
      - form-controls
      - api-card-logic
      - ipc-http-proxy
  - id: markdown-integration
    content: 用 [subagent:code-explorer] 定位锚点后修改 App.tsx 接入 api-card 块解析与渲染
    status: pending
    dependencies:
      - api-card-component
  - id: prompt-guidance
    content: agent-runtime 系统提示追加 api-card 输出规约与触发条件
    status: pending
  - id: tests-verify
    content: 新增 tests/api-card.test.ts,运行 vitest 与 typecheck 验证
    status: pending
    dependencies:
      - api-card-logic
      - markdown-integration
      - ipc-http-proxy
---

## 用户需求

用户希望在桌面 Agent 应用的聊天框中新增交互式接口卡片能力：先预制一套常用表单组件；当用户在聊天中提供接口文档时，AI 根据文档输出卡片配置，前端将其渲染为可交互卡片；用户在卡片中填写信息、点击"确定"后调用接口，并在卡片内展示接口返回信息。

## 产品概述

在现有聊天消息流中新增一类"API 交互卡片"消息块。AI 回复中包含特定格式的配置块时，聊天界面自动渲染为一张表单卡片。卡片包含接口标题、描述、按接口文档生成的输入项，以及"确定"按钮。用户提交后卡片内显示请求状态、耗时与格式化后的响应内容（或错误信息），用户可修改参数后再次调用，全程不离开聊天上下文。

## 核心功能

- 预制常用表单控件库：单行文本、多行文本、数字、密码、下拉选择、单选、复选、开关、日期、时间、键值对编辑器（headers/动态参数）、JSON 编辑器，统一 label/必填/错误提示外观
- 聊天消息新增 api-card 块类型：AI 按约定格式输出配置，前端解析为交互卡片；配置非法时展示错误卡片而非崩溃
- 卡片表单渲染与必填校验，支持默认值、占位提示、选项配置
- 点击确定后组装请求（路径参数、query、header、body 模板替换）并调用接口，带加载状态与超时控制
- 卡片内结果区展示状态码、耗时、格式化 JSON 响应或错误详情，可折叠查看原始内容，支持修改后重试

## 技术栈

- 渲染进程：React 19 + TypeScript + 原生 CSS(沿用项目现有 CSS 变量主题体系，不引入组件库)
- 桌面壳：Electron(`net.fetch` 在主进程发起 HTTP 请求，规避渲染进程跨域)
- AI 侧：`packages/agent-runtime` 系统提示词引导模型输出 api-card 配置块
- 测试：vitest(`tests/`)，类型检查 `pnpm typecheck`

## 实现方案

整体复刻现有 `echarts` 自定义消息块的成熟链路：**fence 解析 → 专用组件渲染 → 纯函数可测**。

1. **块识别**：AI 输出  ````api-card ` 围栏代码块，内容为严格 JSON 配置；`parseMarkdownBlocks `在闭合围栏且语言为 `api-card` 时产出 `{ kind: "api-card", content }`(未闭合围栏保持 code 块，与 echarts 行为一致)。
2. **配置解析**:`parseApiCardConfig` 纯函数，校验 JSON 合法性、体积上限(64KB)、危险键(`__proto__`/`constructor`/`prototype`,与 `parseEChartsConfig` 同款防护)、method/url/fields 结构，返回 `{ ok: true, config } | { ok: false, error }`。
3. **请求构建**:`buildApiRequest` 纯函数，将 `{{fieldName}}` 占位符替换进 url 路径参数、query、header 值与 bodyTemplate；路径/query 值做 `encodeURIComponent`,body 替换后整体 `JSON.parse` 校验，失败返回明确错误；先做必填校验再组装。
4. **接口调用**：新增 IPC 通道 `http:request`，主进程用 `net.fetch`(index.ts 已引入 `net`）代理请求：仅允许 http/https、30s 超时（`AbortSignal.timeout`)、响应体上限 1MB 截断，返回 `{ ok, status, statusText, headers, bodyText, durationMs, error? }`。preload 暴露 `requestHttp`,`env.d.ts` 补类型。
5. **结果展示**：卡片内结果区展示状态徽标（2xx 绿/4xx 橙/5xx 红）、耗时、格式化 JSON(`JSON.stringify(obj, null, 2)`,超长截断+折叠原始文本）；网络/校验错误展示错误区；全部状态留在卡片组件内，不写入聊天时间线（符合用户选择）。
6. **AI 引导**：在 `packages/agent-runtime/src/index.ts` 系统提示 blocks(7391 行 echarts 引导语后）追加 api-card 输出规约：触发条件（用户提供接口文档且需要交互输入）、严格 JSON、支持的字段类型清单、`{{field}}` 模板规则、安全约束（不臆造密钥/令牌）。

## 实现要点

- **性能**：配置解析用 `useMemo(configText)` 缓存（同 EChartsMessageChart)；表单状态为卡片局部 state，不触发消息列表重渲染；结果 JSON 美化仅在成功后执行一次且截断；对 App.tsx 的改动为纯增量，不触碰其他块的热渲染路径。
- **日志/安全**：主进程不向日志输出请求头（可能含 token)；错误通过 IPC 返回值带回不抛裸异常；模板替换为纯字符串操作，无 eval;JSON 解析拒绝危险键。
- **影响面控制**:App.tsx 仅加 1 个联合类型成员、fence 分支 1 行、`renderMarkdownBlock` 1 个 case、import 1 行；非法配置渲染错误卡片（仿 `InvalidEChartsConfig`)，向后兼容现有消息。

## 架构设计

```mermaid
flowchart LR
  A[AI 回复含 api-card 围栏块] --> B[parseMarkdownBlocks<br/>App.tsx]
  B --> C[ApiCardMessage 组件<br/>parseApiCardConfig 校验]
  C --> D[form-controls 控件渲染表单]
  D --> E[用户填写 + 确定<br/>buildApiRequest 模板替换]
  E --> F[window.codexh.requestHttp<br/>preload IPC]
  F --> G[main: http:request<br/>net.fetch 代理 超时/限流]
  G --> H[目标接口]
  H --> I[卡片内结果区<br/>状态码/耗时/格式化响应]
```

## 目录结构

```
apps/desktop/src/renderer/
├── form-controls.tsx        # [NEW] 预制表单控件库。实现 Field 包装(label/必填/错误/帮助文本)与 TextInput、TextArea、NumberInput、PasswordInput、SelectInput、RadioGroup、CheckboxGroup、Switch、DateInput、TimeInput、KeyValueEditor(键值对增删行)、JsonEditor(带 JSON 校验的多行输入)。全部为受控纯展示组件,无业务耦合。
├── form-controls.css        # [NEW] 控件样式,使用 --surface-card/--border/--text 等现有 CSS 变量适配多主题,聚焦态用 --blue 描边。
├── api-card.ts              # [NEW] 卡片纯逻辑(导出供测试)。ApiCardConfig/ApiCardField 类型、parseApiCardConfig(64KB 上限、危险键、结构校验)、substituteTemplate/buildApiRequest({{field}} 替换、query 编码、body JSON 校验、必填校验)、formatApiResponseBody(美化/截断)。
├── api-card-message.tsx     # [NEW] ApiCardMessage 组件。useMemo 解析配置,失败渲染错误卡片;成功渲染表单+确定按钮;提交走 window.codexh.requestHttp;本地 state 管理 values/errors/loading/result;结果区展示状态徽标、耗时、格式化 JSON 与折叠原文,支持修改重试。
├── api-card-message.css     # [NEW] 卡片样式:圆角卡片、头部标题+方法徽标、结果区 mono 字体、微动效(使用 --motion-* 变量)。
├── App.tsx                  # [MODIFY] 约 447 行 MarkdownBlock 联合类型新增 { kind: "api-card"; content: string };约 18855 行 fence 闭合分支支持 api-card 语言;约 92 行 import ApiCardMessage;约 18537 行 renderMarkdownBlock 新增 case "api-card"。
├── env.d.ts                 # [MODIFY] Window.codexh 新增 requestHttp 类型声明(请求/响应契约同 IPC)。
apps/desktop/src/main/
├── index.ts                 # [MODIFY] 在现有 ipcMain.handle 列表(约 432 行 threads:send 附近)新增 "http:request" handler:校验 url 仅 http/https、method 白名单、30s 超时、1MB 响应截断,返回结构化结果。
apps/desktop/src/preload/
├── index.ts                 # [MODIFY] api 对象新增 requestHttp: (payload) => ipcRenderer.invoke("http:request", payload)。
packages/agent-runtime/src/
├── index.ts                 # [MODIFY] 约 7391 行 echarts 引导语后追加 api-card 系统提示:输出格式 JSON schema、字段类型清单、{{field}} 模板规则、触发条件与安全约束。
tests/
├── api-card.test.ts         # [NEW] vitest 用例:parseApiCardConfig 合法/非法/超限/危险键;buildApiRequest 路径/query/header/body 替换与必填校验;parseMarkdownBlocks 对 api-card 闭合/未闭合围栏的解析(参照 renderer-markdown.test.ts 现有写法)。
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

export interface ApiCardConfig {
  title: string; description?: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;                              // 支持 {{field}} 路径参数
  headers?: Record<string, string>;         // 值支持 {{field}}
  query?: Record<string, string>;           // 值支持 {{field}}
  bodyTemplate?: string;                    // JSON 字符串模板,含 {{field}}
  fields: ApiCardField[];
}

export type ParsedApiCardConfig =
  | { ok: true; config: ApiCardConfig }
  | { ok: false; error: string };
```

```ts
// IPC 契约(preload/env.d.ts/main 三处一致)
export interface HttpRequestPayload {
  method: string; url: string;
  headers?: Record<string, string>;
  body?: string;                            // 已序列化
}
export type HttpRequestResult =
  | { ok: true; status: number; statusText: string;
      headers: Record<string, string>; bodyText: string;
      truncated: boolean; durationMs: number }
  | { ok: false; error: string };
```

## 设计风格

沿用应用现有的开发者工具深色主题(多主题 CSS 变量体系),卡片式设计融入聊天消息流,视觉精致且与 ECharts 图表块风格统一。全部颜色通过 --surface-card、--border、--text、--blue、--orange 等现有 CSS 变量实现,自动适配明暗主题。

## 布局与块设计(自上而下)

- **卡片头部**:接口标题(15px/600)+ HTTP 方法徽标(GET 蓝/POST 绿/PUT 橙/DELETE 红,圆角胶囊)+ 可选描述(13px,弱化色),右上角折叠按钮
- **表单区**:单列纵向排布字段,label 在上控件在下,必填项标红点;聚焦时控件描边 --blue 并带 2px 光晕;错误信息红色 12px 置于控件下方;KeyValueEditor 为可增删的两列行
- **操作区**:右对齐"确定"主按钮(蓝底白字,hover 提亮,loading 时转圈禁用)+"重置"幽灵按钮
- **结果区**:成功后出现,顶部状态条(状态码徽标 2xx 绿/4xx 橙/5xx 红 + 耗时 ms),下方 mono 字体格式化 JSON(最大高度滚动),details 折叠查看原始文本;失败时显示错误卡片(红描边+错误信息);修改参数后结果区保留直至重新提交

## 交互与动效

- 按钮 hover/active 使用 --motion-fast(140ms) 过渡;结果区出现用 --motion-base 淡入上移(参照 --motion-distance 8px)
- 提交中按钮 loading,重复点击防抖;超时/失败给出可操作的错误文案

## Agent Extensions

### SubAgent

- **code-explorer**
- Purpose: 在修改 2 万行的 App.tsx 及 agent-runtime 前,一次性定位并核对所有精确插入锚点(MarkdownBlock 联合类型、fence 闭合分支、renderMarkdownBlock switch、import 区、系统提示 blocks),确认行号未漂移
- Expected outcome: 输出各修改点的当前准确行号与上下文片段,保证增量修改不误伤相邻代码