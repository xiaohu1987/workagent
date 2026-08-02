import type { RefObject } from "react";
import { IconChevronRight, IconTerminal } from "../icons";

export function TerminalPanel({ shell, cwd, output, input, scrollRef, onInputChange, onSubmit, onHide, hasThread }: {
  shell: string; cwd: string; output: string; input: string; scrollRef: RefObject<HTMLPreElement | null>;
  onInputChange: (value: string) => void; onSubmit: () => void; onHide: () => void; hasThread: boolean;
}) {
  return <aside className="terminal-panel" aria-label="终端">
    <header className="terminal-header"><div className="terminal-heading"><span className="terminal-heading-icon" aria-hidden="true"><IconTerminal /></span><div><strong>{shell}</strong><span title={cwd}>{cwd || "正在连接终端"}</span></div></div><button type="button" className="terminal-hide-button" title="向右隐藏终端" aria-label="向右隐藏终端" onClick={onHide}><IconChevronRight /></button></header>
    <pre ref={scrollRef} className="terminal-output" aria-live="polite">{hasThread ? output || " " : "选择一个任务后即可使用终端。"}</pre>
    <div className="terminal-composer"><span className="terminal-prompt" aria-hidden="true">&gt;</span><input value={input} disabled={!hasThread} onChange={(event) => onInputChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit(); } }} placeholder={hasThread ? "输入命令" : "请选择任务"} aria-label="终端命令" spellCheck={false} /></div>
  </aside>;
}
