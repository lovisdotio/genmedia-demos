'use client';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  ActionId,
  ACTIONS,
  consequences,
  DURATION,
  FPS,
  FRAMES,
  isLeaf3,
  JUNCTION,
  laneX,
  Leaf3Id,
  leaf3Of,
  LeafId,
  leafOf,
  OPTIONS,
  ROBOT,
  SIDES,
  SIGN,
  simulate,
  simulate2,
  splitLeaf,
  splitLeaf3,
} from './sim';
import { buildWorld } from './world';

export type Phase = 'present' | 'decision' | 'clip' | 'overview';
export type TrackId = LeafId | Leaf3Id;
type Props = {
  phase: Phase;
  active?: TrackId;
  selected?: Leaf3Id; // the planner's full 30 s path
  rendered: TrackId[]; // leaves with H3 frames on disk
  time: number; // simulated seconds (0 → 30) on the active path
  speed?: number;
  follow: boolean;
  onManual: () => void;
  onReady: () => void;
  onProgress?: (loaded: number, total: number) => void;
};

// A decision tree laid on the ground beside the street. One group of tracks per
// crossing control (decision 1); each splits in two at the no-entry sign
// (decision 2); the slow group's two leaves split again in three at the
// junction (decision 3, t = 15 → 30 s). Every rendered leaf carries its H3
// frames at the robot's simulated progress. The focused group runs beside the
// road, the others sit aside; every leaf stays visible.
const MAIN_X = -10.5; // focused group, left of the street
const GAP = 11; // spacing between groups
const SPREAD = 2.3; // lateral exaggeration of the detour on the tracks, for readability
const BRANCH = 1.9; // lateral spacing of the junction options on the tracks
const ORDER: ActionId[] = ['slow', 'continue', 'stop'];
// 24 H3 frames per render (every 15th frame of 15 s at 24 fps), tiled 6 × 4.
const COLS = 6,
  ROWS = 4,
  ATLAS = COLS * ROWS,
  STEP = 15;
const FRAME_W = 3.2,
  FRAME_W3 = 1.9; // third-level frames are smaller so the three options stay apart
const cellOf = (i: number, out = new THREE.Vector2()) => out.set(i % COLS, ROWS - 1 - Math.floor(i / COLS));
type GtFrame = { robot: number[] | null; pedestrian: number[] | null };
const vertex =
  'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}';
const fragment =
  // Robot and pedestrian (or cyclist) cut out with a soft matte from the simulated boxes.
  'uniform sampler2D image;uniform vec2 cell;uniform vec2 grid;uniform float alpha;uniform vec4 robotBox;uniform vec4 pedBox;varying vec2 vUv;\nfloat boxMask(vec4 b,vec2 p,float g){if(b.z<=b.x)return 0.;vec2 c=(b.xy+b.zw)*.5;vec2 h=(b.zw-b.xy)*.5+g;vec2 d=abs(p-c)-h;return 1.-smoothstep(-.02,.03,max(d.x,d.y));}\nvoid main(){vec2 uv=(vUv+cell)/grid;vec4 tex=texture2D(image,uv);vec2 p=vec2(vUv.x,1.-vUv.y);float m=max(boxMask(robotBox,p,.004),boxMask(pedBox,p,.008));float a=m*alpha;if(a<.01)discard;gl_FragColor=vec4(tex.rgb,a);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}';
const setBoxes = (m: THREE.ShaderMaterial, g?: GtFrame) => {
  if (g?.robot) m.uniforms.robotBox.value.set(...(g.robot as [number, number, number, number]));
  if (g?.pedestrian) m.uniforms.pedBox.value.set(...(g.pedestrian as [number, number, number, number]));
};
// Group x for each crossing control: focus beside the road, the others further out.
const slotsFor = (focus: ActionId | undefined): Record<ActionId, number> => {
  // At rest the three-level slow group sits furthest out, clear of the result panel.
  if (!focus) return { continue: MAIN_X, stop: MAIN_X - GAP, slow: MAIN_X - GAP * 2 };
  const first = focus;
  const rest = ORDER.filter((id) => id !== first);
  return { [first]: MAIN_X, [rest[0]]: MAIN_X - GAP, [rest[1]]: MAIN_X - GAP * 2 } as Record<ActionId, number>;
};
const smooth = (a: number, b: number, v: number) => {
  const u = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return u * u * (3 - 2 * u);
};
const actionOf = (id: TrackId): ActionId => (isLeaf3(id) ? 'slow' : splitLeaf(id)[0]);
const leafOfTrack = (id: TrackId): LeafId => (isLeaf3(id) ? splitLeaf3(id).parent : id);

