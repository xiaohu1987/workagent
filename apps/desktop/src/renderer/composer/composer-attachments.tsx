import type { PluginRecord } from "@shared-types";
import type { ComposerAttachment } from "../lib/conversation-utils";
import { IconClose, IconSkills } from "../icons";
import { ComposerAttachmentChip } from "./attachment-chip";

type Props = {
  attachments: ComposerAttachment[];
  removingAttachmentId: string | null;
  plugins: PluginRecord[];
  enabledPluginIds: Set<string>;
  isProjectThread: boolean;
  onRemoveAttachment: (id: string) => void;
  onDisablePlugin: (pluginId: string, enabled: boolean) => void | Promise<void>;
};

export function ComposerAttachments({ attachments, removingAttachmentId, plugins, enabledPluginIds, isProjectThread, onRemoveAttachment, onDisablePlugin }: Props) {
  const enabledPlugins = plugins.filter((plugin) => enabledPluginIds.has(plugin.id));
  return <>
    {attachments.length > 0 ? <div className="composer-attachments" aria-label="已添加到聊天的上下文">{attachments.map((attachment) => <ComposerAttachmentChip key={attachment.id} attachment={attachment} removing={removingAttachmentId === attachment.id} onRemove={() => onRemoveAttachment(attachment.id)} />)}</div> : null}
    {enabledPlugins.length > 0 ? <div className="composer-attachments" aria-label="当前启用的插件">{enabledPlugins.map((plugin) => <div key={plugin.id} className="composer-attachment-chip skill" title={`${plugin.name} · ${isProjectThread ? "当前项目" : "当前聊天"}`}><span className="composer-attachment-icon" aria-hidden><IconSkills /></span><span className="composer-attachment-copy"><strong><span>{plugin.name}</span></strong></span><button type="button" className="composer-attachment-remove" aria-label={`停用 ${plugin.name}`} onClick={() => void onDisablePlugin(plugin.id, false)}><IconClose /></button></div>)}</div> : null}
  </>;
}
