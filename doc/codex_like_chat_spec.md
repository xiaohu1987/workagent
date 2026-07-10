# Codex 风格聊天输出复刻规范

这不是 OpenAI/Codex 的私有内部提示词或未公开实现，而是一套高拟真的复刻方案。  
如果你想做出“像 Codex 一样”的效果，核心不是只写一个 prompt，而是同时复刻：

1. 代理行为
2. 事件流
3. UI 渲染

---

## 1. 先理解 Codex 风格到底是什么

Codex 风格不是普通对话气泡，而是“任务时间线”：

- 用户消息
- 助手中间进度说明
- 工具调用
- 工具结果
- 文件查看
- 文件修改
- 测试/验证
- 最终答复

真正的体验重点是：

- 不暴露原始思维链
- 但持续显示“我现在在做什么”
- 工具是独立卡片，不混在自然语言正文里
- 文件改动要可定位、可预览、可折叠
- 最终答复比中间过程更干净、更高层

一句话说，Codex 像“会行动的 IDE 助手”，不是“只会说话的聊天机器人”。

---

## 2. 推荐你直接使用的系统提示词

把下面这段作为你的主系统提示词：

```text
你是一个 Codex 风格的软件工程代理，不是普通闲聊机器人。

你的目标不是只回答用户，而是像 IDE 内的代理一样完成任务，并把执行过程以“可渲染的事件流”输出。

你必须遵守以下规则：

1. 把可见输出分成五类：
   - commentary：中间进度说明
   - tool_call：工具调用
   - tool_result：工具结果
   - file_change：文件查看或修改
   - final：最终答复

2. 在开始搜索、读取文件、修改文件、运行测试、生成结果之前，先输出 1 到 2 句简短 commentary，告诉用户你接下来要做什么。

3. 不要输出原始思维链，不要展示长篇内部推理。你只能输出面向用户的简短进度说明、行动摘要和结果解释。

4. 如果任务需要多轮行动，你要循环执行：
   - 先说明下一步
   - 再调用工具
   - 根据结果继续
   - 直到问题解决

5. 工具调用必须被单独表示，不能伪装成自然语言段落。

6. 文件相关信息必须结构化展示，包括：
   - 文件路径
   - 操作类型（read/create/update/delete）
   - 关键片段或 diff
   - 如果有必要，附上行号

7. 最终答复必须比中间过程更简洁，优先讲结果、验证状态、剩余风险。

8. 中间 commentary 要短、稳定、像真实结对编程搭档。避免夸张语气，避免每次都用同样开头。

9. 如果工具失败，清楚显示失败原因、退出码和下一步修复动作。

10. 如果用户只是问问题，不一定要改文件；但如果任务明显偏执行，就默认进入代理工作流，而不是只给建议。

你的输出必须遵循以下事件标签格式：

<event type="commentary">
这里写给用户看的简短进度更新
</event>

<event type="tool_call" name="shell_command">
{"command":"rg --files","cwd":"/workspace"}
</event>

<event type="tool_result" name="shell_command" ok="true" duration_ms="120">
这里放摘要结果，不要放无限长日志；长日志截断并标记 truncated
</event>

<event type="file_change" action="update" path="/workspace/src/app.ts">
这里放变更摘要或 unified diff
</event>

<event type="final">
这里放最终答复，使用简洁 Markdown
</event>

如果没有工具，就不要虚构工具事件。
如果没有文件修改，就不要虚构 file_change。
如果任务未完成，不要过早输出 final。
```

---

## 3. 最好不要只输出纯文本，应该输出“事件流”

推荐你的后端把每条历史存成结构化事件，而不是只存 assistant message。

建议事件模型：

```json
{
  "id": "evt_001",
  "role": "assistant",
  "type": "commentary",
  "createdAt": "2026-07-10T10:00:00Z",
  "text": "我先检查项目结构和相关文件，确认改动范围。"
}
```

```json
{
  "id": "evt_002",
  "role": "assistant",
  "type": "tool_call",
  "tool": "shell_command",
  "status": "running",
  "input": {
    "command": "rg --files",
    "cwd": "/workspace"
  },
  "createdAt": "2026-07-10T10:00:02Z"
}
```

```json
{
  "id": "evt_003",
  "role": "tool",
  "type": "tool_result",
  "tool": "shell_command",
  "status": "completed",
  "ok": true,
  "exitCode": 0,
  "durationMs": 120,
  "stdoutPreview": "src/app.ts\nsrc/index.ts\nREADME.md",
  "truncated": false,
  "createdAt": "2026-07-10T10:00:02Z"
}
```

```json
{
  "id": "evt_004",
  "role": "assistant",
  "type": "file_change",
  "action": "update",
  "path": "/workspace/src/app.ts",
  "summary": "修复了空状态分支，并补上错误提示。",
  "diff": "@@ ...",
  "createdAt": "2026-07-10T10:00:05Z"
}
```

```json
{
  "id": "evt_005",
  "role": "assistant",
  "type": "final",
  "text": "我已经修好了空状态渲染问题，并跑过测试。",
  "createdAt": "2026-07-10T10:00:10Z"
}
```

---

## 4. 你前端真正要渲染的类型

最少需要这些卡片类型：

- `user_message`
- `assistant_commentary`
- `tool_call_running`
- `tool_result_success`
- `tool_result_error`
- `file_read_preview`
- `file_diff`
- `test_result`
- `final_answer`

推荐显示规则：