// Track geometry in group coordinates. Segment 1: lateral = exaggerated detour,
// held apart after the sign (a tree, not a loop). Segment 2: progress along the
// path (a turn continues down the track), options fanned out at the junction.
const seg1At = (id: LeafId, t: number) => simulate(id)[Math.min(Math.round(t * FPS), FRAMES)];
const sideAt = (id: LeafId, t: number) => {
  const s = seg1At(id, t);
  return ((s.robot.z < SIGN.z ? laneX(SIGN.z, splitLeaf(id)[1]) : s.robot.x) - ROBOT.x) * SPREAD;
};
const arcCache = new Map<Leaf3Id, number[]>();
const arcOf = (id: Leaf3Id) => {
  let a = arcCache.get(id);
  if (!a) {
    const s = simulate2(id);
    a = [0];
    for (let i = 1; i < s.length; i++) a.push(a[i - 1] + Math.hypot(s[i].robot.x - s[i - 1].robot.x, s[i].robot.z - s[i - 1].robot.z));
    arcCache.set(id, a);
  }
  return a;
};
const OPT_X = { straight: 0, turn: BRANCH, wait: -BRANCH };
const pointAt = (id: TrackId, t: number): { x: number; z: number; heading: number } => {
  if (!isLeaf3(id)) {
    const s = seg1At(id, Math.min(t, DURATION));
    return { x: sideAt(id, Math.min(t, DURATION)), z: s.robot.z, heading: s.robot.z < SIGN.z ? 0 : s.robot.heading };
  }
  const { parent, option } = splitLeaf3(id);
  const z15 = seg1At(parent, DURATION).robot.z;
  const i = Math.min(Math.max(0, Math.round((t - DURATION) * FPS)), FRAMES);
  const z = z15 - arcOf(id)[i];
  return { x: sideAt(parent, DURATION) + OPT_X[option] * smooth(JUNCTION.stopZ + 1.5, JUNCTION.zNear - 1.5, z), z, heading: 0 };
};
// Before the detour both sides of a control are the same path; before the
// junction the three options are. Shared stretches are drawn once.
const sharedWith = (id: TrackId, t: number) => {
  if (isLeaf3(id)) {
    // Options share the stretch before they fan out (same lateral position as the parent).
    return Math.abs(pointAt(id, t).x - sideAt(splitLeaf3(id).parent, DURATION)) < 0.2;
  }
  const a = splitLeaf(id)[0];
  return Math.abs(sideAt(leafOf(a, 'left'), t) - sideAt(leafOf(a, 'right'), t)) < 0.25;
};
const span = (id: TrackId) => (isLeaf3(id) ? [DURATION, 2 * DURATION] : [0, DURATION]);

