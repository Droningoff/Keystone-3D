// Каталог техники, моек, смесителей, коммуникаций.
// Модели процедурные (примитивы Three.js) — без внешних GLB.
// Позже можно подменить builder на загрузку .glb из папки assets/.

export const FIXTURE_CATALOG = {
  // --- Техника ---
  hob_60: {
    title: 'Варочная панель 60', category: 'Техника', kind: 'appliance',
    w: 590, d: 520, h: 50, price: 18000, place: 'countertop', color: 0x22262b,
  },
  oven_60: {
    title: 'Духовой шкаф 60', category: 'Техника', kind: 'appliance',
    w: 595, d: 560, h: 595, price: 28000, place: 'floor', color: 0x2a2e34, elev: 100,
  },
  fridge_60: {
    title: 'Холодильник 60', category: 'Техника', kind: 'appliance',
    w: 600, d: 650, h: 2000, price: 45000, place: 'floor', color: 0xe8eaed,
  },
  dishwasher_60: {
    title: 'Посудомойка 60', category: 'Техника', kind: 'appliance',
    w: 600, d: 560, h: 820, price: 32000, place: 'floor', color: 0xd8dce0, elev: 100,
  },
  hood_60: {
    title: 'Вытяжка 60', category: 'Техника', kind: 'appliance',
    w: 600, d: 480, h: 200, price: 12000, place: 'wall', color: 0xb8bcc2, elev: 1600,
  },
  microwave: {
    title: 'СВЧ встраиваемая', category: 'Техника', kind: 'appliance',
    w: 560, d: 400, h: 380, price: 15000, place: 'wall', color: 0x3a3e44, elev: 1500,
  },

  // --- Мойки ---
  sink_single: {
    title: 'Мойка врезная 1 чаша', category: 'Мойки', kind: 'sink',
    w: 500, d: 450, h: 200, price: 6500, place: 'countertop', color: 0xb0b6bc,
  },
  sink_double: {
    title: 'Мойка врезная 2 чаши', category: 'Мойки', kind: 'sink',
    w: 780, d: 480, h: 200, price: 9800, place: 'countertop', color: 0xb0b6bc,
  },
  sink_corner: {
    title: 'Мойка угловая', category: 'Мойки', kind: 'sink',
    w: 800, d: 800, h: 200, price: 12000, place: 'countertop', color: 0xa8aeb4,
  },

  // --- Смесители ---
  mixer_chrome: {
    title: 'Смеситель высокий хром', category: 'Смесители', kind: 'mixer',
    w: 50, d: 180, h: 320, price: 4500, place: 'countertop', color: 0xc0c6cc, metal: true,
  },
  mixer_black: {
    title: 'Смеситель чёрный', category: 'Смесители', kind: 'mixer',
    w: 50, d: 180, h: 300, price: 5200, place: 'countertop', color: 0x1a1a1a, metal: true,
  },

  // --- Коммуникации ---
  socket_double: {
    title: 'Розетка двойная', category: 'Коммуникации', kind: 'socket',
    w: 80, d: 12, h: 80, price: 250, place: 'wall', color: 0xf5f5f5, elev: 1100,
  },
  socket_kitchen: {
    title: 'Розетка над столешницей', category: 'Коммуникации', kind: 'socket',
    w: 80, d: 12, h: 80, price: 280, place: 'wall', color: 0xf5f5f5, elev: 1100,
  },
  switch_1: {
    title: 'Выключатель', category: 'Коммуникации', kind: 'socket',
    w: 80, d: 12, h: 80, price: 200, place: 'wall', color: 0xf5f5f5, elev: 1000,
  },
  pipe_water: {
    title: 'Труба ХВС/ГВС', category: 'Коммуникации', kind: 'pipe',
    w: 40, d: 40, h: 800, price: 0, place: 'wall', color: 0x4a90d9, elev: 0,
  },
  pipe_sewer: {
    title: 'Канализация Ø50', category: 'Коммуникации', kind: 'pipe',
    w: 50, d: 50, h: 600, price: 0, place: 'floor', color: 0x6b7280, elev: 0,
  },
  pipe_gas: {
    title: 'Газовая труба', category: 'Коммуникации', kind: 'pipe',
    w: 30, d: 30, h: 900, price: 0, place: 'wall', color: 0xd4a017, elev: 200,
  },
};

// Ширина обода мойки; вырез в столешнице = габарит мойки минус два обода
export const SINK_RIM = 25;

let seq = 1;
export const newFixtureId = () => 'f' + Date.now().toString(36) + (seq++);

export function createFixture(type, x = 0, z = 0, rot = 0, elev) {
  const def = FIXTURE_CATALOG[type];
  if (!def) throw new Error('Неизвестный объект: ' + type);
  return {
    id: newFixtureId(),
    type,
    name: '',
    x, z, rot,
    elev: elev ?? def.elev ?? 0,
  };
}

export function fixtureTitle(f) {
  return f.name || FIXTURE_CATALOG[f.type]?.title || f.type;
}

