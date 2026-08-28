import type { ThreadRecord } from "@shared-types";
import { IconClose, IconFolder, IconFolders, IconPlus } from "../icons";
import { getFileLeafName } from "../markdown";

type ProjectEditSheetProps = {
  motionPhase?: string;
  cwd: string;
  workspaceRoots: string[];
  isPickingFolder: boolean;
  isSaving: boolean;
  isRemoving: boolean;
  onClose: () => void;
  onChooseFolder: () => void;
  onRemoveRoot: (rootPath: string) => void;
  onSave: () => void;
  onRemoveProject: () => void;
};

export function ProjectEditSheet({
  motionPhase,
  cwd,
  workspaceRoots,
  isPickingFolder,
  isSaving,
  isRemoving,
  onClose,
  onChooseFolder,
  onRemoveRoot,
  onSave,
  onRemoveProject
}: ProjectEditSheetProps) {
  const locked = isPickingFolder || isSaving || isRemoving;
  return (
    <div className="project-sheet-overlay motion-overlay" data-motion={motionPhase}>
      <div className="project-sheet project-edit-sheet" role="dialog" aria-modal="true" aria-labelledby="project-edit-title">
        <div className="project-sheet-header">
          <div className="project-sheet-copy">
            <strong id="project-edit-title">编辑项目</strong>
            <span>协作目录属于整个项目，项目内的聊天会共享这些文件夹。</span>
          </div>
          <button className="project-sheet-close" type="button" onClick={onClose} title="关闭" aria-label="关闭" disabled={locked}><IconClose /></button>
        </div>

        <div className="project-edit-name-field" aria-label="项目名称">
          <IconFolders />
          <span>{getFileLeafName(cwd)}</span>
          <small>{cwd}</small>
        </div>

        <section className="project-edit-roots" aria-labelledby="project-edit-roots-title">
          <h2 id="project-edit-roots-title">源文件夹</h2>
          <div className="project-edit-root-list">
            {workspaceRoots.map((rootPath, index) => (
              <div className="project-edit-root-row" key={rootPath} title={rootPath}>
                <IconFolder />
                <div className="project-edit-root-copy">
                  <strong>{getFileLeafName(rootPath)}</strong>
                  <small>{rootPath}</small>
                </div>
                {index === 0 ? <em>主要</em> : <button type="button" title="移除文件夹" aria-label={`移除 ${rootPath}`} onClick={() => onRemoveRoot(rootPath)} disabled={locked}><IconClose /></button>}
              </div>
            ))}
            <button className="project-edit-add-root" type="button" onClick={onChooseFolder} disabled={locked}>
              <span className="project-edit-add-root-icon"><IconFolder /><IconPlus /></span>
              <span>{isPickingFolder ? "正在选择..." : "添加文件夹"}</span>
            </button>
          </div>
        </section>

        <div className="project-edit-actions">
          <button className="button project-edit-remove" type="button" onClick={onRemoveProject} disabled={locked}>移除本地项目</button>
          <div className="project-edit-actions-main">
            <button className="button ghost" type="button" onClick={onClose} disabled={locked}>取消</button>
            <button className="button primary" type="button" onClick={onSave} disabled={locked}>{isSaving ? "保存中..." : "保存"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function getProjectWorkspaceRoots(thread: ThreadRecord | null | undefined): string[] {
  if (!thread) return [];
  return thread.workspaceRoots?.length ? [...thread.workspaceRoots] : thread.cwd ? [thread.cwd] : [];
}
