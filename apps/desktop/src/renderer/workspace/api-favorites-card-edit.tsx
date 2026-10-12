import { Switch, TextArea, TextInput } from "../form-controls";
import { parseApiCardConfig, type ApiCardConfig } from "../cards/api-card";
import type { ApiCardFavorite } from "../api-card-favorites";

/** 收藏卡片的编辑态草稿:URL 与入参用文本承载,授权只用一个开关表示有无。 */
export interface ApiCardEditDraft {
  id: string;
  name: string;
  url: string;
  fieldsText: string;
  authEnabled: boolean;
}

export type ApiCardEditResult =
  | { ok: true; name: string; config: ApiCardConfig }
  | { ok: false; error: string };

/** 进入编辑态:把收藏配置展开成可编辑草稿,入参以 JSON 数组回显。 */
export function createApiCardEditDraft(favorite: ApiCardFavorite): ApiCardEditDraft {
  return {
    id: favorite.id,
    name: favorite.name,
    url: favorite.config.url,
    fieldsText: JSON.stringify(favorite.config.fields, null, 2),
    authEnabled: Boolean(favorite.config.auth)
  };
}

/**
 * 校验草稿并还原成卡片配置。
 * 入参 JSON 必须是字段数组,授权开关只切换 auth 的有无(本来就有的授权类型保持不变),
 * 最终仍交给 parseApiCardConfig 做一次整体校验,避免写入非法配置。
 */
export function resolveApiCardEditDraft(
  favorite: ApiCardFavorite,
  draft: ApiCardEditDraft
): ApiCardEditResult {
  let fields: unknown;
  const fieldsText = draft.fieldsText.trim();
  try {
    fields = JSON.parse(fieldsText || "[]");
  } catch (error) {
    return { ok: false, error: `入参 JSON 格式无效:${error instanceof Error ? error.message : String(error)}` };
  }
  if (!Array.isArray(fields)) {
    return { ok: false, error: '入参 JSON 必须是字段数组,例如 [{"name":"id","label":"编号","type":"text"}]。' };
  }

  const next: ApiCardConfig = {
    ...favorite.config,
    url: draft.url.trim(),
    fields: fields as ApiCardConfig["fields"]
  };
  if (draft.authEnabled) {
    next.auth = favorite.config.auth ?? { type: "bearer" };
  } else {
    delete next.auth;
  }

  const parsed = parseApiCardConfig(JSON.stringify(next));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, name: draft.name.trim() || favorite.name, config: parsed.config };
}

/** 编辑态表单:名称、请求地址、入参 JSON 与授权开关。 */
export function ApiFavoritesCardEdit({
  draft,
  error,
  onChange
}: {
  draft: ApiCardEditDraft;
  error: string | null;
  onChange: (patch: Partial<ApiCardEditDraft>) => void;
}) {
  return (
    <div className="api-favorites-card-edit">
      <TextInput
        label="名称"
        value={draft.name}
        placeholder="收藏条目的显示名称"
        onChange={(value) => onChange({ name: value })}
      />
      <TextInput
        label="请求地址"
        required
        value={draft.url}
        placeholder="https://api.example.com/path"
        help="支持 {{字段名}} 占位符，调用时按入参替换。"
        onChange={(value) => onChange({ url: value })}
      />
      <TextArea
        label="入参 JSON"
        mono
        rows={8}
        value={draft.fieldsText}
        placeholder={'[\n  { "name": "id", "label": "编号", "type": "text", "required": true }\n]'}
        help="编辑卡片入参字段数组，与卡片 fields 一致；写 [] 表示这张卡片没有入参。"
        onChange={(value) => onChange({ fieldsText: value })}
      />
      <Switch
        label="需要授权"
        checked={draft.authEnabled}
        help="开启后调用前需要填写授权 Token，关闭则请求不带授权信息。"
        onChange={(checked) => onChange({ authEnabled: checked })}
      />
      {error ? (
        <div className="api-favorites-edit-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
