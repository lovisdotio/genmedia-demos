import * as THREE from 'three';
import { CYCLIST, DURATION, JUNCTION, PEDESTRIAN, ROBOT, Sample, SIGN, WORLD } from './sim';

// One street, two looks: 'photo' is the lit colour render sent to H3 as the
// motion reference; 'wire' is the monochrome data view used in the interface.
export type Style = 'photo' | 'wire';

export type World = {
  scene: THREE.Scene;
  robot: THREE.Group;
  pedestrian: THREE.Group;
  cyclist: THREE.Group;
  apply: (s: Sample) => void;
  dispose: () => void;
};

const WHITE_LINE = '#d6d6d6';

function facadeTexture(seed: number) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 256);
  // Four storeys of two windows per tile; tile = 6 m wide × 12 m tall.
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 2; col++) {
      const x = 34 + col * 128,
        y = 22 + row * 62;
      g.fillStyle = '#c9c4ba';
      g.fillRect(x - 5, y - 4, 70, 46);
      g.fillStyle = (seed + row + col) % 3 ? '#4b5359' : '#5d666c';
      g.fillRect(x, y, 60, 38);
      g.fillStyle = '#e9e6df';
      g.fillRect(x + 28, y, 4, 38);
    }
  g.fillStyle = '#b9b2a6';
  g.fillRect(0, 248, 256, 8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function asphaltTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#56585a';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5000; i++) {
    const v = 70 + Math.floor(Math.random() * 40);
    g.fillStyle = `rgb(${v},${v},${v + 2})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 40);
  return t;
}

export function buildWorld(style: Style): World {
  const scene = new THREE.Scene();
  const disposables: { dispose: () => void }[] = [];
  const photo = style === 'photo';
  const mats = new Map<string, THREE.Material>();
  const mat = (color: string, opts: THREE.MeshStandardMaterialParameters = {}) => {
    const key = color + JSON.stringify(opts, (k, v) => (v instanceof THREE.Texture ? v.uuid : v));
    let m = mats.get(key);
    if (!m) {
      m = photo
        ? new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...opts })
        : // Wire view: no filled faces, so buildings never hide the worldlines.
          new THREE.MeshBasicMaterial({ visible: false });
      mats.set(key, m);
    }
    return m;
  };
  const edgeMat = new THREE.LineBasicMaterial({ color: WHITE_LINE, transparent: true, opacity: 0.55 });
  const edgeDim = new THREE.LineBasicMaterial({ color: '#8a8a8a', transparent: true, opacity: 0.22 });
  disposables.push(edgeMat, edgeDim);
  const box = (
    w: number,
    h: number,
    d: number,
    color: string,
    parent: THREE.Object3D,
    pos: [number, number, number],
    opts?: THREE.MeshStandardMaterialParameters,
    edges: 'bright' | 'dim' | 'none' = 'bright',
  ) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(geo, mat(color, opts));
    m.position.set(...pos);
    m.castShadow = m.receiveShadow = photo;
    parent.add(m);
    if (!photo && edges !== 'none')
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edges === 'dim' ? edgeDim : edgeMat));
    return m;
  };

  // ── Sky, light, fog
  if (photo) {
    scene.background = new THREE.Color('#cdd3d8');
    scene.fog = new THREE.Fog('#cdd3d8', 30, 95);
    scene.add(new THREE.HemisphereLight('#e8edf2', '#6b665e', 1.6));
    const sun = new THREE.DirectionalLight('#fff6ea', 1.5);
    sun.position.set(-12, 22, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -24, near: 1, far: 60 });
    sun.shadow.bias = -0.0005;
    sun.target.position.set(0, 0, -8);
    scene.add(sun, sun.target);
  } else {
    scene.background = null;
  }

  // ── Ground: road, kerbs, sidewalks
  const rw = WORLD.roadHalfWidth,
    sw = WORLD.sidewalk;
  const zMin = -70,
    zMax = 18,
    len = zMax - zMin,
    zMid = (zMax + zMin) / 2;
  if (photo) {
    const asphalt = asphaltTexture();
    disposables.push(asphalt);
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(rw * 2, len),
      new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.95 }),
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, zMid);
    road.receiveShadow = true;
    scene.add(road);
  } else {
    // Metric grid on the road: 1 m cells.
    const pts: THREE.Vector3[] = [];
    for (let x = -rw; x <= rw + 1e-6; x += 1) pts.push(new THREE.Vector3(x, 0, zMax), new THREE.Vector3(x, 0, zMin));
    for (let z = zMin; z <= zMax; z += 1) pts.push(new THREE.Vector3(-rw, 0, z), new THREE.Vector3(rw, 0, z));
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: '#3a3a3a', transparent: true, opacity: 0.35 }),
    );
    scene.add(grid);
  }
  // Kerbs and sidewalks stop at the cross street (segment 2's junction).
  const jn = JUNCTION.zNear,
    jf = JUNCTION.zFar,
    crossEnd = 46;
  for (const s of [-1, 1])
    for (const [z0, z1] of [
      [zMax, jn],
      [jf, zMin],
    ]) {
      box(0.18, 0.14, z0 - z1, '#a9a59d', scene, [s * (rw + 0.09), 0.07, (z0 + z1) / 2], {}, 'dim');
      box(sw, 0.12, z0 - z1, '#b8b3aa', scene, [s * (rw + 0.18 + sw / 2), 0.06, (z0 + z1) / 2], { roughness: 0.9 }, 'dim');
    }
  // Cross street: road, kerbs and sidewalks running out to both sides.
  {
    const x0 = rw + 0.18 + sw,
      w = crossEnd - x0;
    for (const s of [-1, 1]) {
      if (photo) {
        const asphalt = asphaltTexture();
        asphalt.repeat.set(10, 2);
        disposables.push(asphalt);
        const road = new THREE.Mesh(new THREE.PlaneGeometry(crossEnd - rw, jn - jf), new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.95 }));
        road.rotation.x = -Math.PI / 2;
        road.position.set(s * (rw + crossEnd) / 2, 0.001, (jn + jf) / 2);
        road.receiveShadow = true;
        scene.add(road);
      }
      for (const [kz, side] of [
        [jn, 1],
        [jf, -1],
      ]) {
        box(w, 0.14, 0.18, '#a9a59d', scene, [s * (x0 + w / 2), 0.07, kz + side * 0.09], {}, 'dim');
        box(w, 0.12, sw, '#b8b3aa', scene, [s * (x0 + w / 2), 0.06, kz + side * (0.18 + sw / 2)], { roughness: 0.9 }, 'dim');
      }
    }
  }
  // Zebra: stripes 0.5 m wide (x), spanning the crossing depth (z).
  const cz = (WORLD.crossing.zNear + WORLD.crossing.zFar) / 2,
    cd = WORLD.crossing.zNear - WORLD.crossing.zFar;
  for (let x = -rw + 0.35; x < rw - 0.3; x += 1.0)
    box(0.5, 0.012, cd, '#eeeeea', scene, [x + 0.25, 0.006, cz], { roughness: 0.6 }, 'bright');

  // ── Buildings
  const palette = ['#e7dcc2', '#e3b9a3', '#ebe9e2', '#e8d6a8', '#d9d2c4', '#e6c8b4'];
  let seed = 3;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (const s of [-1, 1]) {
    let z = zMax;
    let i = s > 0 ? 2 : 0;
    while (z > zMin) {
      // Leave the cross street and its sidewalks open.
      const gapTop = jn + 0.18 + sw,
        gapBottom = jf - 0.18 - sw;
      if (z <= gapTop && z > gapBottom) {
        z = gapBottom;
        continue;
      }
      let w = 7 + Math.floor(rnd() * 4),
        h = 11 + Math.floor(rnd() * 5),
        d = 9;
      if (z > gapTop && z - w < gapTop) w = z - gapTop;
      const x = s * (rw + 0.18 + sw + d / 2);
      const color = palette[i++ % palette.length];
      if (photo) {
        const tex = facadeTexture(i);
        tex.repeat.set(w / 6, h / 12);
        disposables.push(tex);
        box(d, h, w, color, scene, [x, h / 2, z - w / 2], { map: tex, roughness: 0.92 });
      } else box(d, h, w, color, scene, [x, h / 2, z - w / 2], {}, 'dim');
      z -= w + 0.05;
    }
  }

  // Blocks lining the cross street beyond the corner buildings.
  for (const s of [-1, 1])
    for (const [zc, k] of [
      [jn + 0.18 + sw + 4.5, 0],
      [jf - 0.18 - sw - 4.5, 1],
    ]) {
      const bx = rw + 0.18 + sw + 9.2,
        w = crossEnd - bx,
        h = 12 + k * 2,
        color = palette[(k + (s > 0 ? 3 : 1)) % palette.length];
      if (photo) {
        const tex = facadeTexture(7 + k);
        tex.repeat.set(w / 6, h / 12);
        disposables.push(tex);
        box(w, h, 9, color, scene, [s * (bx + w / 2), h / 2, zc], { map: tex, roughness: 0.92 });
      } else box(w, h, 9, color, scene, [s * (bx + w / 2), h / 2, zc], {}, 'dim');
    }

  // ── Trees and lamp posts on both sidewalks
  for (const s of [-1, 1])
    for (let z = 10; z > zMin; z -= 9) {
      const tx = s * (rw + 1.1),
        tz = z + (s > 0 ? 4 : 0);
      if (tz < jn + 1.5 && tz > jf - 1.5) continue;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 2.6, 8), mat('#5b4a3a'));
      trunk.position.set(tx, 1.3, tz);
      trunk.castShadow = photo;
      scene.add(trunk);
      if (photo) {
        const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.6, 1), mat('#5f7d4a', { flatShading: true }));
        crown.position.set(tx, 3.9, tz);
        crown.scale.set(1, 1.25, 1);
        crown.castShadow = true;
        scene.add(crown);
      } else {
        const geo = new THREE.IcosahedronGeometry(1.6, 0);
        const crown = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeDim);
        crown.position.set(tx, 3.9, tz);
        scene.add(crown);
      }
    }

  // ── No-entry sign standing in the robot's lane (red disc, white bar, grey pole).
  {
    const sign = new THREE.Group();
    sign.position.set(SIGN.x, 0, SIGN.z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, SIGN.poleHeight, 12), mat('#8a8d90', { roughness: 0.5, metalness: 0.4 }));
    pole.position.y = SIGN.poleHeight / 2;
    pole.castShadow = photo;
    sign.add(pole);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.06, 20), mat('#55585b', { roughness: 0.8 }));
    base.position.y = 0.03;
    sign.add(base);
    // The disc faces the oncoming robot (+z side).
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(SIGN.radius, SIGN.radius, 0.03, 40), mat('#c8102e', { roughness: 0.45 }));
    disc.rotation.x = Math.PI / 2;
    disc.position.set(0, SIGN.plateY, 0.04);
    disc.castShadow = photo;
    sign.add(disc);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(SIGN.radius * 1.35, 0.1, 0.012), mat('#ffffff', { roughness: 0.4 }));
    bar.position.set(0, SIGN.plateY, 0.06);
    sign.add(bar);
    if (!photo) {
      const bright = new THREE.LineBasicMaterial({ color: '#ffffff' });
      disposables.push(bright);
      for (const m of [pole, disc, bar, base]) m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 20), bright));
    }
    scene.add(sign);
  }

  // ── Robot: ivory body, orange band, black chassis, six wheels, rear lamps, mast.
  const robot = new THREE.Group();
  const L = ROBOT.length,
    W = ROBOT.width,
    c = ROBOT.clearance;
  box(W, 0.14, L * 0.94, '#1b1c1e', robot, [0, c + 0.07, 0], { roughness: 0.6 });
  box(W, ROBOT.bodyHeight - 0.14, L, '#ece6d6', robot, [0, c + 0.14 + (ROBOT.bodyHeight - 0.14) / 2, 0], {
    roughness: 0.45,
  });
  box(W + 0.006, 0.03, L + 0.006, '#e0701f', robot, [0, c + 0.155, 0], { roughness: 0.5 }, 'none');
  for (const x of [-1, 1])
    for (const z of [-0.34, 0, 0.34]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.11, 18), mat('#141414', { roughness: 0.9 }));
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x * (W / 2 - 0.08), 0.13, z);
      wheel.castShadow = photo;
      robot.add(wheel);
      if (!photo)
        wheel.add(new THREE.LineSegments(new THREE.EdgesGeometry(wheel.geometry, 30), edgeMat));
    }
  for (const x of [-1, 1]) {
    box(0.07, 0.03, 0.01, '#ff2a1a', robot, [x * 0.23, c + ROBOT.bodyHeight - 0.08, L / 2 + 0.004], {
      emissive: '#ff2a1a',
      emissiveIntensity: 1.4,
    }, 'none');
    box(0.1, 0.035, 0.01, '#ff2a1a', robot, [x * 0.25, c + 0.07, L / 2 * 0.94 + 0.006], {
      emissive: '#ff2a1a',
      emissiveIntensity: 1.2,
    }, 'none');
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, ROBOT.mastHeight - c - ROBOT.bodyHeight, 8), mat('#1b1c1e'));
  mast.position.set(0, (ROBOT.mastHeight + c + ROBOT.bodyHeight) / 2, -L * 0.1);
  robot.add(mast);
  box(0.13, 0.07, 0.07, '#1b1c1e', robot, [0, ROBOT.mastHeight, -L * 0.1], { roughness: 0.4 });
  scene.add(robot);

  // ── Pedestrian: articulated enough to read as a walking person.
  // Brighter, denser edges so the pedestrian reads as a volume in the wire view.
  const pedEdge = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 });
  disposables.push(pedEdge);
  const pedestrian = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = 0.92;
  pedestrian.add(hips);
  const capsule = (r: number, len: number, color: string, parent: THREE.Object3D, pos: [number, number, number]) => {
    const geo = new THREE.CapsuleGeometry(r, len, 6, 14);
    const m = new THREE.Mesh(geo, mat(color, { roughness: 0.8 }));
    m.position.set(...pos);
    m.castShadow = m.receiveShadow = photo;
    parent.add(m);
    if (!photo) m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 8), pedEdge));
    return m;
  };
  const limb = (r: number, len: number, color: string, parent: THREE.Object3D, x: number, y: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    parent.add(pivot);
    capsule(r, len, color, pivot, [0, -len / 2 - r * 0.6, 0]);
    return pivot;
  };
  const legL = limb(0.07, 0.74, '#262d38', hips, -0.09, 0),
    legR = limb(0.07, 0.74, '#262d38', hips, 0.09, 0);
  capsule(0.17, 0.36, '#7a3b2e', hips, [0, 0.36, 0]).scale.set(1.12, 1, 0.72);
  const armL = limb(0.05, 0.5, '#7a3b2e', hips, -0.23, 0.6),
    armR = limb(0.05, 0.5, '#7a3b2e', hips, 0.23, 0.6);
  capsule(0.05, 0.04, '#c89a7c', hips, [0, 0.66, 0]);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 18, 14), mat('#c89a7c', { roughness: 0.7 }));
  head.position.set(0, 0.74, 0);
  head.scale.set(0.9, 1.08, 1);
  head.castShadow = photo;
  hips.add(head);
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.112, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    mat('#2a1d16', { roughness: 0.9 }),
  );
  hair.position.set(0, 0.755, -0.008);
  hair.scale.set(0.92, 1.08, 1.02);
  hips.add(hair);
  if (!photo) head.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.11, 1)), pedEdge));
  pedestrian.rotation.y = -Math.PI / 2; // walks toward -x
  scene.add(pedestrian);

  // ── Cyclist (segment 2): rider in a blue jacket on a city bike, riding toward -x.
  const cyclist = new THREE.Group();
  {
    const wheelGeo = new THREE.TorusGeometry(0.33, 0.028, 8, 28);
    for (const x of [-0.53, 0.53]) {
      const w = new THREE.Mesh(wheelGeo, mat('#1a1a1a', { roughness: 0.7 }));
      w.position.set(x, 0.34, 0);
      w.castShadow = photo;
      cyclist.add(w);
      if (!photo) w.add(new THREE.LineSegments(new THREE.EdgesGeometry(wheelGeo, 20), pedEdge));
    }
    box(1.0, 0.05, 0.05, '#2b5d8a', cyclist, [0, 0.62, 0], { roughness: 0.5, metalness: 0.3 });
    box(0.05, 0.4, 0.05, '#2b5d8a', cyclist, [0.12, 0.62, 0], { roughness: 0.5, metalness: 0.3 });
    box(0.05, 0.05, 0.5, '#1b1c1e', cyclist, [-0.48, 1.02, 0], { roughness: 0.5 });
    capsule(0.16, 0.42, '#2f4f86', cyclist, [0.1, 1.28, 0]).rotation.z = -0.45;
    capsule(0.07, 0.62, '#23262b', cyclist, [0.12, 0.72, 0.1]).rotation.z = 0.3;
    capsule(0.07, 0.62, '#23262b', cyclist, [0.12, 0.72, -0.1]).rotation.z = -0.1;
    capsule(0.045, 0.5, '#2f4f86', cyclist, [-0.2, 1.22, 0.16]).rotation.z = 1.1;
    capsule(0.045, 0.5, '#2f4f86', cyclist, [-0.2, 1.22, -0.16]).rotation.z = 1.1;
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), mat('#f2f2f2', { roughness: 0.4 }));
    helmet.position.set(-0.08, 1.66, 0);
    helmet.castShadow = photo;
    cyclist.add(helmet);
    if (!photo) helmet.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.13, 1)), pedEdge));
  }
  scene.add(cyclist);

  const apply = (s: Sample) => {
    robot.position.set(s.robot.x, 0, s.robot.z);
    robot.rotation.y = s.robot.heading;
    const p = s.pedestrian;
    pedestrian.position.set(p.x, 0, p.z);
    const swing = p.walking ? Math.sin(p.phase * Math.PI) * 0.45 : 0;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    armL.rotation.x = -swing * 0.8;
    armR.rotation.x = swing * 0.8;
    hips.position.y = 0.92 + (p.walking ? Math.abs(Math.cos(p.phase * Math.PI)) * 0.03 : 0);
    cyclist.position.set(s.cyclist.x, 0, s.cyclist.z);
    cyclist.visible = s.cyclist.x < CYCLIST.startX + 30;
  };

  const dispose = () => {
    disposables.forEach((d) => d.dispose());
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
  };
  return { scene, robot, pedestrian, cyclist, apply, dispose };
}

// ── Cameras used for the H3 reference and ground truth.
export type CameraId = 'chase' | 'roadside' | 'ego';
export const CAMERAS: Record<CameraId, { fov: number; label: string }> = {
  chase: { fov: 46, label: 'CHASE CAMERA BEHIND THE ROBOT' },
  roadside: { fov: 42, label: 'FIXED CAMERA BEHIND THE START' },
  ego: { fov: 82, label: 'ROBOT MAST CAMERA' },
};

export function placeCamera(cam: THREE.PerspectiveCamera, id: CameraId, s: Sample) {
  cam.fov = CAMERAS[id].fov;
  if (id === 'chase') {
    // Rigidly attached behind the robot, low, like the recorded chase clips.
    // Segment 2 (t > 15 s) turns with the robot; segment 1 was rendered heading-free.
    const h = s.t > DURATION ? s.robot.heading : 0,
      fx = -Math.sin(h),
      fz = -Math.cos(h);
    cam.position.set(s.robot.x - fx * 2.5, 1.05, s.robot.z - fz * 2.5);
    cam.lookAt(s.robot.x + fx * 6, 0.5, s.robot.z + fz * 6);
  } else if (id === 'roadside') {
    cam.position.set(ROBOT.x - 0.1, 2.2, ROBOT.startZ + 5.2);
    cam.lookAt(ROBOT.x - 0.1, 0.35, ROBOT.startZ - 10);
  } else {
    cam.position.set(s.robot.x, ROBOT.mastHeight - 0.02, s.robot.z - ROBOT.length * 0.1 - 0.05);
    cam.lookAt(s.robot.x, ROBOT.mastHeight - 0.35, s.robot.z - 10);
  }
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
}

// Projected 2D boxes (normalized 0..1, y down) of the robot body and pedestrian.
export type Box2 = [number, number, number, number] | null;
function project(cam: THREE.PerspectiveCamera, corners: THREE.Vector3[]): Box2 {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    front = 0;
  const v = new THREE.Vector3();
  for (const c of corners) {
    v.copy(c).applyMatrix4(cam.matrixWorldInverse);
    if (v.z < -0.05) front++;
    v.copy(c).project(cam);
    x0 = Math.min(x0, v.x);
    x1 = Math.max(x1, v.x);
    y0 = Math.min(y0, v.y);
    y1 = Math.max(y1, v.y);
  }
  if (front < corners.length) return null;
  const b: [number, number, number, number] = [
    Math.max(0, (x0 + 1) / 2),
    Math.max(0, (1 - y1) / 2),
    Math.min(1, (x1 + 1) / 2),
    Math.min(1, (1 - y0) / 2),
  ];
  return b[2] > b[0] && b[3] > b[1] ? b : null;
}
const cornersOf = (cx: number, cz: number, hw: number, hd: number, h: number, heading = 0) => {
  const out: THREE.Vector3[] = [];
  const c = Math.cos(heading),
    sn = Math.sin(heading);
  for (const x of [-hw, hw])
    for (const z of [-hd, hd]) for (const y of [0, h]) out.push(new THREE.Vector3(cx + x * c + z * sn, y, cz - x * sn + z * c));
  return out;
};
export function groundTruth(cam: THREE.PerspectiveCamera, s: Sample) {
  return {
    // Includes the camera mast: detectors segment it as part of the robot.
    robot: project(
      cam,
      cornersOf(s.robot.x, s.robot.z, ROBOT.width / 2, ROBOT.length / 2, ROBOT.mastHeight + 0.035, s.t > DURATION ? s.robot.heading : 0),
    ),
    pedestrian: project(cam, cornersOf(s.pedestrian.x, s.pedestrian.z, 0.22, 0.25, PEDESTRIAN.height)),
    sign: project(cam, cornersOf(SIGN.x, SIGN.z, SIGN.radius, 0.05, SIGN.plateY + SIGN.radius)),
    cyclist: project(cam, cornersOf(s.cyclist.x, s.cyclist.z, CYCLIST.length / 2, CYCLIST.width / 2, CYCLIST.height)),
    // The rider alone: what a "person" detector outlines (the bicycle is not a person).
    rider: project(cam, cornersOf(s.cyclist.x + 0.05, s.cyclist.z, 0.32, 0.25, CYCLIST.height)),
  };
}
