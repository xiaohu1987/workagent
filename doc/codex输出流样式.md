# 任务：复刻 CodeX CLI 的任务时间线动态输出样式

## 背景
CodeX CLI 在终端中运行 Agent 时，会动态显示任务计划（Plan）和执行进度。我需要你分析这个输出样式的核心特征，然后用代码实现一个可复用的组件/库来复刻它。

## 你的分析对象
CodeX CLI 终端输出的典型样式如下：

● Updated Plan
└─ ✔ Inspect CLI structure and relevant core utilities
└─ ✔ Implement new codex prompt subcommand
└─ ◐ Format, lint, and test
└─ □ Update documentation and examples


以及执行步骤的样式：

⚡ Ran command
$ cargo test -p codex-cli
→ test result: ok. 42 passed; 0 failed
● Explored
Found 3 relevant files in src/components/


## 你需要实现的样式特征

### 1. 计划列表（Plan List）
- **标题**：`● Updated Plan`（圆点 + 粗体标题）
- **树形层级**：使用 `└─ ` 或 `├─ ` 作为前缀连接线
- **状态图标**：
  - `✔` 已完成（绿色）
  - `◐` 进行中（黄色/琥珀色，可带旋转动画）
  - `□` 待处理（灰色空心方块）
- **文字样式**：
  - 已完成：删除线 + 降低透明度
  - 进行中：高亮 + 可能闪烁/脉冲
  - 待处理：正常灰色

### 2. 执行步骤（Execution Step）
- 命令行前缀：`⚡ Ran command` 或 `→`
- 命令本身用反引号或高亮背景包裹
- 输出结果缩进显示，左侧有竖线或箭头指示

### 3. 动态行为
- 状态变化时平滑过渡（颜色、图标、文字样式）
- 新步骤出现时可以有淡入动画
- 进行中状态可以有微妙的脉冲/旋转动画

## 输出要求

请用 **React + TypeScript + Tailwind CSS** 实现，要求：

1. **组件化设计**：
   - `<PlanTimeline />` - 主时间线容器
   - `<PlanItem />` - 单个计划项
   - `<ExecutionStep />` - 命令执行步骤
   - `<StatusIcon />` - 状态图标

2. **类型定义完整**：
   ```typescript
   type PlanStatus = 'pending' | 'in_progress' | 'completed';
   interface PlanItem {
     id: string;
     text: string;
     status: PlanStatus;
   }
   
   支持动态更新：
通过 props 传入 plan 数据
状态变化时有 CSS transition 动画
提供模拟数据变化的 demo
样式精确复刻：
使用 monospace 字体
树形连接线使用 Unicode box-drawing 字符
颜色方案匹配 CodeX 的终端配色（深色背景上的亮色文字，或浅色背景上的暗色文字）
额外加分项：
支持流式输出（模拟打字机效果）
支持深色/浅色主题切换
提供 Storybook 或独立 demo 页面
约束
不要引入过重的 UI 库，优先使用 Tailwind + Lucide React 图标
代码要清晰、可维护、有注释
如果某些样式特征你不确定，基于终端 UI 的最佳实践做出合理推断