- `assistant_commentary`
  用弱化颜色、无大气泡、像状态播报
- `tool_call_running`
  用独立卡片，显示工具名、参数摘要、状态、耗时
- `tool_result_success`
  显示绿色状态、小段输出、支持展开完整日志
- `tool_result_error`
  显示红色状态、退出码、错误摘要、重试动作
- `file_read_preview`
  显示文件路径、代码片段、行号
- `file_diff`
  用统一 diff 风格，新增绿色、删除红色
- `final_answer`
  回到正常 Markdown，内容最干净

---

## 5. 最像 Codex 的循环方式

后端循环建议这样做：

```ts
while (!done) {
  emit(commentary);
  const action = decideNextAction(state);

  if (action.type === "tool") {
    emit(toolCall(action));
    const result = await runTool(action);
    emit(toolResult(result));
    state = reduce(state, result);
    continue;
  }

  if (action.type === "file_change") {
    emit(fileChange(action.diff));
    state = reduce(state, action);
    continue;
  }

  if (action.type === "final") {
    emit(finalAnswer(action.text));
    done = true;
  }
}
```

关键点：

- “循环”本身不要直接显示成推理
- 显示的是每轮的用户可理解事件
- 一轮一个小目标，不要一口气吐一大段内部过程

---

## 6. 文件显示和修改怎么做才像

文件查看建议显示：

- 路径
- 文件类型图标
- 行号
- 代码片段
- 可点击跳转

文件修改建议显示：

- Modified / Created / Deleted 标签
- 简短变更摘要
- 折叠的 diff 预览
- 如果是多个文件，按文件分组

示例：

```text
src/components/ChatPanel.tsx  Modified
修复了工具卡片状态切换，补充了折叠日志显示

@@ -18,6 +18,10 @@
+ const isDone = status === "completed";
+ const isError = status === "failed";
```

---

## 7. UI 风格提示词

如果你要让设计模型或前端同事复刻 UI 风格，可以直接用这段：

```text
做一个 IDE 风格的 AI 代理聊天面板，不要做成消费级聊天气泡界面。

整体气质：
- 专业
- 克制
- 高信息密度
- 像开发工具，不像社交软件

布局要求：
- 左侧时间线或纵向主流
- 用户消息与代理事件统一排在主内容区
- commentary 比 final 更弱化
- 工具调用和工具结果使用独立卡片
- 文件修改使用 diff 卡片
- 最终答复使用 Markdown 正文样式

视觉要求：
- 深色 IDE 风格背景
- 低饱和中性色为主
- 蓝色用于当前执行
- 绿色用于成功
- 红色用于失败
- 黄色用于进行中或警告
- 圆角小，不要像聊天 App 那样大气泡
- 边框清晰，层级靠边框和底色区分
- 大量使用等宽字体展示路径、命令、代码、diff

交互要求：
- 工具输出默认折叠长日志
- 文件 diff 可展开
- 支持复制命令、复制路径、跳转文件
- 状态切换需要有轻微动画，但不要花哨
- 正在运行的工具显示 spinner
- 完成后替换为 success/error 图标
```

---

## 8. 推荐的颜色与排版

你可以直接用这组 token：

```css
:root {
  --bg: #0b1020;
  --panel: #121a2b;
  --panel-2: #0f1726;
  --border: #243046;
  --text: #e6edf7;
  --muted: #94a3b8;
  --blue: #60a5fa;
  --green: #34d399;
  --yellow: #fbbf24;
  --red: #f87171;
  --code: #cbd5e1;
}
```

排版建议：

- 正文：14px 到 15px
- 注释/状态：12px 到 13px
- 代码与路径：`JetBrains Mono`、`SF Mono`、`Consolas`
- 正文：`Inter`、`Segoe UI`、`system-ui`

---

## 9. 如果你只想要一个“超像 Codex”的最小版提示词

这是最短可用版：

```text
你是一个 IDE 内的软件工程代理。不要只回答，要以事件流方式完成任务。

每次任务都按以下模式输出：
1. 先用 1 到 2 句 commentary 说明下一步
2. 如果需要行动，输出工具调用事件
3. 收到工具结果后，输出摘要结果
4. 如果涉及文件，输出文件查看或 diff 事件
5. 循环执行，直到完成
6. 最后输出简洁 final，总结结果、验证、风险

不要输出原始思维链。不要假装调用不存在的工具。不要把工具结果和自然语言混在一起。

所有输出都必须可被渲染器识别为：
commentary / tool_call / tool_result / file_change / final
```

---

## 10. 真正决定像不像的，不是 prompt，而是这三个细节

第一，commentary 必须短，而且频繁。

第二，工具和文件必须是卡片，不要塞进正文。

第三，最终答复必须“比过程更干净”，这样才像真正完成过任务的代理。

---

## 11. 如果你要做 1:1 产品感复刻，建议再补三件事

- 事件持久化：不要只存最终 message，存完整 event timeline
- 流式更新：tool running -> completed 要原地变更，不要重新插一条
- diff 语义化：不仅显示文本差异，还要显示“修改了什么意图”

---

## 12. 我建议你的实现组合

最稳的组合是：

- 大模型负责生成结构化事件
- 后端负责跑工具和维护循环状态
- 前端负责把不同事件渲染成不同卡片

不要让模型既扮演前端，又扮演工具执行器，又自己编造工具结果。  
真正像 Codex 的关键，是“模型负责决策，系统负责执行，UI 负责展示”。

