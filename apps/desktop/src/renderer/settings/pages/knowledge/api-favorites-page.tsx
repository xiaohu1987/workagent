import type { ApiCardFavorite } from "../../../api-card-favorites";
import { ApiCardFavoritesPanel } from "../../../workspace/api-card-favorites";

type ApiFavoritesPageProps = {
  onInsert: (favorite: ApiCardFavorite) => void;
  threadId?: string | null;
};

export function ApiFavoritesPage({ onInsert, threadId }: ApiFavoritesPageProps) {
  return (
    <div className="settings-section api-favorites-settings-section">
      <ApiCardFavoritesPanel onInsert={onInsert} threadId={threadId} />
    </div>
  );
}
