# -*- coding: utf-8 -*-
from pathlib import Path
p = Path(__file__).resolve().parent.parent / 'js' / 'main.js'
t = p.read_text(encoding='utf-8')
t2 = t.replace('?v=20261028j', '?v=20261028k3').replace('?v=20261028i', '?v=20261028k3').replace('?v=20261028k', '?v=20261028k3')
# avoid double k3k3
t2 = t2.replace('?v=20261028k3k3', '?v=20261028k3')
p.write_text(t2, encoding='utf-8', newline='\n')
print('done', t2.count('20261028k3'))
