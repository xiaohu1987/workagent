import json
from pathlib import Path

p = Path('.graphify_detect.json')
d = json.loads(p.read_text(encoding='utf-8'))

print('top-level keys:', sorted(d.keys()))

def get_path(entry):
    if isinstance(entry, str):
        return entry
    for k in ('path', 'file', 'filename', 'relpath', 'name'):
        if isinstance(entry, dict) and k in entry:
            return str(entry[k])
    return json.dumps(entry, ensure_ascii=False)

orig_total = d.get('total_files')
files = d.get('files', {})
new_files = {}
removed = 0
words_sum = 0.0
have_words = True

for cat, lst in files.items():
    kept = []
    for entry in lst:
        s = get_path(entry).replace('\\', '/')
        parts = [x for x in s.split('/') if x]
        if 'tests' in parts:
            removed += 1
            continue
        kept.append(entry)
        if isinstance(entry, dict):
            w = None
            for k in ('words', 'word_count', 'tokens'):
                if k in entry:
                    try:
                        w = float(entry[k])
                        break
                    except Exception:
                        pass
            if w is None:
                have_words = False
            else:
                words_sum += w
        else:
            have_words = False
    new_files[cat] = kept

d['files'] = new_files
total_files = sum(len(v) for v in new_files.values())
d['total_files'] = total_files

if have_words and words_sum > 0:
    d['total_words'] = int(words_sum)
elif orig_total:
    d['total_words'] = int(d.get('total_words', 0) * total_files / max(1, orig_total))

p.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding='utf-8')

print(f"removed {removed} files under tests/")
print(f"total_files: {total_files}  total_words: ~{d.get('total_words')}")
for cat, lst in new_files.items():
    print(f"  {cat}: {len(lst)}")

print('sample entry (document):')
docs = new_files.get('document') or next((v for v in new_files.values() if v), [])
if docs:
    print('   ', json.dumps(docs[0], ensure_ascii=False)[:300])
