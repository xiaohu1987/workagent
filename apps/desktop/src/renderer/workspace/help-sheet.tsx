import { IconClose, IconCompose, IconFolder, IconImage, IconKnowledge, IconShield, IconSkills } from "../icons";

export function HelpSheet({ motionPhase, onClose }: { motionPhase: string; onClose: () => void }) {
  return (
    <div className="project-sheet-overlay help-overlay motion-overlay" data-motion={motionPhase}>
      <section className="project-sheet help-sheet" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <header className="project-sheet-header">
          <div className="project-sheet-copy"><strong id="help-title">CodeXH 使用指南</strong><span>产品功能与常用工作流</span></div>
          <button className="project-sheet-close" type="button" title="关闭" aria-label="关闭" onClick={onClose}><IconClose /></button>
        </header>
        <div className="help-layout"><div className="help-content">
          <section id="help-overview" className="help-overview"><span>CODEXH WORKSPACE</span><h2>为开发工作准备的 AI 工作台</h2><p>把对话、项目文件、终端、浏览器、知识库、技能和 MCP 工具放在同一个任务上下文中。</p><div><b>对话驱动</b><b>项目上下文</b><b>工具协作</b></div></section>
          <section id="help-task" className="help-feature"><h3><span><IconCompose /></span>开始一个任务</h3><ol><li><b>01</b> 点击“新建任务”进行普通问答、代码分析或内容处理。</li><li><b>02</b> 点击“新建项目”选择工作目录，让 AI 读取项目文件、使用终端并处理 Git 工作流。</li><li><b>03</b> 在输入框写清目标、约束和预期结果，必要时附上文件或图片后发送。</li></ol></section>
          <section className="help-feature"><h3><span><IconFolder /></span>项目工作区</h3><p>项目模式提供文件浏览、预览、终端、Git 状态与变更操作。右侧工具区可在文件、终端和浏览器间切换；涉及外部影响的操作会根据权限设置请求确认。</p></section>
          <section id="help-chat" className="help-feature"><h3><span><IconImage /></span>对话与附件</h3><p>侧栏保留任务历史，放大镜可检索历史内容。输入框支持拖拽、文件选择和粘贴图片；可一次附加多张图片，单次最多 16 个二进制附件。发送前请确认所选模型支持多模态输入。</p></section>
          <section id="help-knowledge" className="help-feature"><h3><span><IconKnowledge /></span>知识库与随手记</h3><p>知识库可导入文档、文件夹、网页或浏览器页面，用于后续检索。侧栏笔记本图标打开“随手记”：笔记按 Markdown 保存，并同步到全局知识库。不要把密码、密钥或其他敏感信息写入可检索笔记。</p></section>
          <section className="help-feature"><h3><span><IconSkills /></span>技能、MCP 与 GPA</h3><p>技能为任务提供专门流程和工具说明；MCP 用于连接外部服务；GPA 适合目标明确的项目任务，会按目标、计划、执行逐步推进。它们均可在设置和任务上下文中配置。</p></section>
          <section id="help-security" className="help-feature help-safety"><h3><span><IconShield /></span>设置与安全</h3><p>设置中管理模型提供商、默认模型、权限、MCP、技能和更新。使用第三方模型或 MCP 前，核对服务地址、凭据范围和数据处理规则；任何有副作用的命令都应在确认影响后执行。</p></section>
        </div></div>
      </section>
    </div>
  );
}
