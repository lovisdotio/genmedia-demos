'use client';
import { useEffect, useRef, useState } from 'react';
import Arm3D from './arm';

type Scene = {
  id: string;
  dataset: string;
  frame: number;
  task: string;
  state: number[];
  human: number[][];
  flux: number[][];
  flux_chain: number[][]; // FLUX 3 re-asked every 32 steps on the real frames
  replans: number[];
  request_id: string;
  scene: string;
  wrist: string;
};
const LABELS = ['SHOULDER PAN', 'SHOULDER LIFT', 'ELBOW', 'WRIST FLEX', 'WRIST ROLL', 'GRIPPER'];
const NAMES: Record<string, string> = { cube: 'YELLOW CUBE', napkin: 'BLUE NAPKIN', pens: 'PENS' };
// Objects placed by eye from the recording (URDF frame, metres): used by the 3D view and the H3 reference.
const OBJECTS: Record<string, (number | string)[][]> = {
  napkin: [[0.08, 0.06, 0.025, 0.308, 0.075, 0.0125, '#2a3bb5', 95]],
  // Positions back-projected from the recording onto the table plane.
  cube: [
    [0.025, 0.025, 0.025, 0.255, 0.12, 0.0125],
    [0.155, 0.016, 0.002, 0.161, -0.005, 0.001],
    [0.155, 0.016, 0.002, 0.161, -0.175, 0.001],
    [0.016, 0.17, 0.002, 0.083, -0.09, 0.001],
    [0.016, 0.17, 0.002, 0.239, -0.09, 0.001],
  ],
};
// Camera placed by hand to resemble the real recording (URDF frame: camera, target, fov).
const VIEWS: Record<string, { cam: number[]; target: number[]; fov: number; roll?: number }> = {
  // Fitted to 6 arm keypoints measured on the recording (≈11 px RMS at 640×480).
  cube: { cam: [1.165, 0.135, 0.842], target: [-0.06, -0.02, -0.195], fov: 20, roll: 17.5 },
  // Overhead camera fitted to base + two gripper positions measured on the recording.
  napkin: { cam: [0.129, -0.092, 0.452], target: [0.159, -0.092, 0], fov: 63.3, roll: -19.2 },
};
const SIM: Record<string, string> = { cube: '/flux3/compare/cube-h3.mp4', napkin: '/flux3/compare/napkin-h3.mp4' };
const W = 300,
  H = 90,
  PAD = 8;