export function fixturesByCategory() {
  const map = new Map();
  for (const [id, def] of Object.entries(FIXTURE_CATALOG)) {
    const c = def.category;
    if (!map.has(c)) map.set(c, []);
    map.get(c).push({ id, ...def });
  }
  return map;
}

/** Построить группу Three.js для объекта (вызывается из viewer). */
export function buildFixtureMesh(THREE, f) {
  const def = FIXTURE_CATALOG[f.type];
  if (!def) return null;
  const g = new THREE.Group();
  g.userData = { fixtureId: f.id, pick: true, kind: 'fixture' };
  const mat = new THREE.MeshStandardMaterial({
    color: def.color,
    metalness: def.metal ? 0.85 : 0.15,
    roughness: def.metal ? 0.25 : 0.7,
  });

  if (def.kind === 'mixer') {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(22, 28, 20, 16), mat);
    base.position.y = 10;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(12, 14, 220, 12), mat);
    col.position.set(0, 120, 0);
    const spout = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 160, 12), mat);
    spout.rotation.x = Math.PI / 2;
    spout.position.set(0, 220, 70);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(14, 10, 30, 12), mat);
    tip.position.set(0, 200, 150);
    g.add(base, col, spout, tip);
  } else if (def.kind === 'sink') {
    // Чаша рисуется только внутренними гранями — сверху видно дно и стенки, как в открытой мойке
    const bw = def.w - SINK_RIM * 2, bd = def.d - SINK_RIM * 2, bh = def.h - 20;
    const inner = new THREE.MeshStandardMaterial({ color: def.color, metalness: 0.7, roughness: 0.35, side: THREE.BackSide });
    const bowl = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), inner);
    bowl.position.y = -bh / 2 + 2;
    g.add(bowl);
    const bar = (w, d, x, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, 4, d), mat); b.position.set(x, 2, z); g.add(b); };
    bar(def.w, SINK_RIM, 0, -def.d / 2 + SINK_RIM / 2);
    bar(def.w, SINK_RIM, 0, def.d / 2 - SINK_RIM / 2);
    bar(SINK_RIM, bd, -def.w / 2 + SINK_RIM / 2, 0);
    bar(SINK_RIM, bd, def.w / 2 - SINK_RIM / 2, 0);
    if (def.w > 600) {
      const div = new THREE.Mesh(new THREE.BoxGeometry(20, bh - 30, bd), mat);
      div.position.y = -(bh - 30) / 2;
      g.add(div);
    }
    const drain = new THREE.Mesh(new THREE.CylinderGeometry(35, 35, 3, 20), new THREE.MeshStandardMaterial({ color: 0x555a60, metalness: 0.8 }));
    drain.position.set(def.w > 600 ? -bw / 4 : 0, -bh + 4, 0);
    g.add(drain);
  } else if (def.kind === 'pipe') {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(def.w / 2, def.w / 2, def.h, 12), mat);
    pipe.position.y = def.h / 2;
    g.add(pipe);
  } else if (def.kind === 'socket') {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(def.w, def.h, def.d), mat);
    plate.position.z = def.d / 2;
    const holeMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const h1 = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 6, 12), holeMat);
    h1.rotation.x = Math.PI / 2;
    h1.position.set(-18, 8, def.d + 1);
    const h2 = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 6, 12), holeMat);
    h2.rotation.x = Math.PI / 2;
    h2.position.set(18, 8, def.d + 1);
    g.add(plate, h1, h2);
  } else {
    // appliance
    const body = new THREE.Mesh(new THREE.BoxGeometry(def.w, def.h, def.d), mat);
    body.position.set(0, def.h / 2, def.d / 2);
    g.add(body);
    if (f.type === 'oven_60' || f.type === 'dishwasher_60') {
      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(def.w - 80, def.h - 120, 8),
        new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.5, roughness: 0.2 }),
      );
      glass.position.set(0, def.h / 2, def.d + 2);
      g.add(glass);
    }
    if (f.type === 'hob_60') {
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(def.w, 8, def.d),
        new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.6, roughness: 0.3 }),
      );
      plate.position.set(0, 8, def.d / 2);
      const burners = [];
      for (const [bx, bz] of [[-120, -100], [120, -100], [-120, 100], [120, 100]]) {
        const b = new THREE.Mesh(
          new THREE.CylinderGeometry(70, 70, 6, 24),
          new THREE.MeshStandardMaterial({ color: 0x333333 }),
        );
        b.position.set(bx, 14, def.d / 2 + bz);
        burners.push(b);
      }
      g.add(plate, ...burners);
    }
    if (f.type === 'fridge_60') {
      const line = new THREE.Mesh(new THREE.BoxGeometry(def.w - 20, 4, 4), new THREE.MeshStandardMaterial({ color: 0x999999 }));
      line.position.set(0, def.h * 0.65, def.d + 2);
      g.add(line);
    }
  }

  g.position.set(+f.x, +f.elev, +f.z);
  g.rotation.y = ((+f.rot || 0) * Math.PI) / 180;
  return g;
}
