import json, sys
from pathlib import Path

out = Path(r"D:\workagent\graphify-out")
d = json.loads(Path(r"D:\workagent\.graphify_detect.json").read_text(encoding="utf-8"))

(out / ".graphify_detect.json").write_text(
    json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8"
)
(out / ".graphify_python").write_text(sys.executable, encoding="utf-8")

imgs = d.get("files", {}).get("image", [])
for f in imgs:
    p = Path(f)
    print("IMAGE:", f, p.stat().st_size if p.exists() else "missing")

allsem = [f for cat in ("document", "paper", "image") for f in d.get("files", {}).get(cat, [])]
(out / ".graphify_uncached.txt").write_text("\n".join(allsem), encoding="utf-8")
print("semantic files:", len(allsem))
print("written:", out / ".graphify_detect.json")