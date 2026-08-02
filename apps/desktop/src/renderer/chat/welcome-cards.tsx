import type { WelcomeCard } from "../core/app-types";
import { IconBuild, IconExplore, IconFix, IconReview } from "../icons";

export const PROJECT_WELCOME_CARDS: WelcomeCard[] = [
  {
    id: "explore",
    title: "探索并理解代码",
    prompt: "请先帮我梳理这个项目的结构、关键模块和启动方式。",
    accentClass: "blue",
    icon: <IconExplore />
  },
  {
    id: "build",
    title: "构建新功能、应用或工具",
    prompt: "请根据当前项目结构继续实现新功能，并给出关键修改点。",
    accentClass: "violet",
    icon: <IconBuild />
  },
  {
    id: "review",
    title: "审查代码并提出修改建议",
    prompt: "请审查当前项目代码，优先指出问题、风险和建议修复方案。",
    accentClass: "green",
    icon: <IconReview />
  },
  {
    id: "fix",
    title: "修复问题和失败",
    prompt: "请帮我定位当前项目的问题，并直接修复启动或运行失败的原因。",
    accentClass: "orange",
    icon: <IconFix />
  }
];

export const CHAT_WELCOME_CARDS: WelcomeCard[] = [
  {
    id: "analyze",
    title: "分析一个问题",
    prompt: "请帮我拆解这个问题，梳理关键事实、判断依据和下一步。",
    accentClass: "blue",
    icon: <IconExplore />
  },
  {
    id: "write",
    title: "起草一段内容",
    prompt: "请根据我的目标起草一份清晰、可直接使用的内容。",
    accentClass: "violet",
    icon: <IconBuild />
  },
  {
    id: "translate",
    title: "翻译与润色",
    prompt: "请翻译并润色下面的内容，保留原意并让表达自然准确。",
    accentClass: "green",
    icon: <IconReview />
  },
  {
    id: "learn",
    title: "解释一个概念",
    prompt: "请用清晰的例子解释这个概念，并指出容易混淆的地方。",
    accentClass: "orange",
    icon: <IconFix />
  }
];
