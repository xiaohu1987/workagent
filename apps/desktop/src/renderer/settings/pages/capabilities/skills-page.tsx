import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { SkillMetadata, SkillUsageStats } from "@shared-types";
import { IconCheck, IconChevronDown, IconSearch, IconSkills, IconTrash } from "../../../icons";

type SkillSortMode = "name" | "calls" | "success";
const SKILL_SORT_OPTIONS: Array<{ value: SkillSortMode; label: string }> = [{ value: "name", label: "名称" }, { value: "calls", label: "调用次数" }, { value: "success", label: "成功率" }];
const getSkillSortLabel = (value: SkillSortMode) => SKILL_SORT_OPTIONS.find((option) => option.value === value)?.label ?? SKILL_SORT_OPTIONS[0].label;
type Props = { skillsSearchQuery: string; setSkillsSearchQuery: Dispatch<SetStateAction<string>>; skillsSortMenuRef: MutableRefObject<HTMLDivElement | null>; skillsSortOpen: boolean; setSkillsSortOpen: Dispatch<SetStateAction<boolean>>; skillsSortMode: SkillSortMode; setSkillsSortMode: Dispatch<SetStateAction<SkillSortMode>>; skillsSortPresence: { value: boolean | null; phase: string }; visibleSkills: Array<{ skill: SkillMetadata; stats: SkillUsageStats }>; formatRelativeTime: (value: string) => string; onRemove: (skill: SkillMetadata) => void; };

export function SkillsPage({ skillsSearchQuery, setSkillsSearchQuery, skillsSortMenuRef, skillsSortOpen, setSkillsSortOpen, skillsSortMode, setSkillsSortMode, skillsSortPresence, visibleSkills, formatRelativeTime, onRemove }: Props) { return (
  <div key="capability-skills" className="settings-section capability-panel">
    <div className="config-block skills-config-block">
      <div className="section-copy">
        <strong>独立 Skills</strong>
        <span>展示系统、用户和项目 Skill。插件内的 Skill 请在“插件管理”中查看和移除。</span>
      </div>
      <div className="skills-toolbar">
        <div className="skills-search-wrap">
          <span className="skills-search-icon" aria-hidden><IconSearch /></span>
          <input
            className="skills-search-input"
            type="search"
            value={skillsSearchQuery}
            onChange={(event) => setSkillsSearchQuery(event.target.value)}
            placeholder="搜索名称 / 领域 / 描述"
          />
        </div>
        <div className="skills-sort-control" ref={skillsSortMenuRef}>
          <span>排序</span>
          <div className="skills-sort-menu">
            <button
              type="button"
              className={`skills-sort-trigger${skillsSortOpen ? " is-open" : ""}`}
              aria-haspopup="listbox"
              aria-expanded={skillsSortOpen}
              onClick={() => setSkillsSortOpen((current) => !current)}
            >
              <span>{getSkillSortLabel(skillsSortMode)}</span>
              <IconChevronDown />
            </button>
            {skillsSortPresence.value ? (
              <div className="skills-sort-popover" data-motion={skillsSortPresence.phase} role="listbox">
                {SKILL_SORT_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    role="option"
                    aria-selected={skillsSortMode === value}
                    className={`skills-sort-option${skillsSortMode === value ? " is-selected" : ""}`}
                    onClick={() => {
                      setSkillsSortMode(value);
                      setSkillsSortOpen(false);
                    }}
                  >
                    <span>{label}</span>
                    {skillsSortMode === value ? <IconCheck /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="skills-list capability-list">
        {visibleSkills.length ? visibleSkills.map(({ skill, stats }) => {
          const scopeLabel = skill.scope;
          const scopeClass = skill.scope === "system"
            ? "system"
            : skill.scope === "repo"
              ? "repo"
              : "user";
          const successLabel = stats.callCount > 0
            ? `${Math.round(stats.successRate * 100)}%`
            : "—";
          const canRemove = !skill.pluginId && skill.scope === "user";
          return (
            <article key={skill.id} className="skill-row capability-list-item">
              <div className="skill-row-main">
                <div className="skill-row-title">
                  <span className="skill-row-icon" aria-hidden><IconSkills /></span>
                  <strong title={skill.displayName ?? skill.qualifiedName}>
                    {skill.displayName ?? skill.qualifiedName}
                  </strong>
                  <span className={`skill-scope-pill ${scopeClass}`}>{scopeLabel}</span>
                  <span className="skill-domain-chip">{skill.domain ?? "通用"}</span>
                </div>
                <p className="skill-row-desc" title={skill.description}>{skill.description}</p>
                <div className="skill-row-meta">
                  <span className={`skill-stat ${stats.callCount > 0 ? "is-hot" : ""}`}>
                    调用 {stats.callCount}
                  </span>
                  <span className={`skill-stat ${stats.callCount > 0 && stats.successRate >= 0.9 ? "is-good" : ""}`}>
                    成功 {successLabel}
                  </span>
                  <span className="skill-stat">
                    {stats.lastUsedAt ? formatRelativeTime(stats.lastUsedAt) : "未使用"}
                  </span>
                  <span className="skill-row-path" title={skill.skillPath}>{skill.skillPath}</span>
                </div>
              </div>
              {canRemove ? (
                <button
                  type="button"
                  className="button ghost danger-icon-button skill-remove-button"
                  title={`移除 ${skill.displayName ?? skill.qualifiedName}`}
                  aria-label={`移除 ${skill.displayName ?? skill.qualifiedName}`}
                  onClick={() => onRemove(skill)}
                >
                  <IconTrash />
                </button>
              ) : null}
            </article>
          );
        }) : <div className="detail-empty">{skillsSearchQuery.trim() ? "没有匹配的 Skill。" : "尚未加载独立 Skill。"}</div>}
      </div>
    </div>
  </div>
); }
