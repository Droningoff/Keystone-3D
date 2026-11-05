# -*- coding: utf-8 -*-
import json, collections
from pathlib import Path

base = Path(__file__).resolve().parent.parent / 'data' / 'samolet'
idx = json.loads((base / 'index.json').read_text(encoding='utf-8'))
hw_cnt = collections.Counter()
hw_art = {}
metal_names = collections.Counter()
for it in idx['items']:
    p = base / 'm' / f"{it['n']}.json"
    if not p.exists():
        continue
    g = json.loads(p.read_text(encoding='utf-8'))
    for h in g.get('hw') or []:
        name = (h.get('name') or '').strip().replace('\r', ' ')
        art = (h.get('art') or '').strip()
        if not name:
            continue
        hw_cnt[name] += 1
        if art and name not in hw_art:
            hw_art[name] = art
    for q in g.get('parts') or []:
        if len(q) >= 10 and q[6] == 'metal':
            nm = (q[9] or '').strip().replace('\r', ' ')
            if nm:
                metal_names[nm] += 1

out = {
    'source': 'samolet',
    'hw': [{'name': n, 'art': hw_art.get(n, ''), 'modules': c} for n, c in hw_cnt.most_common()],
    'metal': [{'name': n, 'count': c} for n, c in metal_names.most_common()],
}
dest = base / 'hardware_raw.json'
dest.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print('unique hw', len(hw_cnt), 'unique metal', len(metal_names), '->', dest)
for name, c in hw_cnt.most_common(40):
    print(f'{c:4d} | {hw_art.get(name, ""):12s} | {name}')
