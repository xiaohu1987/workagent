import { memo, useLayoutEffect, useRef } from "react";
import { IconBrain } from "../icons";
import { StreamedText } from "../timeline/transcript";
import { WorkspaceEmptyState } from "./panels";

export type ThinkingStatus = "thinking" | "executing" | "done";

/**
 * Which phase the panel is reporting. Reasoning and execution are separate: the
 * model routinely finishes a thought and then spends minutes running tools, and
 * labelling that stretch "已完成" claimed the task was over while it was not.
 */
export function resolveThinkingStatus({ taskRunning, streaming }: { taskRunning: boolean; streaming: boolean }): ThinkingStatus {
  if (streaming) return "thinking";
  if (taskRunning) return "executing";
  return "done";
}

const THINKING_STATUS_LABEL: Record<ThinkingStatus, string> = {
  thinking: "思考中",
  executing: "执行中",
  done: "已完成"
};

// Each state carries its own accent colour so the badge reads at a glance: blue
// while reasoning streams in, amber while the task runs without new reasoning,
// green once the turn has settled.
const THINKING_STATUS_CLASS: Record<ThinkingStatus, string> = {
  thinking: "is-active",
  executing: "is-executing",
  done: "is-done"
};

/**
 * Reasoning used to stream at the tail of the chat transcript, where every frame
 * of it changed the height of the conversation and pushed the whole chat up and
 * down. It renders in this dedicated workspace tab instead, so the transcript
 * keeps a stable height while the model thinks.
 */
export const ThinkingWorkspace = memo(function ThinkingWorkspace({
  text,
  taskRunning,
  streaming
}: {
  text: string;
  taskRunning: boolean;
  streaming: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const status = resolveThinkingStatus({ taskRunning, streaming });

  // The panel is a live tail: it always shows the newest reasoning, so the reader
  // never has to chase the stream. Waiting on the `text` prop alone is not enough,
  // because StreamedText reveals its backlog one frame at a time and a frame can
  // grow the body without the prop changing. Observing the stream wrapper pins the
  // body on every growth, however the bytes arrive.
  const hasText = text.trim().length > 0;
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const stream = streamRef.current;
    if (!body || !stream) return;
    const pinToLatest = () => {
      body.scrollTop = body.scrollHeight;
    };
    pinToLatest();
    const observer = new ResizeObserver(pinToLatest);
    observer.observe(stream);
    return () => observer.disconnect();
  }, [hasText]);

  if (!text.trim()) {
    return (
      <WorkspaceEmptyState
        icon={<IconBrain />}
        title="深度思考"
        message={taskRunning ? "模型正在思考，思考内容会实时出现在这里。" : "发起任务后，模型的思考过程会显示在这里。"}
      />
    );
  }

  return (
    <div className="thinking-workspace">
      <div className="thinking-workspace-header">
        <span className="thinking-workspace-title">
          <IconBrain />
          <span>深度思考</span>
        </span>
        <span className={`thinking-workspace-status ${THINKING_STATUS_CLASS[status]}`}>
          {status === "thinking" ? <span className="thinking-workspace-status-dot" aria-hidden="true" /> : null}
          {THINKING_STATUS_LABEL[status]}
        </span>
      </div>
      <div ref={bodyRef} className="thinking-workspace-body">
        <div ref={streamRef} className="thinking-workspace-stream">
          <StreamedText text={text} instant={!streaming} />
        </div>
      </div>
    </div>
  );
});
