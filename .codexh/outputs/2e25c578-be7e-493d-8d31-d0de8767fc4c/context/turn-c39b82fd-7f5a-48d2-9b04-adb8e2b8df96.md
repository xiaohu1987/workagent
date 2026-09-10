# Conversation Turn Context

- Turn run: `c39b82fd-7f5a-48d2-9b04-adb8e2b8df96`
- Completed at: `2026-09-09T09:53:51.913Z`
- MCP sources: none

## User Request

内置工具搜索里没有 knowledge.add  你确定你改好了？

## Effective Task Context

内置工具搜索里没有 knowledge.add  你确定你改好了？

## Assistant Result

你的观察是对的——我在当前会话实测 `tool_search` 搜 "knowledge" 也只返回了一个 MCP 工具，没有任何内置知识库工具。查完门控链路后可以确认：**改动本身没问题，这是知识库开关的门控设计在起作用**。

## 结论：不是漏改，是门控生效了

`tool_search` 的实现（`packages/tool-runtime/src/index.ts`）会按 `hiddenToolNames` 过滤结果：

```ts
const hidden = new Set(ctx.hiddenToolNames ?? []);
const results = self.searchTools(String(args.query ?? ""), ctx.deferredToolSpecs)
  .filter((entry) => !hidden.has(entry.name))
  .filter((entry) => !ctx.readOnlyAgent || !isChildReadOnlyForbiddenTool(entry.name));
```

而 agent-runtime 在知识库关闭时，会把全部六个工具放进隐藏清单：

```ts
...(knowledgeEnabled ? [] : ["knowledge.search", "knowledge.read", "knowledge.add",
  "knowledge.query", "knowledge.update", "knowledge.delete"]),
```

`knowledgeEnabled` 的默认值是 `false`（`packages/agent-runtime/src/gpa.ts`），当前这个会话没有开启知识库模式，所以六个工具——包括我这次新加的三个——都不会出现在直接工具列表里，也搜不到。

## 这三处行为是一致的

| 场景 | 直接工具列表 | tool_search 搜索 |
|---|---|---|
| 知识库关闭（当前会话） | 不可见 | 搜不到 |
| 知识库开启 | 六个工具可用 | 六个工具可搜到 |
| 子代理（只读） | `knowledge.add/update/delete` 硬禁用 | 搜索结果中同样被过滤 |

之前验证通过的 443 个测试覆盖的是注册、执行、审批、存储链路本身；门控是另一层，两者不冲突。

## 怎么确认工具真的在了

在输入框的"+"菜单里开启“知识库”后再问一次，或者直接让助手执行“把 xxx 记到知识库”——`knowledge.add` 会触发写入确认。开启后用 `tool_search` 搜 "knowledge" 也能看到全部六个。

一点诚实的补充：我上一轮说“链路已通”指的是注册到落库的执行链路，没有强调开关门控这一层，确实容易让人以为当前会话立即可见。如果你希望**所有会话默认开启知识库工具**（即把默认值从 `false` 改成 `true`），我可以直接改，一行配置的事。

## Verified Sources And Deliverables

- none
