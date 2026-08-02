import { IconCompose, IconFolder } from "../icons";
import { ComposerSubmissionStatus } from "../cards/runtime-cards";
import type { ComposerSubmission, WelcomeCard } from "../core/app-types";

type Props = {
  submission: ComposerSubmission | null;
  showDefaultHome: boolean;
  isProject: boolean;
  defaultModelLabel: string;
  cards: WelcomeCard[];
  onCreateThread: (mode: "chat" | "project") => Promise<void>;
  onSelectPrompt: (prompt: string) => void;
};

export function ChatWelcome({ submission, showDefaultHome, isProject, defaultModelLabel, cards, onCreateThread, onSelectPrompt }: Props) {
  return (
    <div className="welcome-empty-state">
      {submission ? <ComposerSubmissionStatus submission={submission} /> : showDefaultHome ? (
        <section className="welcome-panel chat default-home-panel" aria-label="开始">
          <div className="welcome-intro"><span className="welcome-eyebrow">CODEXH CHAT</span><h1>开始你的下一个<span>任务</span></h1><p>选择一个快捷操作，或直接在下方输入框描述你的目标。</p></div>
          <div className="welcome-card-grid default-home-grid">
            <button type="button" className="welcome-card orange default-home-card" onClick={() => void onCreateThread("chat")}><span className="welcome-card-icon" aria-hidden><IconCompose /></span><strong>新建任务</strong><span className="welcome-card-action">开始一次新的对话</span></button>
            <button type="button" className="welcome-card blue default-home-card" onClick={() => void onCreateThread("project")}><span className="welcome-card-icon" aria-hidden><IconFolder /></span><strong>新建项目</strong><span className="welcome-card-action">在项目文件夹中工作</span></button>
          </div>
          <div className="default-home-model"><span className="default-home-model-label">当前默认模型</span><strong className="default-home-model-value">{defaultModelLabel}</strong></div>
        </section>
      ) : (
        <section className={`welcome-panel ${isProject ? "project" : "chat"}`} aria-label="开始新任务">
          <div className="welcome-intro"><span className="welcome-eyebrow">{isProject ? "PROJECT WORKSPACE" : "CODEXH CHAT"}</span><h1>{isProject ? <>从项目的<span>下一步</span>开始</> : <>从一个清晰的<span>问题</span>开始</>}</h1><p>{isProject ? "检查代码、实现功能，或直接描述需要修改的内容。" : "描述你的目标，或选择一个常用的对话起点。"}</p></div>
          <div className="welcome-card-grid">{cards.map((card) => <button key={card.id} type="button" className={`welcome-card ${card.accentClass}`} onClick={() => onSelectPrompt(card.prompt)}><span className="welcome-card-icon" aria-hidden>{card.icon}</span><strong>{card.title}</strong><span className="welcome-card-action">填入任务</span></button>)}</div>
        </section>
      )}
    </div>
  );
}
