'use client';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import URDFLoader, { URDFRobot } from 'urdf-loader';

// SO-101 follower from TheRobotStudio's open URDF ("old calibration": zero =
// arm stretched horizontally), which matches the degree ranges FLUX 3 Action
// returns. Sign per joint maps the policy's degrees onto the URDF joints.
export const JOINTS = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'] as const;
export const SIGN = [1, -1, 1, 1, 1, 1];
// Shoulder offset fitted by eye to the fal example photo (assumption, not a calibration file).
// Gripper: the policy's percent is not an angle; the jaw is still closed at ~25 % (fal example).
export const OFFSET = [0, 20, 0, 0, 0, -25];
// Recordings from LeRobot datasets use the 'new calibration' (mid-range zero), which the
// matching URDF encodes directly: no sign or offset needed.
const MAP = { old: { sign: SIGN, offset: OFFSET }, new: { sign: [1, 1, -1, 1, 1, 1], offset: [0, 0, 0, 0, 0, -38] } }; // elbow sign fitted on the cube recording // jaw closed at ~38 % in these recordings

export type Track = { id: string; actions: number[][]; tone: 'focus' | 'seed' | 'world' };
type Props = {
  start: number[];
  tracks: Track[];
  focus: string;
  cursor: number;
  calib?: 'old' | 'new';
  ghost?: number[][]; // a second, translucent arm (e.g. the recorded human motion)
  showProps?: boolean;
  objects?: (number | string)[][]; // extra boxes: w, d, h, x, y, z, [colour], [rotation°] (URDF frame)
  view?: { cam: number[]; target: number[]; fov: number; roll?: number }; // URDF frame (z-up), roll in degrees
};

