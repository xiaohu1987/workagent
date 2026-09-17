import { createRoot } from "react-dom/client";
import type { MessageRecord, ShareTaskStats } from "@shared-types";
import { ApiCardThreadContext } from "../cards/api-card-message";
import { formatRelativeTime } from "../core/app-formatters";
import { IconCodexMark } from "../icons";
import { getDisplayMessageContent } from "../lib/conversation-utils";
import { formatShareStats } from "../lib/share-turns";import { renderMarkdownDocument } from "../markdown";

/**
 * The card that is rasterized for image sharing. It intentionally reuses the
 * transcript's `.message-card` / `.message-markdown` markup so the shared image
 * matches what the user sees in the chat, and it is only ever mounted into the
 * off-screen capture host — never into the app UI.
 */

export type ShareCaptureDocumentProps = {
  title: string;
  assistantLabel: string;
  stats: ShareTaskStats;
  messages: readonly MessageRecord[];
  generatedAt: string;
};

export function ShareCaptureDocument({
  title,
  assistantLabel,
  stats,
  messages,
  generatedAt
}: ShareCaptureDocumentProps) {
  return (
    <div className="share-card" data-share-card="true">
      <header className="share-card-head">
        <div className="share-card-brand">
          <IconCodexMark />
          <span>CodeXH</span>
        </div>
        <h1 className="share-card-title">{title || "未命名任务"}</h1>
        <p className="share-card-stats">{formatShareStats(stats)}</p>
      </header>

      <div className="share-card-transcript">
        {messages.map((message) => (
          <ShareCaptureMessage key={message.id} message={message} assistantLabel={assistantLabel} />
        ))}
      </div>

      <footer className="share-card-foot">
        <span className="share-card-foot-note">内容由 AI 生成，请核实重要信息</span>
        <span className="share-card-foot-brand">CodeXH · {generatedAt}</span>
      </footer>
    </div>
  );
}

function ShareCaptureMessage({ message, assistantLabel }: { message: MessageRecord; assistantLabel: string }) {
  const content = getDisplayMessageContent(message);
  if (!content.trim()) return null;

  if (message.role === "user") {
    return (
      <article className="message-card user">
        <div className="message-flat-body">
          {renderMarkdownDocument(content, `${message.id}-share`, "message-markdown")}
        </div>
      </article>
    );
  }

  return (
    <article className="message-card assistant">
      <div className="message-header">
        <span className="message-author assistant">{message.role === "assistant" ? assistantLabel : message.role}</span>
        <span className="timestamp">{formatRelativeTime(message.createdAt)}</span>
      </div>
      <ApiCardThreadContext.Provider value={message.threadId}>
        <div className="message-flat-body">
          {renderMarkdownDocument(content, `${message.id}-share`, "message-markdown")}
        </div>
      </ApiCardThreadContext.Provider>
    </article>
  );
}

export type MountShareCardInput = {
  host: HTMLElement;
  /** Already resolved selection, in transcript order. */
  messages: readonly MessageRecord[];
  title: string;
  assistantLabel: string;
  stats: ShareTaskStats;
};

/**
 * Mount the card into the capture host and return the unmount hook the capture
 * pipeline calls once the image has been produced.
 */
export function mountShareCard(input: MountShareCardInput): () => void {
  const root = createRoot(input.host);
  root.render(
    <ShareCaptureDocument
      title={input.title}
      assistantLabel={input.assistantLabel}
      stats={input.stats}
      messages={input.messages}
      generatedAt={formatGeneratedAt()}
    />
  );
  return () => {
    root.unmount();
  };
}

function formatGeneratedAt(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
