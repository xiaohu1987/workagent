# Conversation Turn Context

- Turn run: `6f6a8512-a6d7-4ab3-8c5f-f7410d44fe3b`
- Completed at: `2026-09-08T07:32:30.491Z`
- MCP sources: none

## User Request

需要

## Effective Task Context

需要

## Assistant Result

修复已完成并全部验证通过：MCP 调用后程序变卡的根因（超大结果全量走完序列化、脱敏、落库、IPC 广播链路）已消除。

## 修复内容

- **持久化摘要**（`packages/agent-runtime/src/index.ts`）：新增 `summarizeMcpToolResultForPersistence`，`mcp.call` 结果落库和事件广播前先截断到 8KB 并带截断标记，与 `database.*` 工具同等对待；详情沿用已有的懒加载通道。
- **去重脱敏**（同文件）：`redactSensitiveText` 从跑两遍改为跑一遍，`resultJson` 与 `eventResultJson` 复用同一份结果。
- **去掉 pretty-print**（`packages/tool-runtime/src/index.ts`）：`mcp.call` 结果的 `JSON.stringify` 不再带缩进，体积和同步开销同步下降。
- **调用超时 + 缓存延长**（`packages/mcp-runtime/src/index.ts`）：`callTool` 增加超时包装，MCP 服务端挂起不再卡死整个任务；工具目录缓存 TTL 从 30 秒延长到 5 分钟，减少每次调用前的目录刷新往返。
- **新增测试**（`tests/mcp-persistence.test.ts`）：覆盖大结果截断、截断标记、脱敏单次执行、超时行为。

## 验证结果

4 个测试文件、361 个用例全部通过：

| 测试文件 | 用例数 |
|---|---|
| `tests/mcp-persistence.test.ts`（新增） | 4 |
| `tests/mcp-runtime.test.ts` | 10 |
| `tests/tool-runtime.test.ts` | 64 |
| `tests/agent-runtime.test.ts` | 283 |

类型检查确认新增代码无错误（报错项均为改动前就存在于其他文件的既有问题）。改动范围集中在 `agent-runtime`、`tool-runtime`、`mcp-runtime` 三个包和新增测试文件。现在调用 MCP 后，主进程只处理截断后的小结果，UI 不会再被大负载阻塞。

## Verified Sources And Deliverables

- `D:\workagent\packages\agent-runtime\src\index.ts`
- `D:\workagent\packages\tool-runtime\src\index.ts`
- `D:\workagent\packages\mcp-runtime\src\index.ts`
- `D:\workagent\tests\mcp-persistence.test.ts`
