import { memo, useEffect, useRef } from "react";
import { IconBrain } from "../icons";
import { StreamedText } from "../timeline/transcript";
import { WorkspaceEmptyState } from "./panels";

const FOLLOW_THRESHOLD_PX = 32;

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
  // Follow the stream only while the reader is already parked at the bottom, so
  // scrolling back to re-read an earlier thought is never yanked away.
  const followRef = useRef(true);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !followRef.current) return;
    body.scrollTop = body.scrollHeight;
  }, [text]);

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
        <span className={`thinking-workspace-status ${streaming ? "is-active" : ""}`}>
          {streaming ? "思考中" : "已完成"}
        </span>
      </div>
      <div
        ref={bodyRef}
        className="thinking-workspace-body"
        onScroll={(event) => {
          const body = event.currentTarget;
          followRef.current = body.scrollHeight - body.scrollTop - body.clientHeight <= FOLLOW_THRESHOLD_PX;
        }}
      >
        <StreamedText text={text} instant={!streaming} />
      </div>
    </div>
  );
});
