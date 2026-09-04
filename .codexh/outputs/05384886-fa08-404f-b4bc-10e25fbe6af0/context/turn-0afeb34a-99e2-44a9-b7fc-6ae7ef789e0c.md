# Conversation Turn Context

- Turn run: `0afeb34a-99e2-44a9-b7fc-6ae7ef789e0c`
- Completed at: `2026-09-04T05:47:43.902Z`
- MCP sources: none

## User Request

查一下我现在的报错提醒有哪些

## Effective Task Context

查一下我现在的报错提醒有哪些

## Assistant Result

（接上句）……以及对话日志里的 `provider.turn_timeout`、`provider.rate_limit`、`provider.network_error`、`provider.context_overflow_recovery`、`provider.service_unavailable` 等事件记录。

补充一点使用建议：如果你是想排查某次具体报错，最快的方式是打开「对话日志」工作区，按错误关键词搜索——终态文案会带“原因：”前缀，其内容就是供应商层返回的原始 HTTP 错误；如果是想统一调整这些文案的措辞，改动点集中在 `packages/agent-runtime/src/index.ts` 的 `buildRuntimeFailureRecoveryMessage`（终态）、`apps/desktop/src/renderer/App.tsx` 约 2247–2410 行（重试状态）和 `packages/provider-adapters/src/index.ts`（HTTP 层原文）。

以上就是模型报错文案的完整清单，如需把某一类文案改成更友好的表述或补充排查指引，告诉我具体场景即可。

## Verified Sources And Deliverables

- `D:\workagent\tmp\query-error-texts.mjs`
