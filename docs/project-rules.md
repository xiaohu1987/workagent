# 项目规则机制（`.codexh/rule.md`）

项目级对话以 `.codexh/rule.md` 作为项目约定的唯一事实来源。文件缺失时按当前仓库事实自动生成，
会话开始时注入常驻索引，写文件前注入命中条目，项目演进后按“只增不删、过期仅标记”增量更新。
用户可以用自然语言直接改写规则，改写后的条目来源标记为 `user`，自动更新不再覆盖。

## 文件结构

规则文件由“常驻索引 + 条目正文”两段构成，索引来自条目字段，正文按需读取。

| 字段 | 含义 |
| --- | --- |
| `id` | 条目 ID，按分类前缀编号（`R-GUARD`/`R-TECH`/`R-VERIFY`/`R-LAYOUT`/`R-STYLE`/`R-PITFALL`） |
| `category` | 分类：改动边界、技术栈与版本、验证与测试命令、目录职责、命名与风格、已知坑 |
| `scope` | 适用范围，默认 `**/*` |
| `source` | `auto`（扫描生成）或 `user`（用户指定，受保护） |
| `updated_at` | 最近更新时间 |
| `stale` | 标记为可能过期的条目：命中时先按当前仓库事实判断，不要直接照搬 |

容量上限（超出后按分类优先级截断，`boundary` 类优先级最高）：文件 60,000 字符、条目 120 条、
单条 2,000 字符、常驻索引 40 条 / 4,000 字符、单次展开 20 条 / 12,000 字符。

## 生效方式

1. 项目对话启动：检测 `.codexh/rule.md`，缺失则扫描项目并原子写盘；生成不阻塞首轮回复，失败降级放行。
2. 每轮注入：只注入条目索引与前序说明，正文留在磁盘按需读取，控制常驻提示体积。
3. 写入前核对：命中当前改动范围的条目被展开注入；冲突时不静默写入，而是生成待更新记录。

优先序为：当轮用户指令 > `rule.md` > 项目记忆 > 默认行为。规则与当轮指令冲突时以用户指令为准，
并把冲突登记为规则待更新项。

## 自动生成与增量更新

扫描输入为工程清单、目录结构、脚本与测试命令、关键配置等仓库事实。新事实在合并时：
新增条目追加并分配 ID；`user` 来源条目一律保留，不被自动改写；项目无变化时不写盘（幂等）。
单次可自动改写的条目数为 6 条，超出上限时转为提示确认，避免误删仍有效的条目。

触发条件：规则文件缺失，或文件更新时间早于项目清单（package.json / 工作区配置等）的探测时间。

## 在空项目中复现

1. 在一个新的空项目目录（含 `package.json`）中发起项目级对话。
2. 首轮结束后检查 `.codexh/rule.md`：文件已存在且含至少一条自动生成的条目。
3. 追加一个依赖或测试脚本后再对话一次：对应分类出现新条目，原有有效条目全部保留。

自动化复现（覆盖“空项目生成 → 注入索引 → 写入前核对 → 自然语言改写”全链路）：

```powershell
npx vitest run tests/project-rule-e2e.test.ts tests/project-rule-entry.test.ts tests/project-rule-edit.test.ts tests/project-rule-freshness.test.ts tests/project-rule-precedence.test.ts
```

## 关闭与回滚

- 临时静默：保留 `.codexh/rule.md` 但清空条目（只留文件头）。条目为空时不注入任何规则块。
- 彻底关闭：当前实现没有独立的启用开关。要长期停用需在注入接入点停止调用
  `buildProjectRuleInjection`（`packages/agent-runtime/src/index.ts` 组装项目级提示处），
  或保持规则文件为空并接受下一次项目清单变化时自动条目会被补回。
- 回滚：`git checkout -- .codexh/rule.md` 恢复到已提交版本；直接删除文件会在下次项目对话时重新生成，
  因此删除不是关闭手段。

## 实现索引

| 模块 | 职责 |
| --- | --- |
| `project-rule-file.ts` | 文件格式、分类与容量常量、解析与序列化 |
| `project-rule-scan.ts` | 仓库事实扫描 |
| `project-rule-template.ts` | 规则模板与条目骨架 |
| `project-rule-bootstrap.ts` | 缺失检测、首轮生成与原子写盘 |
| `project-rule-inject.ts` | 会话级索引注入 |
| `project-rule-guard.ts` | 写入前命中条目展开与冲突提示 |
| `project-rule-update.ts` | 增量更新、合并规则与新鲜度探测 |
| `project-rule-edit.ts` | 自然语言改写映射到条目 |
| `project-rule-precedence.ts` | 规则机制与计划/记忆机制的优先序 |

## 已知限制

- 缺少独立的启用开关：停用只能靠空文件或改动注入接入点，见上文“关闭与回滚”。
- 类型检查 `pnpm run typecheck` 存在仓库既有报错（桌面端、provider-adapters、tool-runtime 等），
  与规则机制改动无关；规则相关文件的类型错误为零。