// Two lines per joint: what FLUX 3 proposes vs what the operator actually did next.
function Pair({ j, s, cursor }: { j: number; s: Scene; cursor: number }) {
  const n = Math.min(s.human.length, s.flux_chain.length);
  const human = s.human.slice(0, n),
    flux = s.flux_chain.slice(0, n);
  const all = [...human, ...flux].map((r) => r[j]);
  const lo = Math.min(...all),
    hi = Math.max(...all),
    span = Math.max(hi - lo, 4);
  const x = (i: number) => PAD + (i / (n - 1)) * (W - PAD * 2),
    y = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const line = (rows: number[][]) => rows.map((r, i) => `${x(i)},${y(r[j])}`).join(' ');
  const dh = human[n - 1][j] - human[0][j],
    df = flux[n - 1][j] - flux[0][j];
  const still = Math.abs(dh) < 3;
  const same = still ? Math.abs(df) < 3 : dh * df > 0;
  return (
    <div className={'pair ' + (same ? 'same' : 'diff')}>
      <div className="pair-top">
        <span>{LABELS[j]}</span>
        <b>{still ? (same ? 'BOTH STILL' : 'HUMAN STILL') : same ? 'SAME DIRECTION' : 'OPPOSITE'}</b>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${LABELS[j]}: FLUX 3 vs recorded human`}>
        {s.replans.slice(1).map((r) => (
          <line key={r} x1={x(r)} x2={x(r)} y1="4" y2={H - 4} stroke="#333" strokeDasharray="2 3" />
        ))}
        <polyline points={line(human)} fill="none" stroke="#7a7a7a" strokeWidth="1.4" strokeDasharray="4 3" />
        <polyline points={line(flux)} fill="none" stroke="#f2f2f2" strokeWidth="1.6" />
        <line x1={x(cursor)} x2={x(cursor)} y1="4" y2={H - 4} stroke="#666" strokeWidth=".6" />
      </svg>
      <div className="pair-foot">
        <span>human {dh >= 0 ? '+' : ''}{dh.toFixed(0)}°</span>
        <span>flux {df >= 0 ? '+' : ''}{df.toFixed(0)}°</span>
      </div>
    </div>
  );
}

export default function Compare() {
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [sel, setSel] = useState('cube');
  const [cursor, setCursor] = useState(0);
  const [clock, setClock] = useState(0);
  const video = useRef<HTMLVideoElement>(null),
    sim = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    fetch('/flux3/compare.json')
      .then((r) => r.json())
      .then((d) => setScenes((d as { scenes: Scene[] }).scenes))
      .catch(() => {});
  }, []);
  // Replay the 42 steps at the policy's 30 Hz, then hold a beat.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      // The real recording is the clock: FLUX 3 only covers its first 1.4 s (42 steps at 30 Hz).
      const t = video.current?.currentTime || 0;
      // Keep the H3 simulation on the recording's clock.
      const v = sim.current;
      if (v && v.readyState >= 2) {
        if (Math.abs(v.currentTime - t) > 0.12) v.currentTime = Math.min(t, (v.duration || 5) - 0.05);
        if (v.paused) void v.play().catch(() => {});
      }
      setClock(t);
      setCursor(t * 30);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sel]);
  const s = scenes.find((x) => x.id === sel);
  const agree = s
    ? [0, 1, 2, 3, 4, 5].filter((j) => {
        const n = Math.min(s.human.length, s.flux_chain.length) - 1;
        const dh = s.human[n][j] - s.human[0][j],
          df = s.flux_chain[n][j] - s.flux_chain[0][j];
        return Math.abs(dh) >= 10 && dh * df > 0;
      }).length
    : 0;
  const big = s
    ? [0, 1, 2, 3, 4, 5].filter((j) => {
        const n = Math.min(s.human.length, s.flux_chain.length) - 1;
        return Math.abs(s.human[n][j] - s.human[0][j]) >= 10;
      }).length
    : 0;
  const span = s ? Math.min(s.human.length, s.flux_chain.length) : 42;
  // Display only: ease over 8 steps where a new FLUX 3 call restarts from the real arm pose.
  const shown = s
    ? s.flux_chain.map((row, i) => {
        const r = s.replans.filter((x) => x > 0 && i >= x && i < x + 8).pop();
        if (r === undefined) return row;
        const prev = s.flux_chain[r - 1],
          u = (i - r + 1) / 8;
        return row.map((v, k) => prev[k] + (v - prev[k]) * u);
      })
    : [];
  const call = s ? s.replans.filter((r) => r <= cursor).length : 1;
  return (
    <div className="flux3-workspace">
      <aside className="data-rail flux3-worlds" aria-label="Recorded demonstrations">
        <div className="rail-label">
          REAL RECORDINGS<span>{scenes.length}</span>
        </div>
        {scenes.map((x) => (
          <button key={x.id} className={'world-card ' + (x.id === sel ? 'on' : '')} onClick={() => setSel(x.id)} aria-pressed={x.id === sel}>
            <span className="world-images">
              <img src={x.scene} alt={`${NAMES[x.id]} scene camera`} />
              <img src={x.wrist} alt={`${NAMES[x.id]} wrist camera`} />
            </span>
            <span className="world-name">{NAMES[x.id]}</span>
          </button>
        ))}
        <p className="flux3-note">Public LeRobot SO-101 datasets, one moment in mid-motion each.</p>
      </aside>
      <section className="flux3-center" aria-label="FLUX 3 versus the recorded operator">
        {s && (
          <>
            <div className="flux3-io">
              <div>
                <span>THE TEST</span>
                <p>
                  Same camera images, same arm angles, same instruction “{s.task}”. White arm: what FLUX 3 proposes. Grey arm: what the
                  human operator actually did next.
                </p>
              </div>
              <i>→</i>
              <div>
                <span>
                  RESULT · {(span / 30).toFixed(1)} s · FLUX 3 CALL {call} / {s.replans.length}
                </span>
                <p className="verdict">
                  {agree} / {big} big human moves reproduced in the same direction
                </p>
              </div>
            </div>
            <div className="flux3-stage three">
              <div className="flux3-video">
                <span className="stage-tag">REAL RECORDING · WHAT THE HUMAN DID</span>
                <video ref={video} key={s.id} className="fill" src={`/flux3/compare/${s.id}-human.mp4`} autoPlay muted loop playsInline />
                <span className="stage-foot">
                  {clock * 30 <= span ? `FLUX 3 re-asked every 1.07 s on these real frames` : 'BEYOND THE COMPARED WINDOW'}
                </span>
                <div className="rec-line" aria-hidden="true">
                  <i style={{ width: `${(span / 30 / 5) * 100}%` }} />
                  <u style={{ left: `${(clock / 5) * 100}%` }} />
                </div>
              </div>
              <div className="flux3-arm">
                <div className="arm-legend" aria-label="Legend">
                  <span>
                    <i className="sw white" /> WHITE ARM = FLUX 3
                  </span>
                  <span>
                    <i className="sw grey" /> GREY ARM = HUMAN (REAL)
                  </span>
                  {s.replans.some((r) => r > 0 && Math.abs(cursor - r) < 6) && <b>NEW FLUX 3 CALL · RESYNC TO THE REAL ARM</b>}
                </div>
                <Arm3D key={s.id} start={s.state} tracks={[{ id: 'flux', actions: shown, tone: 'focus' }]} focus="flux" cursor={cursor} calib="new" ghost={s.human} showProps={false} objects={OBJECTS[s.id]} view={VIEWS[s.id]} />
              </div>
              <div className="flux3-video">
                <span className="stage-tag">SIMULATION · H3 MAX PLAYS THE FLUX 3 MOTION</span>
                {SIM[s.id] ? (
                  <video ref={sim} key={'sim-' + s.id} className="fill" src={SIM[s.id]} muted playsInline />
                ) : (
                  <div className="sim-missing">Simulation video not rendered for this scene yet.</div>
                )}
              </div>
            </div>
            <div className="pair-grid">
              {[0, 1, 2, 3, 4, 5].map((j) => (
                <Pair key={j} j={j} s={s} cursor={cursor} />
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
