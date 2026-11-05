# -*- coding: utf-8 -*-
import json
from pathlib import Path

p = Path(__file__).resolve().parent.parent / 'data' / 'hardware_catalog.json'
d = json.loads(p.read_text(encoding='utf-8'))
defaults = {
    'hinge': 'Петля Sensys 110.f3d',
    'slide': 'Направляющие шариковые.f3d',
    'leg': 'Цокольная ножка.f3d',
    'hanger': 'Навеска SCARPI-4.f3d',
    'handle': 'Ручка-скоба 128.f3d',
    'tipon': 'TIP-ON.f3d',
    'shelfPin': 'Полкодержатель.f3d',
    'fastener': 'Конфирмат.f3d',
    'tray': 'Поддон.f3d',
}
for it in d['items']:
    mesh = it.get('mesh') or ''
    it['bazisFile'] = it.get('bazisFile') or defaults.get(mesh, '')
    if mesh == 'hinge':
        it['mount'] = 'pair'  # боковина + фасад
    elif mesh in ('handle', 'tipon', 'shelfPin', 'hanger', 'slide', 'leg'):
        it['mount'] = 'face'
    else:
        it['mount'] = 'face'
p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('patched', len(d['items']))
