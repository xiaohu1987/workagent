import { IconClose, IconFolder } from "../icons";
import { getFileLeafName } from "../markdown";

type ProjectCreateSheetProps = {
  motionPhase?: string;
  pathDraft: string;
  recentPaths: string[];
  isPickingFolder: boolean;
  onClose: () => void;
  onChooseFolder: () => void;
  onPathChange: (path: string) => void;
  onConfirm: () => void;
};

export function ProjectCreateSheet({ motionPhase, pathDraft, recentPaths, isPickingFolder, onClose, onChooseFolder, onPathChange, onConfirm }: ProjectCreateSheetProps) {
  return (
    <div className="project-sheet-overlay motion-overlay" data-motion={motionPhase}>
      <div className="project-sheet">
        <div className="project-sheet-header">
          <div className="project-sheet-copy"><strong>新建项目</strong><span>选择一个文件夹，此项目中的文件操作将限制在该文件夹内。</span></div>
          <button className="project-sheet-close" onClick={onClose} title="关闭"><IconClose /></button>
        </div>
        <label className="settings-field project-sheet-field">
          <span>项目文件夹</span>
          <div className="project-folder-picker">
            <output>{pathDraft || "尚未选择文件夹"}</output>
            <button className="button ghost" type="button" onClick={onChooseFolder} disabled={isPickingFolder}><IconFolder />{isPickingFolder ? "正在打开..." : "选择文件夹"}</button>
          </div>
        </label>
        {recentPaths.length > 0 ? (
          <div className="recent-projects" aria-label="最近项目">
            <span className="recent-projects-label">最近项目</span>
            <div className="recent-projects-list">
              {recentPaths.map((projectPath) => (
                <button className={`recent-project-button ${pathDraft === projectPath ? "selected" : ""}`} type="button" key={projectPath} title={projectPath} onClick={() => onPathChange(projectPath)}>
                  <IconFolder /><span className="recent-project-name">{getFileLeafName(projectPath)}</span><span className="recent-project-path">{projectPath}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="project-sheet-actions">
          <button className="button ghost" onClick={onClose}>取消</button>
          <button className="button warm" onClick={onConfirm} disabled={!pathDraft || isPickingFolder}>创建</button>
        </div>
      </div>
    </div>
  );
}
