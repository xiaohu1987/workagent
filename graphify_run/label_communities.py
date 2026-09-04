import json
from pathlib import Path

from graphify.build import build_from_json
from graphify.cluster import score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from graphify.export import to_json

out = Path(r"D:\workagent\graphify-out")

extraction = json.loads((out / ".graphify_extract.json").read_text(encoding="utf-8"))
detection = json.loads((out / ".graphify_detect.json").read_text(encoding="utf-8"))
analysis = json.loads((out / ".graphify_analysis.json").read_text(encoding="utf-8"))

G = build_from_json(extraction, root=r"D:\workagent", directed=False)
communities = {int(k): v for k, v in analysis["communities"].items()}
cohesion = {int(k): v for k, v in analysis["cohesion"].items()}
tokens = {"input": extraction.get("input_tokens", 0), "output": extraction.get("output_tokens", 0)}

labels = {
    0: "MCP 仓库检查与代理协议",
    1: "Agent 运行时与恢复机制",
    2: "App 主界面与 GPA 交互",
    3: "桌面后端服务 (DesktopBackend)",
    4: "主题与消息浏览器 UI",
    5: "会话流式草稿与工具调用",
    6: "数据库服务与运行记录",
    7: "GPA 计划文件管理",
    8: "Markdown 渲染与图标",
    9: "浏览器标签与用量统计",
    10: "应用背景管理",
    11: "欢迎页与编辑器组件",
    12: "实时增强与语音能力",
    13: "浏览器页面清洗",
}

questions = suggest_questions(G, communities, labels)

report = generate(
    G, communities, cohesion, labels, analysis["gods"], analysis["surprises"], detection, tokens, r"D:\workagent",
    suggested_questions=questions,
)
(out / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
(out / ".graphify_labels.json").write_text(json.dumps({str(k): v for k, v in labels.items()}, ensure_ascii=False), encoding="utf-8")

wrote = to_json(G, communities, str(out / "graph.json"), community_labels=labels)
if not wrote:
    print("ERROR: refused to shrink graphify-out/graph.json (#479).")
else:
    print("Report updated with community labels")

for cid in list(labels)[:14]:
    members = communities.get(cid, [])
    print(f"relabeled comm {cid}: {len(members)} nodes")
