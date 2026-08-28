import type { RefObject } from "react";
import { IconTerminal } from "../icons";
import { WorkspaceEmptyState, WorkspaceSubtabStrip } from "./panels";

export type TerminalWorkspaceTab = { id: string; title: string; rootPath: string };
export function TerminalWorkspace({
  tabs,
  activeSessionId,
  shell,
  cwd,
  output,
  input,
  scrollRef,
  onInputChange,
  onSubmit,
  onSelectTab,
  onAddTab,
  onCloseTab,
  workspaceRoots,
  activeRootPath,
  onRootChange,
  hasThread
}: {
  tabs: TerminalWorkspaceTab[];
  activeSessionId: string | null;
  shell: string;
  cwd: string;
  output: string;
  input: string;
  scrollRef: RefObject<HTMLPreElement | null>;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onSelectTab: (sessionId: string) => void;
  onAddTab: () => void;
  onCloseTab: (sessionId: string) => void;
  workspaceRoots: string[];
  activeRootPath: string;
  onRootChange: (rootPath: string) => void;
  hasThread: boolean;
}) {
  if (!hasThread) {
    return <WorkspaceEmptyState icon={<IconTerminal />} title="打开终端" message="选择一个任务后即可使用终端。" />;
  }

  if (tabs.length === 0) {
    return (
      <section className="terminal-workspace" aria-label="终端">
        <WorkspaceSubtabStrip items={[]} addLabel="新建终端" onAdd={onAddTab} />
        <WorkspaceEmptyState icon={<IconTerminal />} title="打开终端" message="新建一个终端后即可开始输入命令。" />
      </section>
    );
  }

  return (
    <section className="terminal-workspace" aria-label="终端">
      <WorkspaceSubtabStrip
        items={tabs.map((tab) => ({
          id: tab.id,
          label: tab.title,
          title: tab.title,
          active: tab.id === activeSessionId,
          icon: <IconTerminal />,
          onClick: () => onSelectTab(tab.id),
          onClose: () => onCloseTab(tab.id)
        }))}
        addLabel="新建终端"
        onAdd={onAddTab}
      />
      <div className="terminal-heading">
        <span className="terminal-heading-icon" aria-hidden="true"><IconTerminal /></span>
        <div>
          <strong>{shell}</strong>
          <span title={cwd}>{cwd || "正在连接终端"}</span>
        </div>
        {workspaceRoots.length > 1 ? (
          <select className="workspace-root-select" aria-label="终端目录" value={activeRootPath} onChange={(event) => onRootChange(event.target.value)}>
            {workspaceRoots.map((root) => <option key={root} value={root}>{root}</option>)}
          </select>
        ) : null}
      </div>
      <pre ref={scrollRef} className="terminal-output" aria-live="polite">
        {output || " "}
      </pre>
      <div className="terminal-composer">
        <span className="terminal-prompt" aria-hidden="true">&gt;</span>
        <input
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder="输入命令"
          aria-label="终端命令"
          spellCheck={false}
        />
      </div>
    </section>
  );
}

