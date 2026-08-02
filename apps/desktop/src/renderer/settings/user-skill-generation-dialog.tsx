import { IconClose, IconSpinner } from "../icons";
import type { UserSkillGenerationDialog } from "../core/app-types";

export function UserSkillGenerationDialog({ dialog, motionPhase, generating, onClose, onNameChange, onGenerate }: {
  dialog: UserSkillGenerationDialog;
  motionPhase?: string;
  generating: boolean;
  onClose: () => void;
  onNameChange: (name: string) => void;
  onGenerate: () => void;
}) {
  return <div className="project-sheet-overlay motion-overlay" data-motion={motionPhase}>
    <div className="project-sheet confirm-sheet user-skill-generation-sheet" role="dialog" aria-modal="true" aria-labelledby="user-skill-generation-title">
      <div className="project-sheet-header"><div className="project-sheet-copy"><strong id="user-skill-generation-title">提炼技能</strong><span>描述和工作流将根据所选聊天自动生成。</span></div><button className="project-sheet-close" type="button" onClick={onClose} title="关闭" aria-label="关闭" disabled={generating}><IconClose /></button></div>
      <div className="confirm-sheet-body user-skill-generation-body"><p>将从“{dialog.thread.title}”提炼可复用的用户技能。</p><label className="settings-field user-skill-name-field"><span>技能名称</span><input autoFocus value={dialog.name} onChange={(event) => onNameChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && dialog.name.trim() && !generating) onGenerate(); }} maxLength={64} placeholder="例如：月度报表生成" disabled={generating} /><small>支持中文、字母、数字和连字符。</small></label></div>
      <div className="project-sheet-actions"><button className="button ghost" type="button" disabled={generating} onClick={onClose}>取消</button><button className="button primary" type="button" disabled={!dialog.name.trim() || generating} aria-busy={generating} onClick={onGenerate}>{generating ? <><IconSpinner /><span className="user-skill-generating-label">正在生成<span className="user-skill-generating-dots" aria-hidden="true"><i /><i /><i /></span></span></> : "确认生成"}</button></div>
    </div>
  </div>;
}
