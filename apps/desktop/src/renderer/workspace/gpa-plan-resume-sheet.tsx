import { IconClose } from "../icons";
import type { GpaPlanResumeDialogState } from "../core/app-types";

type GpaPlanResumeSheetProps = {
  motionPhase?: string;
  dialog: GpaPlanResumeDialogState;
  busy: boolean;
  onDismiss: (options?: { abandon?: boolean }) => void;
  onReview: () => void;
  onConfirm: () => void;
};

export function GpaPlanResumeSheet({ motionPhase, dialog, busy, onDismiss, onReview, onConfirm }: GpaPlanResumeSheetProps) {
  const isAskStep = dialog.step === "ask";
  return (
    <div className="project-sheet-overlay motion-overlay" data-motion={motionPhase}>
      <div className="project-sheet gpa-plan-resume-sheet">
        <div className="project-sheet-header">
          <div className="project-sheet-copy">
            <strong>{isAskStep ? "发现未完成的 GPA 计划" : "确认继续剩余任务"}</strong>
            <span>{isAskStep ? "此项目有一份未完成的计划。是否继续完成？" : `已完成 ${dialog.plan.doneCount} / ${dialog.plan.tasks.length}，剩余 ${dialog.plan.pendingCount} 项。`}</span>
          </div>
          <button className="project-sheet-close" onClick={() => onDismiss()} title="关闭" disabled={busy}><IconClose /></button>
        </div>
        {dialog.step === "review" ? (
          <div className="gpa-plan-resume-body">
            <div className="gpa-plan-resume-progress">
              {dialog.plan.tasks.map((task) => <div key={task.id} className={`gpa-plan-resume-task ${task.done ? "is-done" : "is-pending"}`}><span aria-hidden="true">{task.done ? "✓" : "○"}</span><strong>{task.id}</strong><span>{task.title}</span></div>)}
            </div>
            {dialog.plan.body ? <pre className="gpa-plan-resume-markdown">{dialog.plan.body.slice(0, 4000)}</pre> : null}
          </div>
        ) : null}
        <div className="project-sheet-actions">
          <button className="button ghost" type="button" disabled={busy} onClick={() => onDismiss({ abandon: isAskStep })}>{isAskStep ? "否，废弃此计划" : "取消"}</button>
          {isAskStep ? <button className="button warm" type="button" onClick={onReview}>是，查看计划</button> : <button className="button warm" type="button" disabled={busy} onClick={onConfirm}>{busy ? "正在继续..." : "继续执行剩余步骤"}</button>}
        </div>
      </div>
    </div>
  );
}
