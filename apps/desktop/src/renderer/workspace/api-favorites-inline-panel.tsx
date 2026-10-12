import type { ApiCardFavorite } from "../api-card-favorites";
import { IconApiCard, IconClose } from "../icons";
import { ApiCardFavoritesPanel } from "./api-card-favorites";

type ApiFavoritesInlinePanelProps = {
  motionPhase: string;
  threadId: string | null;
  onClose: () => void;
  onInsert: (favorite: ApiCardFavorite) => void;
};

/**
 * 接口卡片面板：常驻聊天区里显示与操作，不再挂在设置页。
 * 容器与标题栏直接复用随手记的 `.quick-notes-sheet` 骨架，`.api-favorites-inline` 作为接口卡片的作用域标记。
 */
export function ApiFavoritesInlinePanel({ motionPhase, threadId, onClose, onInsert }: ApiFavoritesInlinePanelProps) {
  return (
    <section className="quick-notes-sheet quick-notes-inline api-favorites-inline" aria-label="接口卡片" data-motion={motionPhase}>
      <header className="project-sheet-header"><div className="quick-notes-header-title"><span className="quick-notes-header-icon" aria-hidden="true"><IconApiCard /></span><strong id="api-favorites-title">接口卡片</strong><span className="quick-notes-header-scope">收藏的 API 卡片</span></div><button className="project-sheet-close" type="button" title="收起接口卡片" aria-label="收起接口卡片" onClick={onClose}><IconClose /></button></header>
      <ApiCardFavoritesPanel onInsert={onInsert} threadId={threadId} />
    </section>
  );
}
