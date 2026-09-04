import json
from pathlib import Path
from graphify.detect import detect

root = Path(r"D:\workagent")
result = detect(root)

def get_path(entry):
    if isinstance(entry, str):
        return entry
    for k in ("path", "file", "filename", "relpath", "name"):
        if isinstance(entry, dict) and k in entry:
            return str(entry[k])
    return ""

files = result.get("files", {})
new_files = {}
removed = 0
for cat, lst in files.items():
    kept = []
    for entry in lst:
        s = get_path(entry).replace("\\", "/")
        parts = [x for x in s.split("/") if x]
        if "tests" in parts or "node_modules" in parts:
            removed += 1
            continue
        kept.append(entry)
    if kept:
        new_files[cat] = kept

result["files"] = new_files
result["total_files"] = sum(len(v) for v in new_files.values())

out = root / ".graphify_detect.json"
out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")

print("removed:", removed)
print("total_files:", result.get("total_files"), "total_words:", result.get("total_words"))
for cat, lst in new_files.items():
    print(f"  {cat}: {len(lst)}")
print("written:", out)
