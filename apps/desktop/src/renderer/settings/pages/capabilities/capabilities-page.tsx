type CapabilityTab = "skills" | "userSkills" | "plugins" | "lab";

type Props = {
  activeTab: CapabilityTab;
  skillsCount: number;
  userSkillsCount: number;
  pluginsCount: number;
  onTabChange: (tab: CapabilityTab) => void;
};

export function CapabilitiesPage({ activeTab, skillsCount, userSkillsCount, pluginsCount, onTabChange }: Props) {
  return (
    <div className="settings-subtab-bar capability-tab-strip" role="tablist" aria-label="能力中心分类">
      <button type="button" role="tab" aria-selected={activeTab === "skills"} className={`capability-subtab${activeTab === "skills" ? " active" : ""}`} onClick={() => onTabChange("skills")}>
        <span>Skill 库</span><small className="capability-tab-count">{skillsCount}</small>
      </button>
      <button type="button" role="tab" aria-selected={activeTab === "userSkills"} className={`capability-subtab${activeTab === "userSkills" ? " active" : ""}`} onClick={() => onTabChange("userSkills")}>
        <span>用户技能</span><small className="capability-tab-count">{userSkillsCount}</small>
      </button>
      <button type="button" role="tab" aria-selected={activeTab === "plugins"} className={`capability-subtab${activeTab === "plugins" ? " active" : ""}`} onClick={() => onTabChange("plugins")}>
        <span>插件</span><small className="capability-tab-count">{pluginsCount}</small>
      </button>
      <button type="button" role="tab" aria-selected={activeTab === "lab"} className={`capability-subtab${activeTab === "lab" ? " active" : ""}`} onClick={() => onTabChange("lab")}>
        <span>技能实验室</span>
      </button>
    </div>
  );
}
