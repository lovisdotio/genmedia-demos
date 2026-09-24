'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import ExperienceNav from '../experience-nav';
import '../shared/world.css';
import './flux3.css';
import Arm3D, { Track } from './arm';
import Compare from './compare';

type Run = {
  request_id: string;
  seed: number;
  world: string;
  actions: number[][];
  timings: { download: number; inference: number };
};
type World = {
  id: string;
  label: string;
  edit: string | null;
  scene: string;
  wrist: string;
};
type Data = {
  endpoint: string;
  prompt: string;
  state: number[];
  action_labels: string[];
  units: string[];
  action_hz: number;
  execute_steps: number;
  worlds: World[];
  baselines: Run[];
  runs: Record<string, Run>;
};

// Only flag values more than 2 units beyond the three-seed spread.
const MARGIN = 2;
// The H3 videos are pre-accelerated ×2.5 (5 s render → 2 s file, ~0.7× real time): play at 1×.
const PLAYBACK = 1;
// The first 1.25 s of each 5 s render blend from the photo pose into the 3D pose: cut.
const TRIM = 1.25,
  SPEED = 2.5,
  RENDER_S = 5;
const W = 320,
  H = 150,
  PAD = 10;

function JointChart({
  j,
  data,
  selected,
  cursor,
}: {
  j: number;
  data: Data;
  selected: string;
  cursor: number;
}) {
  const steps = data.baselines[0].actions.length;
  const all = [...data.baselines, ...Object.values(data.runs)].flatMap((r) => r.actions.map((a) => a[j]));
  const lo = Math.min(...all),
    hi = Math.max(...all),
    span = Math.max(hi - lo, 4);
  const x = (i: number) => PAD + (i / (steps - 1)) * (W - PAD * 2),
    y = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  // Seed band: min/max across the three baseline seeds at each step.
  const band = Array.from({ length: steps }, (_, i) => {
    const v = data.baselines.map((b) => b.actions[i][j]);
    return [Math.min(...v), Math.max(...v)];
  });
  const bandPath =
    band.map(([, mx], i) => `${x(i)},${y(mx)}`).join(' ') +
    ' ' +
    band
      .map(([mn], i) => `${x(i)},${y(mn)}`)
      .reverse()
      .join(' ');
  const run = data.runs[selected];
  const value = run.actions[Math.min(steps - 1, Math.floor(cursor))][j];
  const [bMin, bMax] = band[Math.min(steps - 1, Math.floor(cursor))];
  const out = value < bMin - MARGIN || value > bMax + MARGIN;
  return (
    <div className="joint-chart">
      <div className="joint-head">
        <span>{data.action_labels[j].replace('_', ' ').toUpperCase()}</span>
        <b className={out ? 'out' : ''}>
          {value.toFixed(1)}
          {data.units[j] === '%' ? ' %' : '°'}
        </b>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${data.action_labels[j]} over the predicted chunk`}>
        <polygon points={bandPath} fill="#1d1d1d" />
        {data.baselines.map((b) => (
          <polyline
            key={b.seed}
            points={b.actions.map((a, i) => `${x(i)},${y(a[j])}`).join(' ')}
            fill="none"
            stroke="#5a5a5a"
            strokeWidth="1"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <polyline
          points={run.actions.map((a, i) => `${x(i)},${y(a[j])}`).join(' ')}
          fill="none"
          stroke="#f2f2f2"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={x(data.execute_steps - 1)}
          x2={x(data.execute_steps - 1)}
          y1={PAD}
          y2={H - PAD}
          stroke="#444"
          strokeDasharray="2 4"
          vectorEffect="non-scaling-stroke"
        />
        <line x1={x(cursor)} x2={x(cursor)} y1={PAD} y2={H - PAD} stroke="#9a9a9a" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="joint-axis">
        <span>{lo.toFixed(0)}</span>
        <span>{hi.toFixed(0)}</span>
      </div>
    </div>
  );
}

export default function Flux3Page() {
  const [data, setData] = useState<Data>();
  const [selected, setSelected] = useState('original');
  const [mode, setMode] = useState<'worlds' | 'compare'>('compare');
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    fetch('/flux3/runs.json')
      .then((r) => r.json())
      .then((d) => setData(d as Data))
      .catch(() => setError('The recorded runs could not be loaded.'));
  }, []);
  // Replay the 42-step chunk at its native 30 Hz, then hold for a beat.
  useEffect(() => {
    if (!data) return;
    let raf = 0,
      start = performance.now();
    const steps = data.baselines[0].actions.length;
    const tick = (now: number) => {
      const v = video.current;
      if (v && v.playbackRate !== PLAYBACK) v.playbackRate = PLAYBACK;
      if (v && v.duration) {
        // The H3 render shows the 42-step chunk stretched over its 5 s.
        // Video = H3 render minus its first TRIM s, accelerated ×SPEED; map back to policy steps.
        setCursor(Math.min(steps - 1, ((TRIM + v.currentTime * SPEED) / RENDER_S) * (steps - 1)));
      } else {
        const t = ((now - start) / 1000) * data.action_hz;
        setCursor(Math.max(0, Math.min(steps - 1, t % (steps + 24))));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [data, selected]);
  const finals = useMemo(() => {
    if (!data) return [];
    const last = data.baselines[0].actions.length - 1;
    const run = data.runs[selected].actions[last];
    return data.action_labels.map((label, j) => {
      const seeds = data.baselines.map((b) => b.actions[last][j]);
      const mn = Math.min(...seeds),
        mx = Math.max(...seeds);
      return {
        label,
        value: run[j],
        delta: run[j] - data.baselines[0].actions[last][j],
        out: run[j] < mn - MARGIN || run[j] > mx + MARGIN,
        unit: data.units[j] === '%' ? '%' : '°',
      };
    });
  }, [data, selected]);
  const world = data?.worlds.find((w) => w.id === selected);
  // The selected world drives the arm; seed runs and other worlds stay as faint paths.
  const tracks = useMemo<Track[]>(
    () =>
      data
        ? [
            ...Object.entries(data.runs).map(([id, r]) => ({ id, actions: r.actions, tone: 'world' as const })),
            ...data.baselines
              .filter((b) => b.seed !== 42)
              .map((b) => ({ id: `seed-${b.seed}`, actions: b.actions, tone: 'seed' as const })),
          ]
        : [],
    [data],
  );
  const run = data?.runs[selected];
  return (
    <main className="robot-world flux3">
      <ExperienceNav current="arm" />
      <div className="xp-sub" role="tablist" aria-label="View">
        <button role="tab" aria-selected={mode === 'compare'} className={mode === 'compare' ? 'on' : ''} onClick={() => setMode('compare')}>
          FLUX 3 vs HUMAN
        </button>
        <button role="tab" aria-selected={mode === 'worlds'} className={mode === 'worlds' ? 'on' : ''} onClick={() => setMode('worlds')}>
          4 WORLDS
        </button>
      </div>
      {mode === 'compare' ? (
        <Compare />
      ) : (
      <div className="flux3-workspace">
        <aside className="data-rail flux3-worlds" aria-label="Visual worlds">
          <div className="rail-label">
            SAME ARM STATE<span>4 WORLDS</span>
          </div>
          {data?.worlds.map((w) => (
            <button
              key={w.id}
              className={'world-card ' + (w.id === selected ? 'on' : '')}
              onClick={() => setSelected(w.id)}
              aria-pressed={w.id === selected}
            >
              <span className="world-images">
                <img src={w.scene} alt={`${w.label} scene camera`} />
                <img src={w.wrist} alt={`${w.label} wrist camera`} />
              </span>
              <span className="world-name">{w.label}</span>
            </button>
          ))}
          <p className="flux3-note">Edited images: Nano Banana 2. Arm pose and objects kept.</p>
        </aside>
        <section className="flux3-center" aria-label="Predicted joint trajectories">
          <div className="flux3-title">
            <span>FLUX 3 ACTION · SO-101 · “{data?.prompt}”</span>
            <b>{world?.label}</b>
          </div>
          {data && (
            <div className="flux3-io">
              <div>
                <span>INPUT · SENT TO FLUX 3</span>
                <p>2 images (scene + wrist) · instruction “{data.prompt}”</p>
                <p className="io-state">
                  start angles ·{' '}
                  {data.action_labels.map((l, j) => (
                    <b key={l}>
                      {l.replace('_', ' ')} {data.state[j].toFixed(0)}
                      {data.units[j] === '%' ? '%' : '°'}
                    </b>
                  ))}
                </p>
              </div>
              <i>→</i>
              <div>
                <span>OUTPUT · RETURNED BY FLUX 3</span>
                <p>42 commands × 6 joint angles, 30 per second = 1.4 s of motion</p>
                <p className="io-state">
                  now · step {Math.floor(cursor) + 1} ·{' '}
                  {run &&
                    data.action_labels.map((l, j) => (
                      <b key={l}>
                        {run.actions[Math.min(41, Math.floor(cursor))][j].toFixed(0)}
                        {data.units[j] === '%' ? '%' : '°'}
                      </b>
                    ))}
                </p>
              </div>
            </div>
          )}
          {error && <div className="media-error">{error}</div>}
          <div className="flux3-stage">
            <div className="flux3-arm">
              <span className="stage-tag">3D · SO-101 REPLAYING THE PREDICTED COMMANDS</span>
              {data && <Arm3D start={data.state} tracks={tracks} focus={selected} cursor={cursor} />}
            </div>
            <div className="flux3-video">
              <span className="stage-tag">H3 RENDER · THE SAME MOTION IN THIS WORLD</span>
              <video
                ref={video}
                key={selected}
                src={`/flux3/video/${selected}-h3.mp4`}
                autoPlay
                muted
                loop
                playsInline
              />
              <span className="stage-foot">1.4 s of commands · shown at 0.7× speed</span>
            </div>
            <div className="flux3-inputs">
              <figure>
                <span className="stage-tag">INPUT · SCENE</span>
                {world && <img src={world.scene} alt={`${world.label} scene camera input`} />}
              </figure>
              <figure>
                <span className="stage-tag">INPUT · WRIST</span>
                {world && <img src={world.wrist} alt={`${world.label} wrist camera input`} />}
              </figure>
            </div>
          </div>
          <div className="joint-grid">
            {data &&
              data.action_labels.map((_, j) => (
                <JointChart key={j} j={j} data={data} selected={selected} cursor={cursor} />
              ))}
          </div>
          <div className="final-row">
            <span className="final-title">END OF CHUNK · Δ VS ORIGINAL SEED 42</span>
            {finals.map((f) => (
              <div key={f.label} className={'final ' + (f.out ? 'out' : '')}>
                <span>{f.label.replace('_', ' ').toUpperCase()}</span>
                <b>
                  {f.delta >= 0 ? '+' : ''}
                  {f.delta.toFixed(1)}
                  {f.unit}
                </b>
                <em>{f.out ? 'OUTSIDE SEED SPREAD' : 'within seeds'}</em>
              </div>
            ))}
          </div>
          <div className="flux3-time">
            <span>
              STEP {Math.floor(cursor) + 1} / 42 · {(cursor / (data?.action_hz || 30)).toFixed(2)} s
            </span>
            <span>DASHED LINE = 32 STEPS EXECUTED, THEN A NEW CHUNK</span>
          </div>
        </section>
      </div>
      )}
    </main>
  );
}