export default function Arm3D({ start, tracks, focus, cursor, calib = 'old', ghost, showProps = true, objects: extra = [], view }: Props) {
  const host = useRef<HTMLDivElement>(null),
    current = useRef({ start, tracks, focus, cursor, ghost });
  current.current = { start, tracks, focus, cursor, ghost };
  const map = MAP[calib];
  const toRad = (row: number[]) => row.map((v, i) => THREE.MathUtils.degToRad(v * map.sign[i] + map.offset[i]));
  const [status, setStatus] = useState('LOADING SO-101 MODEL…');
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    renderer.setClearColor('#000000');
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    Object.assign(renderer.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, 1, 0.01, 20);
    if (view?.roll) {
      // Tilt the up vector around the view axis so OrbitControls keeps the camera roll.
      const f = new THREE.Vector3(view.target[0] - view.cam[0], view.target[2] - view.cam[2], -(view.target[1] - view.cam[1])).normalize();
      camera.up.set(0, 1, 0).applyAxisAngle(f, THREE.MathUtils.degToRad(-view.roll));
    }
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // Same viewpoint as the scene camera used for the H3 reference (URDF z-up → three y-up).
    controls.target.set(0.02, 0.15, 0.1);
    camera.position.set(0.02, 0.34, 0.5);
    if (view) {
      // URDF (x, y, z) → three.js (x, z, -y)
      camera.fov = view.fov;
      camera.position.set(view.cam[0], view.cam[2], -view.cam[1]);
      // Orbit around a point on the view axis at the robot's distance, so dragging
      // turns around the arm instead of a point below the table.
      const aim = new THREE.Vector3(view.target[0], view.target[2], -view.target[1]).sub(camera.position).normalize();
      controls.target.copy(camera.position).addScaledVector(aim, camera.position.length());
    }
    controls.update();
    scene.add(new THREE.HemisphereLight('#ffffff', '#202020', 2.2));
    const key = new THREE.DirectionalLight('#ffffff', 2);
    key.position.set(0.6, 1, 0.4);
    scene.add(key);
    // Table: a 1 cm grid, wireframe like the rest of the interface.
    const grid = new THREE.GridHelper(0.8, 40, '#3a3a3a', '#1c1c1c');
    grid.position.set(0.05, 0, 0.25);
    scene.add(grid);

    // URDF is Z-up; three.js is Y-up.
    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2;
    scene.add(root);
    // Container and box, placed as in the H3 reference scene (URDF frame, metres).
    const edges = new THREE.LineBasicMaterial({ color: '#d8d8d8' });
    const objects: [number, number, number, number, number, number][] = [
      [0.18, 0.1, 0.055, 0.25, 0, 0.034],
      [0.04, 0.04, 0.06, 0.2, -0.33, 0.036],
    ];
    for (const [w, d, h, x, y, z] of showProps ? objects : []) {
      const obj = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, d, h)), edges);
      obj.position.set(x, y, z);
      root.add(obj);
    }
    for (const o of extra) {
      const [w, d, h, x, y, z] = o.slice(0, 6) as number[];
      // Recording props are solid and coloured (default: yellow blocks, dark flat tape).
      const colour = (o[6] as string) || (h > 0.01 ? '#e8c21a' : '#2a2a2a');
      const obj = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), new THREE.MeshStandardMaterial({ color: colour }));
      obj.position.set(x, y, z);
      obj.rotation.z = THREE.MathUtils.degToRad((o[7] as number) || 0);
      root.add(obj);
    }
    const ghosts: URDFRobot[] = [];
    const paths = new Map<string, THREE.Line>();
    let robot: URDFRobot | undefined;
    let disposed = false;
    const material = new THREE.MeshStandardMaterial({ color: '#e9e9e6', roughness: 0.55, metalness: 0.05 });
    const servo = new THREE.MeshStandardMaterial({ color: '#1a1a1a', roughness: 0.45 });
    const ghostMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.07, depthWrite: false });
    const loader = new URDFLoader();
    // Meshes arrive asynchronously: assign the material as each STL loads.
    const defaultMesh = loader.loadMeshCb.bind(loader);
    loader.loadMeshCb = (path, manager, urdfMaterial, done) =>
      defaultMesh(path, manager, urdfMaterial, (obj, err) => {
        obj?.traverse((o) => {
          const m = o as THREE.Mesh;
          // STS3215 servos are black on the real arm; printed parts are white.
          if (m.isMesh) m.material = path.includes('sts3215') ? servo : material;
        });
        done(obj, err);
      });
    loader.load(
      `/flux3/so101/so101_${calib}_calib.urdf`,
      (r) => {
        if (disposed) return;
        robot = r;
        r.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.material = material;
        });
        root.add(r);
        // No ghost clones: each copy of the arm is ~320k triangles.
        for (let i = 0; i < 0; i++) {
          const g = r.clone(true) as URDFRobot;
          g.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) m.material = ghostMat;
          });
          root.add(g);
          ghosts.push(g);
        }
        setStatus('');
      },
      undefined,
      () => setStatus('SO-101 MODEL COULD NOT LOAD'),
    );
    // Optional ghost arm, loaded separately so its meshes get the translucent material.
    let ghostRobot: URDFRobot | undefined;
    const ghostLook = new THREE.MeshStandardMaterial({ color: '#6b6b6b', transparent: true, opacity: 0.62, depthWrite: false });
    if (current.current.ghost) {
      const gl = new URDFLoader();
      const gm = gl.loadMeshCb.bind(gl);
      gl.loadMeshCb = (path, manager, urdfMaterial, done) =>
        gm(path, manager, urdfMaterial, (obj, err) => {
          obj?.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) m.material = ghostLook;
          });
          done(obj, err);
        });
      gl.load(`/flux3/so101/so101_${calib}_calib.urdf`, (r) => {
        if (disposed) return;
        ghostRobot = r;
        r.traverse((o) => (o.renderOrder = 2));
        root.add(r);
      });
    }
    const setPose = (r: URDFRobot, row: number[]) => {
      const rad = toRad(row);
      JOINTS.forEach((j, i) => r.joints[j]?.setJointValue(rad[i]));
    };
    // End-effector path of a chunk, computed by forward kinematics on the URDF.
    const tip = new THREE.Vector3();
    const buildPath = (t: Track) => {
      if (!robot) return;
      const pts: THREE.Vector3[] = [];
      for (const row of t.actions) {
        setPose(robot, row);
        robot.updateMatrixWorld(true);
        (robot.links['gripper'] || robot.links['gripper_link'])?.getWorldPosition(tip);
        pts.push(tip.clone());
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true }),
      );
      scene.add(line);
      paths.set(t.id, line);
    };
    const resize = () => {
      const w = Math.max(1, el.clientWidth),
        h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      if (view) {
        // Keep the recording's horizontal field of view (4:3 frame) whatever the panel shape.
        const hHalf = Math.atan(Math.tan(THREE.MathUtils.degToRad(view.fov / 2)) * (4 / 3));
        camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hHalf) / camera.aspect));
      }
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    let raf = 0;
    const tick = () => {
      if (disposed) return;
      const p = current.current;
      if (robot) {
        for (const t of p.tracks) if (!paths.has(t.id)) buildPath(t);
        paths.forEach((line, id) => {
          const t = p.tracks.find((x) => x.id === id);
          line.visible = !!t;
          const mat = line.material as THREE.LineBasicMaterial;
          mat.opacity = id === p.focus ? 1 : t?.tone === 'seed' ? 0.28 : 0.22;
        });
        const f = p.tracks.find((t) => t.id === p.focus);
        const rows = f?.actions || [p.start];
        const k = Math.min(rows.length - 1, Math.max(0, Math.round(p.cursor)));
        setPose(robot, rows[k]);
        const g = p.ghost;
        if (ghostRobot && g) setPose(ghostRobot, g[Math.min(g.length - 1, k)]);
        ghosts.forEach((g, i) => {
          const gi = Math.round((i / (ghosts.length - 1)) * (rows.length - 1));
          g.visible = gi <= k;
          setPose(g, rows[gi]);
        });
      }
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);
  return (
    <div className="arm3d" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      {status && <div className="arm3d-status">{status}</div>}
    </div>
  );
}