export default function WorldlineScene(props: Props) {
  const host = useRef<HTMLDivElement>(null),
    current = useRef(props);
  current.current = props;
  const [error, setError] = useState(false);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      setError(true);
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    renderer.setClearColor('#000000');
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.touchAction = 'none';
    el.appendChild(renderer.domElement);
    const world = buildWorld('wire');
    const scene = world.scene;
    // Clear the left side of the street for the tracks.
    scene.children.forEach((o) => {
      if (o !== world.robot && o !== world.pedestrian && o !== world.cyclist && o.position.x < -4.2) o.visible = false;
    });
    scene.fog = new THREE.Fog('#000000', 34, 90);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.minDistance = 3;
    controls.maxDistance = 110;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.rotateSpeed = 0.52;
    controls.zoomSpeed = 0.7;
    const overviewTarget = new THREE.Vector3(-22, 1, -15),
      overview = new THREE.Vector3(-1, 21, 15);
    camera.position.copy(overview);
    controls.target.copy(overviewTarget);
    controls.update();
    const textures: THREE.Texture[] = [];
    let texturesSettled = false,
      readySent = false,
      disposed = false;
    const manager = new THREE.LoadingManager();
    manager.onLoad = () => (texturesSettled = true);
    manager.onProgress = (_url, loaded, total) => current.current.onProgress?.(loaded, total);
    const loader = new THREE.TextureLoader(manager);
    // Labels keep one on-screen size regardless of depth (sizeAttenuation off).
    const label = (text: string, color: string, parent: THREE.Object3D = scene, size = 0.3) => {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 96;
      const c = canvas.getContext('2d')!;
      c.fillStyle = color;
      c.font = '400 30px "Courier New", monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(text, 256, 48);
      const t = new THREE.CanvasTexture(canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      textures.push(t);
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, opacity: 0.85, sizeAttenuation: false }),
      );
      sprite.scale.set(size, (size * 96) / 512, 1);
      parent.add(sprite);
      return sprite;
    };
    label('3D SIMULATION', '#bdbdbd').position.set(ROBOT.x, 2.4, 1.4);
    label('NO ENTRY · DECISION 2', '#ffffff').position.set(SIGN.x, 2.1, SIGN.z);
    label('JUNCTION · DECISION 3', '#ffffff').position.set(ROBOT.x, 2.6, (JUNCTION.zNear + JUNCTION.zFar) / 2);

    // ── Tracks (one per leaf), grouped by crossing control.
    type Track = {
      id: TrackId;
      line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
      rails: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>[];
      ghosts: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>[];
      frames: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[];
      label: THREE.Sprite;
    };
    type Group = {
      id: ActionId;
      group: THREE.Group;
      tracks: Track[];
      label: THREE.Sprite;
      link: THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>;
      start: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
      conflict?: THREE.Group;
    };
    const groups: Group[] = [];
    const ghostGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.72, 0.04, 0.95));
    const pathOf = (id: TrackId, dx: number) => {
      const [t0, t1] = span(id);
      return Array.from({ length: 121 }, (_, i) => {
        const p = pointAt(id, t0 + (i / 120) * (t1 - t0));
        return new THREE.Vector3(p.x + dx, 0.02, p.z);
      });
    };
    const addTrack = (group: THREE.Group, id: TrackId, tag: string) => {
      const [t0] = span(id);
      const level3 = isLeaf3(id);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pathOf(id, 0)),
        new THREE.LineBasicMaterial({ color: '#f0f0f0', transparent: true, opacity: 0.9 }),
      );
      group.add(line);
      const rails = (level3 ? [-0.35, 0.35] : [-0.55, 0.55]).map((x) => {
        const r = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pathOf(id, x)),
          new THREE.LineBasicMaterial({ color: '#9a9a9a', transparent: true, opacity: 0.3 }),
        );
        group.add(r);
        return r;
      });
      // Robot footprint every simulated second: a stop shows as stacked boxes.
      const ghosts = Array.from({ length: DURATION + 1 }, (_, k) => {
        const t = t0 + k,
          p = pointAt(id, t);
        const g = new THREE.LineSegments(ghostGeo, new THREE.LineBasicMaterial({ color: '#d8d8d8', transparent: true, opacity: 0.3 }));
        g.position.set(p.x, 0.03 + k * 0.012, p.z);
        g.rotation.y = p.heading;
        if (level3) g.scale.setScalar(0.7);
        g.userData = { t, shared: sharedWith(id, t) };
        group.add(g);
        return g;
      });
      const frames: Track['frames'] = [];
      if (current.current.rendered.includes(id)) {
        const atlas = loader.load(`/sim2real/${id}-atlas.jpg`);
        atlas.colorSpace = THREE.SRGBColorSpace;
        atlas.minFilter = atlas.magFilter = THREE.LinearFilter;
        atlas.generateMipmaps = false;
        textures.push(atlas);
        const w = level3 ? FRAME_W3 : FRAME_W;
        for (let index = 0; index < ATLAS; index++) {
          const tFrame = t0 + (index * STEP) / FPS;
          const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(w, w * 0.571),
            new THREE.ShaderMaterial({
              vertexShader: vertex,
              fragmentShader: fragment,
              uniforms: {
                image: { value: atlas },
                cell: { value: cellOf(index) },
                grid: { value: new THREE.Vector2(COLS, ROWS) },
                alpha: { value: 0.5 },
                robotBox: { value: new THREE.Vector4() },
                pedBox: { value: new THREE.Vector4() },
              },
              transparent: true,
              depthWrite: false,
              side: THREE.DoubleSide,
            }),
          );
          // Standing on the ground at the robot's simulated position at tFrame.
          const p = pointAt(id, tFrame);
          mesh.position.set(p.x, w * 0.29, p.z);
          mesh.userData = { t: tFrame, index, shared: sharedWith(id, tFrame) };
          mesh.renderOrder = index;
          group.add(mesh);
          frames.push(mesh);
        }
        fetch(`/sim2real/${id}-gt.json`)
          .then((r) => r.json())
          .then((data) => {
            const gt = data as { frames: GtFrame[] };
            frames.forEach((f) => setBoxes(f.material, gt.frames[(f.userData.index as number) * STEP]));
          })
          .catch(() => {});
      }
      // Small side tag at the end of each leaf; a leaf without a render says so.
      const end = pointAt(id, t0 + DURATION);
      const l = label(frames.length ? tag : `${tag} · NO RENDER`, '#bdbdbd', group, level3 ? 0.2 : 0.26);
      // Third-level tags are staggered in height so the three ends stay readable.
      const lift = level3 ? { wait: 0.9, straight: 1.5, turn: 2.1 }[splitLeaf3(id as Leaf3Id).option] : 2.05;
      l.position.set(end.x, lift, end.z - 0.4);
      return { id, line, rails, ghosts, frames, label: l };
    };
    for (const a of ACTIONS) {
      const group = new THREE.Group();
      group.position.x = slotsFor(undefined)[a.id];
      scene.add(group);
      const tracks: Track[] = SIDES.map((sd) => addTrack(group, leafOf(a.id, sd.id), sd.short));
      if (a.id === 'slow')
        for (const sd of SIDES) for (const o of OPTIONS) tracks.push(addTrack(group, leaf3Of(sd.id, o.id), o.id.toUpperCase()));
      const groupLabel = label(a.short, '#f0f0f0', group);
      groupLabel.position.set(0, 2.6, (a.id === 'slow' ? pointAt(leaf3Of('right', 'straight'), 2 * DURATION).z : seg1At(leafOf(a.id, 'right'), DURATION).robot.z) - 2.4);
      const start = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.58, 40),
        new THREE.MeshBasicMaterial({ color: '#e6e6e6', side: THREE.DoubleSide, transparent: true }),
      );
      start.rotation.x = -Math.PI / 2;
      start.position.y = 0.03;
      group.add(start);
      // Dashed link from the simulated robot's start to this group's start (decision 1).
      const link = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineDashedMaterial({ color: '#dcdcdc', transparent: true, opacity: 0.6, dashSize: 0.2, gapSize: 0.14 }),
      );
      scene.add(link);
      const g: Group = { id: a.id, group, tracks, label: groupLabel, link, start };
      const c = consequences(a.id);
      if (c.conflict) {
        const cg = new THREE.Group();
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.62, 0.7, 36),
          new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide, transparent: true }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.04;
        cg.add(ring);
        cg.position.set(0, 0, seg1At(leafOf(a.id, 'right'), c.minClearanceAt).robot.z);
        group.add(cg);
        label(`PEDESTRIAN ${c.minClearance.toFixed(2)} m`, '#ffffff', cg).position.set(0, 0.25, 0.95);
        g.conflict = cg;
      }
      groups.push(g);
    }

    // ── "Now" marker on the focused leaf during playback.
    const nowRing = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.62, 36),
      new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    );
    nowRing.rotation.x = -Math.PI / 2;
    scene.add(nowRing);

    let raf = 0,
      last = performance.now(),
      manualOverride = false,
      wasFollowing = current.current.follow;
    const onManual = () => {
      manualOverride = true;
      current.current.onManual();
    };
    controls.addEventListener('start', onManual);
    const resize = () => {
      const width = Math.max(1, el.clientWidth),
        height = Math.max(1, el.clientHeight);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.fov = camera.aspect < 0.9 ? 58 : 42;
      // The result video occupies the upper right of the surrounding page.
      const shift = camera.aspect > 1.15 ? 0.12 : 0;
      camera.setViewOffset(width, height, width * shift, 0, width, height);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    const desiredEye = new THREE.Vector3(),
      desiredTarget = new THREE.Vector3();
    const followPrev = new THREE.Vector3();
    const streetCam = new URLSearchParams(location.search).get('cam') === 'street';
    const tick = (now: number) => {
      if (disposed) return;
      const p = current.current,
        dt = Math.min((now - last) / 1000, 0.08);
      last = now;
      const t = THREE.MathUtils.clamp(Number.isFinite(p.time) ? p.time : 0, 0, 2 * DURATION);
      if (p.follow && !wasFollowing) manualOverride = false;
      wasFollowing = p.follow;
      const focus: TrackId | undefined = p.phase === 'clip' ? p.active : p.phase === 'decision' ? p.selected : undefined;
      // The playing path: a level-3 leaf continues its parent leaf.
      const path = focus ? (isLeaf3(focus) ? [splitLeaf3(focus).parent, focus] : [focus]) : [];
      const onPath = (id: TrackId) => path.includes(id as never);
      const now3 = focus && isLeaf3(focus) && t > DURATION;
      const focusAction = focus ? actionOf(focus) : undefined;
      // The decision step plays the chosen path on a running clock, like a clip.
      const playing = (p.phase === 'clip' || p.phase === 'decision') && !!focus;
      const slots = slotsFor(focusAction);
      const slide = 1 - Math.exp(-dt * 2.2);
      const leafNow = focus ? leafOfTrack(focus) : 'slow-right';
      const sample = now3 ? simulate2(focus as Leaf3Id)[Math.round((t - DURATION) * FPS)] : simulate(leafNow)[Math.round(Math.min(t, DURATION) * FPS)];
      world.apply(sample);
      const trackT = focus ? pointAt(now3 ? focus : leafNow, t) : { x: 0, z: 0 };
      if (playing) {
        // Follow the robot down the focused track; framed wide enough that the
        // other branches (and their frames) stay visible behind it.
        if (streetCam) {
          // '?cam=street': follow the 3D vehicle in the street; the image tracks sit behind it.
          // Aimed between the vehicle and its image track, so both stay in frame.
          desiredTarget.set(THREE.MathUtils.lerp(sample.robot.x, MAIN_X + trackT.x, 0.45), 0.7, sample.robot.z - 4);
        } else desiredTarget.set(MAIN_X - 3 + trackT.x * 0.5, 1, trackT.z - 4);
        if (manualOverride && followPrev.lengthSq() > 0) {
          // The viewer orbited by hand: keep their angle, but keep following the robot.
          const d = desiredTarget.clone().sub(followPrev);
          camera.position.add(d);
          controls.target.add(d);
        }
        followPrev.copy(desiredTarget);
      } else followPrev.set(0, 0, 0);
      if (p.follow && !manualOverride) {
        if (playing) {
          if (streetCam) desiredEye.set(desiredTarget.x + 7, 7.5, desiredTarget.z + 12.5);
          else desiredEye.set(MAIN_X + 8, 9.5, trackT.z + 14);
        } else {
          desiredTarget.copy(overviewTarget);
          desiredEye.copy(overview);
          if (p.phase === 'overview') desiredEye.add(new THREE.Vector3(-5, 5, 6));
        }
        const ease = 1 - Math.exp(-dt * (playing ? 2 : 1.4));
        camera.position.lerp(desiredEye, ease);
        controls.target.lerp(desiredTarget, ease);
      }
      controls.update();
      const focusGroup = groups.find((g) => g.id === focusAction);
      nowRing.visible = playing && !!focusGroup;
      if (focusGroup) nowRing.position.set(focusGroup.group.position.x + trackT.x, 0.04, trackT.z);
      groups.forEach((g) => {
        g.group.position.x += (slots[g.id] - g.group.position.x) * slide;
        const pos = g.link.geometry.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, ROBOT.x, 0.03, ROBOT.startZ);
        pos.setXYZ(1, g.group.position.x, 0.03, ROBOT.startZ);
        pos.needsUpdate = true;
        g.link.computeLineDistances();
        const groupFocus = g.id === focusAction,
          groupDim = !!focusAction && !groupFocus;
        g.link.material.opacity = groupFocus ? 0.75 : groupDim ? 0.12 : 0.35;
        g.start.material.opacity = groupFocus || !focusAction ? 0.9 : 0.25;
        g.label.material.opacity = groupFocus ? 1 : groupDim ? 0.6 : 0.8;
        if (g.conflict) g.conflict.visible = p.phase !== 'present' && !groupDim;
        // Shared stretches (before a split) are drawn once, by the primary track:
        // the playing path when it is here, otherwise the right side / straight on.
        const primary2 = groupFocus && focus ? leafOfTrack(focus) : leafOf(g.id, 'right');
        const primary3 = (side: string) =>
          groupFocus && focus && isLeaf3(focus) && splitLeaf3(focus).side === side ? focus : leaf3Of(side as 'left' | 'right', 'straight');
        g.tracks.forEach((b) => {
          const isFocus = onPath(b.id),
            sibling = groupFocus && !isFocus,
            dim = groupDim;
          const isPrimary = isLeaf3(b.id) ? b.id === primary3(splitLeaf3(b.id).side) : b.id === primary2;
          const [t0] = span(b.id);
          b.line.material.opacity = isFocus ? 1 : sibling ? 0.6 : dim ? 0.45 : 0.7;
          b.rails.forEach((r) => (r.material.opacity = isFocus ? 0.45 : sibling ? 0.25 : dim ? 0.16 : 0.22));
          b.ghosts.forEach((gh) => {
            const s = gh.userData.t as number;
            gh.visible = isPrimary || !gh.userData.shared;
            const passed = !playing || !isFocus || s <= t + 0.01;
            gh.material.opacity = isFocus ? (passed ? 0.8 : 0.12) : sibling ? 0.35 : dim ? 0.22 : 0.25;
          });
          b.frames.forEach((f, i) => {
            f.visible = isPrimary || !f.userData.shared;
            const ft = f.userData.t as number;
            let alpha: number;
            if (isFocus && playing) {
              // Frames appear as the robot reaches them; the latest is fully
              // opaque and the earlier ones settle into a soft trail.
              alpha = ft > t + 0.05 ? 0.05 : 0.22 + 0.78 * Math.exp(-(t - ft) / 1.6);
            } else if (sibling) {
              alpha = 0.55;
            } else if (dim) {
              // Background branches stay readable: their frames are part of the story.
              alpha = 0.42;
            } else {
              // At rest: opacity builds along the track, faint at the start.
              alpha = 0.16 + 0.7 * (i / (ATLAS - 1)) ** 1.4;
            }
            f.material.uniforms.alpha.value += (alpha - f.material.uniforms.alpha.value) * Math.min(1, dt * 8);
            // Billboard around the vertical axis only, so frames stay upright on the ground.
            f.rotation.y = Math.atan2(camera.position.x - (g.group.position.x + f.position.x), camera.position.z - f.position.z);
          });
          b.label.material.opacity = isFocus ? 1 : sibling ? 0.7 : dim ? 0.55 : t0 > 0 ? 0.65 : 0.75;
        });
      });
      renderer.render(scene, camera);
      if (texturesSettled && !readySent) {
        readySent = true;
        current.current.onReady();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.removeEventListener('start', onManual);
      controls.dispose();
      textures.forEach((t) => t.dispose());
      world.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);
  return (
    <div ref={host} className="robot-canvas" aria-label="Wireframe street with a three-level decision tree of rendered futures laid along the road">
      {error && <div className="robot-render-error">3D is unavailable. The recorded renders remain available in the result panel.</div>}
    </div>
  );
}
