import { Fragment, memo, useMemo } from "react";
import type { RefObject } from "react";
import type { ToolCallRecord } from "@shared-types";
import { shouldKeepTimelineEntryWhenTurnCollapsed, type SkillNameMap } from "../lib/conversation-utils";
import type { TimelineEntry } from "../lib/conversation-utils";
import type { UserMessageActions } from "./transcript";
import { TurnElapsedBanner } from "../cards/runtime-cards";
import { FileChangeSummary } from "./conversation-rail";
import { DirectoryReadGroup } from "./directory-read-group";
import { ContextCompactionNotice } from "../composer/model-controls";
import { ToolActivityGroup, TranscriptMessage, UserInputPromptCard } from "./transcript";
import { VirtualizedTimeline } from "./virtualized-timeline";

type ConversationTurnSection = {
  id: string;
  userEntryId: string;
  summaryEntryId: string | null;
  entryIds: string[];
  startedAt: string;
  completedAt: string | null;
};

type Props = {
  entries: TimelineEntry[];
  turnByEntryId: Map<string, ConversationTurnSection>;
  latestTurnId: string | null;
  taskProcessing: boolean;
  collapsedTurnIds: Set<string>;
  deferredRuntimeToolGroup: ToolCallRecord[] | null;
  skillNames?: SkillNameMap;
  assistantLabel: string;
  userMessageActions: UserMessageActions;
  gpaPlanMessageId: string | null;
  finalizingAssistantMessageIds: Set<string>;
  completedLatestTurnAt: string | null;
  scrollElementRef: RefObject<HTMLElement | null>;
  scrollInteractionActive: boolean;
  followLatest: boolean;
  onOpenFolder: (filePath: string) => void;
  /**
   * Asks the chat to glide to the newest content instead of pinning to the bottom in one
   * frame. Must keep a stable identity: a new callback on every render would make the
   * virtualized list re-measure its rows, which is the churn the glide exists to hide.
   */
  onRequestFollowLatest: () => void;
  onToggleTurn: (turnId: string) => void;
  /** Share selection mode is active: tick boxes are rendered in the gutter. */
  shareMode: boolean;
  shareableMessageIds: ReadonlySet<string>;
  selectedShareMessageIds: ReadonlySet<string>;
  onToggleShareMessage: (messageId: string) => void;
};

const getTimelineEntryKey = (entry: TimelineEntry) => entry.id;
const getTimelineEntryAnchorId = (entry: TimelineEntry) =>
  entry.kind === "message" ? `transcript-message-${entry.message.id}` : null;

export const TimelineEntries = memo(function TimelineEntries({
  entries,
  turnByEntryId,
  latestTurnId,
  taskProcessing,
  collapsedTurnIds,
  deferredRuntimeToolGroup,
  skillNames,
  assistantLabel,
  userMessageActions,
  gpaPlanMessageId,
  finalizingAssistantMessageIds,
  completedLatestTurnAt,
  scrollElementRef,
  scrollInteractionActive,
  followLatest,
  onOpenFolder,
  onRequestFollowLatest,
  onToggleTurn,
  shareMode,
  shareableMessageIds,
  selectedShareMessageIds,
  onToggleShareMessage
}: Props) {
  const visibleEntries = useMemo(() => entries.filter((entry) => {
    const entryTurn = turnByEntryId.get(entry.id);
    if (!shouldKeepTimelineEntryWhenTurnCollapsed(entry, entryTurn, collapsedTurnIds)) {
      return false;
    }
    return !(
      deferredRuntimeToolGroup &&
      entry.kind === "tool-group" &&
      entry.toolCalls.some((toolCall) => deferredRuntimeToolGroup.some((tool) => tool.id === toolCall.id))
    );
  }), [collapsedTurnIds, deferredRuntimeToolGroup, entries, turnByEntryId]);

  return (
    <VirtualizedTimeline
      items={visibleEntries}
      getKey={getTimelineEntryKey}
      getAnchorId={getTimelineEntryAnchorId}
      scrollElementRef={scrollElementRef}
      scrollInteractionActive={scrollInteractionActive}
      followLatest={followLatest}
      requestFollowLatest={onRequestFollowLatest}
      renderItem={(entry) => {
        const entryTurn = turnByEntryId.get(entry.id);
        const isLatestTurn = entryTurn?.id === latestTurnId;
        const isActiveTurn = Boolean(isLatestTurn && taskProcessing);
        return (
          <Fragment>
            {entry.kind === "message" ? (
              <TranscriptMessage
                message={entry.message}
                assistantLabel={assistantLabel}
                userMessageActions={userMessageActions}
                isGpaPlanMessage={entry.message.id === gpaPlanMessageId}
                isFinalizingFromDraft={finalizingAssistantMessageIds.has(entry.message.id)}
                shareSelectable={shareMode && shareableMessageIds.has(entry.message.id)}
                shareSelected={selectedShareMessageIds.has(entry.message.id)}
                onToggleShare={onToggleShareMessage}
              />
            ) : entry.kind === "file-summary" ? (
              <FileChangeSummary files={entry.files} onOpenFolder={onOpenFolder} />
            ) : entry.kind === "directory-read-group" ? (
              <DirectoryReadGroup directory={entry.directory} count={entry.count} />
            ) : entry.kind === "context-compaction" ? (
              <ContextCompactionNotice compaction={entry.compaction} />
            ) : entry.kind === "user-input" ? (
              <UserInputPromptCard prompt={entry.prompt} resolving={false} canAnswer={false} onAnswer={() => undefined} />
            ) : (
              <ToolActivityGroup toolCalls={entry.toolCalls} skillNames={skillNames} />
            )}
            {/* A turn that never got past its own user message has no elapsed work to
                report: `completedAt` is still that message's own timestamp, so the footer
                read "已处理 0s" and ruled off a bubble with nothing folded away. An empty
                turn is also exactly what a duplicated user row looked like, so render the
                footer only when the turn holds more than that one entry, or while the send
                is still being processed (where it is the live heartbeat). */}
            {entryTurn && entry.id === entryTurn.userEntryId && (isActiveTurn || entryTurn.entryIds.length > 1) ? (
              <TurnElapsedBanner
                startedAt={entryTurn.startedAt}
                completedAt={isActiveTurn ? null : isLatestTurn && completedLatestTurnAt ? completedLatestTurnAt : entryTurn.completedAt}
                active={isActiveTurn}
                collapsed={collapsedTurnIds.has(entryTurn.id)}
                onToggle={() => onToggleTurn(entryTurn.id)}
              />
            ) : null}
          </Fragment>
        );
      }}
    />
  );
});
