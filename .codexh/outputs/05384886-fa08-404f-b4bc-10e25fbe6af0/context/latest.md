# Conversation Turn Context

- Turn run: `b639a1c0-7a0d-41bd-a724-e8b0687ad5ff`
- Completed at: `2026-09-04T05:57:23.002Z`
- MCP sources: none

## User Request

我就是要看看有哪些文案需要修改，你给我先整理出来

## Effective Task Context

我就是要看看有哪些文案需要修改，你给我先整理出来

## Assistant Result

全部文案已核对完毕。模型报错文案共 40 余条，分布在 4 个层次，其中需要修改的约 12 条，按问题严重度整理如下。

## 一、必须修改（误导用户或掩盖真实原因）

| 位置 | 当前文案 | 问题 | 修改建议 |
|---|---|---|---|
| `App.tsx:2304` | 深度思考 | 输出超限（`provider_output_limit`）重试时显示「深度思考」，完全掩盖真实原因，用户以为模型在正常思考 | 改为「模型输出超长，正在压缩后继续」 |
| `agent-runtime:9721` | 任务暂时停止：模型服务的工具调用会话未能匹配调用与结果。 | 「会话未能匹配调用与结果」是内部协议术语，用户无法理解 | 改为「模型服务返回的工具调用顺序异常，任务已暂停」 |
| `agent-runtime:9730` | 任务暂时停止：模型连续返回进度说明，但没有继续调用工具或给出最终结果。 | 「进度说明」是内部概念 | 改为「模型多次只输出解释文字，没有执行实际操作」 |
| `agent-runtime:9764` | 任务暂时停止：运行时遇到了无法自动恢复的异常。 | 「运行时」是开发术语 | 改为「程序内部遇到无法自动恢复的错误」 |

## 二、建议修改（中文界面透传英文报错）

`packages/provider-adapters/src/index.ts` 中约 10 条英文原文会直接展示给用户：

- `Gemini generateContent failed: HTTP xxx`（1925 行）
- `Anthropic refused to generate a response.`（1858 行）
- `The Responses API request failed.` / `The Responses API stream failed.`（2433、2534 行）
- `Image download failed: HTTP xxx`、`The image generation service returned no image data.`（979、986 行）
- `Video generation failed.` 等视频系列（1094–1102 行）
- `Provider xxx is missing apiKey or apiKeyEnv.`（1989 行）

建议：保留英文技术详情，但统一加中文前缀，如「模型服务返回错误：…」，与 1363 行 `Responses API 不可用，自动切换 Chat Completions 后仍然失败` 的处理方式对齐。

## 三、建议统一（中英混杂与术语不一致）

- **「429」数字码**：出现在 `agent-runtime:9756`、`App.tsx:2261`、`agent-runtime:8076` 三处，写作「429（请求过于频繁）」。建议统一为「请求过于频繁（限流）」，去掉状态码。
- **「Agent 决策」**：出现在 6 条文案中（9703、9738、2368 等）。对普通用户可改为「执行指令」或「任务响应」。
- **停止前缀**：「任务已停止」（永久）、「任务暂时停止」（可重试）、「任务尚未确认完成」（可继续）三种语义不同，建议保留区分，但「暂时停止」系列的建议句式（「建议：…」）应统一位置和格式。

## 四、无需修改（文案已清晰）

- 模型未开启工具调用（9703 行，含模型名、原因、指引三段式，结构完整）
- 模型决策超时（9713 行）
- 多模态系列提示（1886、7078–7232 行，含「设置 → 多模态」跳转指引）
- 完成校验/审计未通过系列（`App.tsx:2334–2336`，已做 issue 中文化映射）
- 设置页提示：获取模型失败、模型测试失败、加载模型配置失败

## 修改落点汇总

改动集中在 3 个文件：`packages/agent-runtime/src/index.ts`（终态文案 + 恢复卡片）、`apps/desktop/src/renderer/App.tsx`（重试状态）、`packages/provider-adapters/src/index.ts`（HTTP 错误包装）。确认清单后我可以直接按上表逐条提交修改。

## Verified Sources And Deliverables

- none
