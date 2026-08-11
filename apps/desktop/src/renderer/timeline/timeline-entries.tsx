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
  onOpenFolder: (filePath: string) => void;
  onToggleTurn: (turnId: string) => void;
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
  onOpenFolder,
  onToggleTurn
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
            {entryTurn && entry.id === entryTurn.userEntryId ? (
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
