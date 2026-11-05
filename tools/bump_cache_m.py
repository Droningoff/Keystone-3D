# -*- coding: utf-8 -*-
from pathlib import Path

root = Path(__file__).resolve().parent.parent
exts = {'.js', '.html', '.css', '.md'}
repl = [
    ('20261028k43', '20261028m'),
    ('20261028k4', '20261028m'),
    ('20261028k3', '20261028m'),
    ('20261028k2', '20261028m'),
    ('20261028k', '20261028m'),
    ('20261028j', '20261028m'),
    ('20261028i', '20261028m'),
]
n = 0
for f in root.rglob('*'):
    if f.suffix.lower() not in exts:
        continue
    if 'node_modules' in f.parts or 'data' in f.parts and f.suffix == '.json':
        if 'data' in f.parts:
            continue
    t = f.read_text(encoding='utf-8')
    t2 = t
    for a, b in repl:
        t2 = t2.replace(a, b)
    t2 = t2.replace('20261028mm', '20261028m')
    if t2 != t:
        f.write_text(t2, encoding='utf-8')
        n += 1
        print(f.relative_to(root))
print('files', n)
