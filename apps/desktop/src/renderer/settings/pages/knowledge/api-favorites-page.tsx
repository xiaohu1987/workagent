import type { ApiCardFavorite } from "../../../api-card-favorites";
import { ApiCardFavoritesPanel } from "../../../workspace/api-card-favorites";

type ApiFavoritesPageProps = {
  onInsert: (favorite: ApiCardFavorite) => void;
};

export function ApiFavoritesPage({ onInsert }: ApiFavoritesPageProps) {
  return (
    <div className="settings-section api-favorites-settings-section">
      <ApiCardFavoritesPanel onInsert={onInsert} />
    </div>
  );
}
