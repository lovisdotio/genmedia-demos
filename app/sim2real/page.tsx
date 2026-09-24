'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Expand, MousePointer2, Pause, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import WorldlineScene, { Phase, TrackId } from './scene';
import { DataCurve } from '../shared/data-curve';
import {
  ActionId,
  ACTIONS,
  BLOCK_DETOUR,
  consequences3,
  DURATION,
  FPS,
  isLeaf3,
  Leaf3Id,
  leaf3Of,
  LeafId,
  OPTIONS,
  rank,
  rank3,
  SAFETY_BUFFER,
  SIDES,
  SIGN_BUFFER,
  simulate,
  simulate2,
  splitLeaf,
  splitLeaf3,
} from './sim';
import ExperienceNav from '../experience-nav';
import '../shared/world.css';
import './sim2real.css';

type Box = [number, number, number, number] | null;
type Fidelity = {
  threshold_iou: number;
  clips: Record<
    string,
    Record<
      'pedestrian' | 'robot',
      {
        request_id: string;
        match_rate: number;
        median_iou: number;
        median_dx: number;
        median_height_ratio: number;
        measured: Box[];
        per_frame: ({ iou: number } | null)[];
      }
    >
  >;
};
type Truth = { frames: { t: number; robot: Box; pedestrian: Box }[] };
type Step = { id: string; phase: Phase; leaf?: TrackId; duration: number; title: string; kicker: string };

// 15 s H3 Max reference-to-video renders shown per leaf (work/generations/requests-15s.json).
// Segment-2 leaves start from their parent's last H3 frame.
const H3_REQUESTS: Partial<Record<TrackId, string>> = {
  'continue-left': '01a0d14f-7408-7941-87b5-7e5ac89ca9ba',
  'continue-right': '01a0d153-afee-7be1-984f-7874ab0ad49b',
  'slow-left': '01a0d16a-f067-7922-9869-4a533a6872c5',
  'slow-right': '01a0d16a-efbe-7ad0-9e4f-33c9158d6002',
  'stop-left': '01a0d16a-f26c-77c2-898c-957f0b0bc660',
  'stop-right': '01a0d16a-f359-79d0-bdb9-ee5034efd8a0',
  'slow-right-wait': '01a0d17f-5c3e-7982-847a-9b5b49d6d83a',
  'slow-right-turn': '01a0d177-4126-74c2-a7e0-e532c6f06f26',
  'slow-left-wait': '01a0d177-41e1-75d1-967d-fc819890bc6b',
  'slow-left-straight': '01a0d177-42c5-79e2-a1a0-47a483ed8dc4',
};
const RENDERED = Object.keys(H3_REQUESTS) as TrackId[];
const LEAVES = ACTIONS.flatMap((a) => SIDES.map((sd) => `${a.id}-${sd.id}` as LeafId));
const LEAVES3 = SIDES.flatMap((sd) => OPTIONS.map((o) => leaf3Of(sd.id, o.id)));
const t0Of = (id: TrackId) => (isLeaf3(id) ? DURATION : 0);
const samplesOf = (id: TrackId) => (isLeaf3(id) ? simulate2(id) : simulate(id));
const PASS_RATE = 0.7;
const riskOf = (clearance: number) =>
  clearance < 0.5
    ? { level: 'high', label: 'CONTACT RISK' }
    : clearance < SAFETY_BUFFER
      ? { level: 'mid', label: 'TOO CLOSE' }
      : { level: 'low', label: 'CLEAR' };
const planner = rank();
const planner3 = rank3(planner.side);
const plannerPath = leaf3Of(planner.side, planner3.selected);
// A picked branch plays as a whole path: a slow leaf continues through the junction with the planner's rule there.
const pathOf = (id: TrackId): TrackId[] => {
  if (isLeaf3(id)) return [splitLeaf3(id).parent, id];
  const [a, sd] = splitLeaf(id);
  const next = a === 'slow' ? leaf3Of(sd, rank3(sd).selected) : undefined;
  return next && (Object.keys(H3_REQUESTS) as string[]).includes(next) ? [id, next] : [id];
};
const byAction = Object.fromEntries(planner.all.map((c) => [c.id, c])) as Record<ActionId, (typeof planner.all)[0]>;
const actionMeta = (id: ActionId) => ACTIONS.find((a) => a.id === id)!;
const time = (s: number) =>
  `${Math.floor(s / 60).toString().padStart(2, '0')}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

const STEPS: Step[] = [
  { id: 'present', phase: 'present', duration: 1.5, kicker: 'ONE SIMULATED STATE', title: 'A pedestrian ahead, a no-entry sign, then a junction.' },
  { id: 'decision', phase: 'decision', duration: 2 * DURATION, kicker: 'THREE DECISIONS → PLANNER PATH · 30 s', title: 'Slow down, swerve right, wait for the cyclist.' },
  { id: 'continue-right', phase: 'clip', leaf: 'continue-right', duration: DURATION, kicker: 'DECISION 1 / REJECTED', title: 'Continue: 0.31 m from the pedestrian.' },
  { id: 'slow-left', phase: 'clip', leaf: 'slow-left', duration: DURATION, kicker: 'DECISION 2 / REJECTED', title: 'Swerve left: 4 s in the oncoming lane.' },
  { id: 'slow-right-turn', phase: 'clip', leaf: 'slow-right-turn', duration: DURATION, kicker: 'DECISION 3 / SAFE BUT LONGER', title: `Turn right: clear of the cyclist, +${BLOCK_DETOUR} m around the block.` },
  { id: 'slow-left-straight', phase: 'clip', leaf: 'slow-left-straight', duration: DURATION, kicker: 'DECISION 3 / REJECTED', title: 'Straight on: into the cyclist’s path.' },
  { id: 'overview', phase: 'overview', duration: 8, kicker: '3 LEVELS · 12 LEAVES', title: `Twelve futures from one state, ${RENDERED.length} rendered.` },
];
// Videos a step plays back to back: the planner path is segment 1 then segment 2.
const playlistOf = (st: Step): TrackId[] => (st.leaf ? [st.leaf] : st.phase === 'decision' ? [planner.leaf, plannerPath] : []);

function Clearances({ t, active }: { t: number; active?: TrackId }) {
  // All three simulated clearance curves of the current decision on one axis, with the safety buffer.
  const seg2 = !!active && isLeaf3(active);
  const t0 = seg2 ? DURATION : 0;
  const max = 6,
    y = (v: number) => 88 - (Math.min(max, Math.max(0, v)) / max) * 76,
    x = (s: number) => ((s - t0) / DURATION) * 320;
  const now = active ? samplesOf(active)[Math.min(DURATION * FPS, Math.round((t - t0) * FPS))] : undefined;
  const curves = seg2
    ? OPTIONS.map((o) => {
        const id = leaf3Of(splitLeaf3(active as Leaf3Id).side, o.id);
        return { key: o.id, on: id === active, dashed: o.id === 'straight', pts: simulate2(id).filter((p) => p.cyclistOnRoad).map((p) => [p.t, p.cyclistClearance]) };
      })
    : ACTIONS.map((a) => ({
        key: a.id,
        on: !!active && splitLeaf(active as LeafId)[0] === a.id,
        dashed: a.id === 'continue',
        pts: simulate(a.id).filter((p) => p.pedOnRoad).map((p) => [p.t, p.clearance]),
      }));
  return (
    <div className="trace">
      <div className="trace-title">
        <span>MIN DISTANCE ROBOT ↔ {seg2 ? 'CYCLIST' : 'PEDESTRIAN'}</span>
        <b>
          {now ? (seg2 ? now.cyclistClearance : now.clearance).toFixed(2) : '—'} <small>m</small>
        </b>
      </div>
      <svg viewBox="0 0 320 100" role="img" aria-label="Simulated clearance over time for the options of the current decision">
        {[1, 3, 5].map((v) => (
          <line key={v} x1="0" x2="320" y1={y(v)} y2={y(v)} stroke="#292929" strokeDasharray="2 5" />
        ))}
        <line x1="0" x2="320" y1={y(SAFETY_BUFFER)} y2={y(SAFETY_BUFFER)} stroke="#9a9a9a" strokeDasharray="5 3" strokeWidth=".7" />
        <text x="318" y={y(SAFETY_BUFFER) - 3} fill="#8a8a8a" fontSize="7" textAnchor="end">
          1.0 m BUFFER
        </text>
        {curves.map((c) => (
          <polyline
            key={c.key}
            points={c.pts.map(([pt, v]) => `${x(pt)},${y(v)}`).join(' ')}
            fill="none"
            stroke={c.on ? '#f2f2f2' : '#5b5b5b'}
            strokeWidth={c.on ? 1.4 : 0.8}
            strokeDasharray={c.dashed ? '3 2' : undefined}
          />
        ))}
        <line x1={x(t)} x2={x(t)} y1="8" y2="92" stroke="#888" strokeWidth=".5" />
      </svg>
      <div className="trace-scale">
        <span>{t0} s</span>
        <span>SIMULATOR · {t0 + DURATION} s</span>
      </div>
    </div>
  );
}

export default function Sim2RealPage() {
  const [index, setIndex] = useState(0),
    [elapsed, setElapsed] = useState(0),
    [running, setRunning] = useState(true),
    [follow, setFollow] = useState(true),
    [ready, setReady] = useState(false),
    [atlases, setAtlases] = useState({ loaded: 0, total: 6 }),
    [dataLoaded, setDataLoaded] = useState(0),
    [videosLoaded, setVideosLoaded] = useState(0),
    [fidelity, setFidelity] = useState<Fidelity>(),
    [truth, setTruth] = useState<Record<string, Truth>>({}),
    [seg, setSeg] = useState(0),
    [world, setWorld] = useState<'day' | 'snow'>('day'),
    // A branch picked by hand from the decision panel; it plays on the same clock.
    [pick, setPick] = useState<LeafId | null>(null),
    [cover, setCover] = useState(''),
    [coverFade, setCoverFade] = useState(false);
  const reversing = useRef(false);
  const holdStart = useRef(0);
  // Moment to resume at when a clip is swapped mid-play (branch or world change).
  const resumeAt = useRef<number | null>(null);
  const h3 = useRef<HTMLVideoElement>(null),
    elapsedRef = useRef(0),
    blobs = useRef(new Map<string, string>());
  // Preloaded videos play from memory; anything else streams from its URL.
  const videoSrc = (url: string) => blobs.current.get(url) || url;
  // Leaves also rendered in snow (same 3D motion, snowy first frame).
  // Every rendered clip has a snow version (same 3D reference, Nano Banana snow first frame).
  const SNOW: string[] = RENDERED;
  const clipUrl = (id: string) => (world === 'snow' && SNOW.includes(id) ? `/sim2real/${id}-snow-h3.mp4` : `/sim2real/${id}-h3.mp4`);
  const step = STEPS[index];
  const leaf = step.leaf;
  const playlist: TrackId[] = pick ? pathOf(pick) : playlistOf(step);
  // What the panel shows: the clip playing now (the planner path plays two in a row).
  const shown: TrackId | undefined = playlist[Math.min(seg, playlist.length - 1)];
  const shownKey = shown || '';
  const seg2 = !!shown && isLeaf3(shown);
  const t0 = shown ? t0Of(shown) : 0;
  const action: ActionId | undefined = shown ? (seg2 ? 'slow' : splitLeaf(shown as LeafId)[0]) : undefined;
  // Clips and the decision preview both run on a video clock.
  const playing = step.phase === 'clip' || step.phase === 'decision' || !!pick;
  const FIRST_VIDEOS = 2,
    DATA_FILES = 1 + RENDERED.length;
  const loadTotal = atlases.total + DATA_FILES + FIRST_VIDEOS,
    loadDone = Math.min(atlases.loaded, atlases.total) + dataLoaded + videosLoaded;
  const loaded = ready && dataLoaded === DATA_FILES && videosLoaded === FIRST_VIDEOS;
  const t = playing ? t0 + Math.min(DURATION, elapsed) : 0;
  const frame = Math.min(DURATION * FPS - 1, Math.round((t - t0) * FPS));
  const sample = samplesOf(shown || planner.leaf)[frame];
  const fid = shown ? fidelity?.clips[shownKey] : undefined;
  const branch = action ? byAction[action] : undefined;
  const branch3 = seg2 ? consequences3(shown as Leaf3Id) : undefined;
  const riskNow = seg2
    ? sample.cyclistOnRoad
      ? riskOf(sample.cyclistClearance)
      : { level: 'low', label: 'CLEAR' }
    : sample.pedOnRoad
      ? riskOf(sample.clearance)
      : { level: 'low', label: 'CLEAR' };
  // PASS needs both SAM tracks ≥ 70 %; a clip whose person track could not be measured stays open.
  const verified = (key: string) => {
    const c = fidelity?.clips[key];
    return c?.pedestrian ? c.pedestrian.match_rate >= PASS_RATE && (!c.robot || c.robot.match_rate >= PASS_RATE) : undefined;
  };
  const checkLabel = (key: string) => {
    if (!RENDERED.includes(key as TrackId)) return 'NOT RENDERED';
    const c = fidelity?.clips[key];
    if (!c) return '—';
    if (!c.pedestrian) return c.robot ? 'ROBOT ONLY' : '—';
    return verified(key) ? 'PASS' : 'DRIFT';
  };
  const total = STEPS.reduce((a, s) => a + s.duration, 0),
    tourTime = STEPS.slice(0, index).reduce((a, s) => a + s.duration, 0) + seg * DURATION + elapsed;
  const eventPhase = step.phase === 'present' ? 0 : step.phase === 'decision' ? Math.min(2, 1 + Math.floor(elapsed / 2.5)) : elapsed < 1 ? 2 : 3;

  useEffect(() => {
    const jump = Number(new URLSearchParams(location.search).get('step'));
    const start = jump > 0 && jump <= STEPS.length ? jump - 1 : 0;
    if (start) setIndex(start);
    // Hold the tour until the first two videos are fully in memory.
    const urls: string[] = [];
    for (let k = 0; k < STEPS.length && urls.length < FIRST_VIDEOS; k++)
      for (const id of playlistOf(STEPS[(start + k) % STEPS.length])) if (urls.length < FIRST_VIDEOS) urls.push(`/sim2real/${id}-h3.mp4`);
    urls.forEach((url) =>
      fetch(url)
        .then((r) => r.blob())
        .then((b) => blobs.current.set(url, URL.createObjectURL(b)))
        .catch(() => {})
        .finally(() => setVideosLoaded((n) => n + 1)),
    );
  }, []);
  useEffect(() => {
    // Snow versions load in the background once the page is ready, so the DAY/SNOW switch is instant.
    if (!loaded) return;
    for (const url of ['slow-right-snow', 'slow-left-snow', 'slow-left', 'continue-right'].map((n) => `/sim2real/${n}-h3.mp4`)) {
      fetch(url)
        .then((r) => r.blob())
        .then((b) => blobs.current.set(url, URL.createObjectURL(b)))
        .catch(() => {});
    }
  }, [loaded]);
  // Both worlds of the clips being played stay preloaded, so DAY/SNOW switches on any path are instant.
  const requested = useRef(new Set<string>());
  useEffect(() => {
    if (!loaded) return;
    for (const id of playlist)
      for (const url of [`/sim2real/${id}-h3.mp4`, ...(SNOW.includes(id) ? [`/sim2real/${id}-snow-h3.mp4`] : [])]) {
        if (blobs.current.has(url) || requested.current.has(url)) continue;
        requested.current.add(url);
        fetch(url)
          .then((r) => r.blob())
          .then((b) => blobs.current.set(url, URL.createObjectURL(b)))
          .catch(() => {});
      }
  }, [loaded, playlist.join()]);
  useEffect(() => {
    Promise.all([
      fetch('/sim2real/fidelity.json').then((r) => r.json()),
      ...RENDERED.map((l) => fetch(`/sim2real/${l}-gt.json`).then((r) => r.json())),
    ].map((pr) => pr.then((v) => (setDataLoaded((n) => n + 1), v))))
      .then(([f, ...gts]) => {
        setFidelity(f as Fidelity);
        setTruth(Object.fromEntries(RENDERED.map((l, i) => [l, gts[i] as Truth])));
      })
      .catch(() => {});
  }, []);

  // One content clock: the H3 video during clips, a timer otherwise.
  useEffect(() => {
    let raf = 0,
      last = performance.now(),
      report = last;
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.12);
      last = now;
      if (running && loaded) {
        const v = h3.current;
        if (playing && v && reversing.current) {
          // Hold-to-rewind: scrub the clip backwards; the 3D follows the same clock.
          if (resumeAt.current === null) {
            // The 3D follows a smooth clock; the video seeks to it whenever the previous seek is done.
            v.pause();
            elapsedRef.current = Math.max(0, elapsedRef.current - dt * Math.min(9, 3 + ((now - holdStart.current) / 1000) * 1.5));
            if (!v.seeking && Math.abs(v.currentTime - elapsedRef.current) > 0.01) v.currentTime = elapsedRef.current;
            if (elapsedRef.current <= 0 && !v.seeking && v.readyState >= 2 && seg > 0) {
              // Keep rewinding into the previous segment of the path.
              snap();
              resumeAt.current = elapsedRef.current = DURATION - 0.2;
              setElapsed(elapsedRef.current);
              setSeg(seg - 1);
            }
          }
        } else if (playing && resumeAt.current === null) elapsedRef.current = v?.currentTime || 0;
        else elapsedRef.current = Math.min(step.duration, elapsedRef.current + dt);
        if (!playing && elapsedRef.current >= step.duration) next();
      }
      if (now - report > 60) {
        setElapsed(elapsedRef.current);
        report = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
  const next = () => {
    setPick(null);
    elapsedRef.current = 0;
    setElapsed(0);
    setSeg(0);
    setIndex((i) => (i + 1) % STEPS.length);
  };
  // End of a clip: the next clip of the playlist, or the next step.
  const ended = () => {
    if (seg < playlist.length - 1) {
      elapsedRef.current = 0;
      setElapsed(0);
      setSeg((k) => k + 1);
    } else if (!pick) next();
  };
  useEffect(() => {
    for (const v of [h3.current]) {
      if (!v) continue;
      if (running && playing && loaded) void v.play().catch(() => {});
      else v.pause();
    }
  }, [running, index, seg, playing, loaded, pick, world]);
  useEffect(() => {
    // Warm the cache: the rest of this step's playlist and the next step's clips.
    for (const id of [...playlist.slice(1), ...playlistOf(STEPS[(index + 1) % STEPS.length])]) fetch(`/sim2real/${id}-h3.mp4`).catch(() => {});
  }, [index]);
  // Jump between steps, or scrub back a few seconds (the 3D follows the video clock).
  const goStep = (d: number) => {
    setPick(null);
    elapsedRef.current = 0;
    setElapsed(0);
    setSeg(0);
    setIndex((i) => (i + d + STEPS.length) % STEPS.length);
  };
  const rewind = (s: number) => {
    const v = h3.current;
    if (!v) return;
    v.currentTime = Math.max(0, v.currentTime - s);
    elapsedRef.current = v.currentTime;
    setElapsed(v.currentTime);
  };
  // Freeze the current frame over the panel while the next clip loads: no flash between clips.
  // Dissolve the frozen frame into the new clip once it is on the right moment (day ↔ snow, branch changes).
  const fadeTimer = useRef(0);
  const reveal = () => {
    setCoverFade(true);
    clearTimeout(fadeTimer.current);
    fadeTimer.current = window.setTimeout(() => {
      setCover('');
      setCoverFade(false);
    }, 900);
  };
  const snap = () => {
    const v = h3.current;
    if (!v || v.readyState < 2) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth || 1280;
    c.height = v.videoHeight || 720;
    c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
    try {
      setCoverFade(false);
      setCover(c.toDataURL('image/jpeg', 0.9));
    } catch {}
  };
  // A clip must be in memory before switching to it mid-play: the dev server does not serve byte ranges,
  // so seeking into a streamed file would restart it from 0. The frozen frame covers the short load.
  const ensure = (url: string) =>
    blobs.current.has(url)
      ? Promise.resolve()
      : fetch(url)
          .then((r) => r.blob())
          .then((b) => void blobs.current.set(url, URL.createObjectURL(b)))
          .catch(() => {});
  const urlIn = (id: TrackId, w: 'day' | 'snow') => (w === 'snow' && SNOW.includes(id) ? `/sim2real/${id}-snow-h3.mp4` : `/sim2real/${id}-h3.mp4`);
  const pickBranch = (id: LeafId) => {
    if (!RENDERED.includes(id as TrackId) || id === shown) return;
    // Back on the planner's own choice during the decision step: rejoin the 30 s planner path.
    const target = step.phase === 'decision' && id === planner.leaf ? null : id;
    snap();
    void ensure(urlIn(target ? pathOf(target)[0] : playlistOf(step)[0], world)).then(() => {
      resumeAt.current = elapsedRef.current;
      setSeg(0);
      setPick(target);
    });
  };
  const switchWorld = (w: 'day' | 'snow') => {
    if (w === world || !shown) return;
    snap();
    void ensure(urlIn(shown, w)).then(() => {
      resumeAt.current = elapsedRef.current;
      setWorld(w);
    });
  };
  const restart = () => {
    setPick(null);
    elapsedRef.current = 0;
    setElapsed(0);
    setSeg(0);
    setIndex(0);
    setRunning(true);
    setFollow(true);
  };

  const gt = shown ? truth[shown]?.frames[frame] : undefined;
  const measured = fid
    ? { robot: fid.robot?.measured[frame] ?? null, pedestrian: fid.pedestrian?.measured[frame] ?? null }
    : undefined;
  const frameIou = fid?.pedestrian?.per_frame[frame]?.iou;
  const drawBox = (b: Box, kind: 'truth' | 'measured', name: string) =>
    b && (
      <div
        key={kind + name}
        className={'gt-box ' + kind}
        style={{ left: `${b[0] * 100}%`, top: `${b[1] * 100}%`, width: `${(b[2] - b[0]) * 100}%`, height: `${(b[3] - b[1]) * 100}%` }}
      >
        <span>{kind === 'truth' ? `SIM ${name}` : `SAM ${name}`}</span>
      </div>
    );
  const series = useMemo(() => {
    const id = shown || planner.leaf;
    const s = samplesOf(id);
    return {
      speed: s.map((x) => x.robot.speed),
      progress: s.map((x) => -x.robot.z),
      iou: fidelity?.clips[id]?.pedestrian?.per_frame.map((x) => (x ? x.iou * 100 : 0)) || [],
    };
  }, [shown, fidelity]);

  return (
    <main className="robot-world sim2real" data-step={step.id} data-running={running}>
      <ExperienceNav current="robot" />
      <div className="world-workspace">
        <aside className="data-rail left-rail" aria-label="Pedestrian risk and simulated state">
          <div className="rail-label">
            {seg2 ? 'CYCLIST' : 'PEDESTRIAN'} / RISK<span>{shown ? shown.replaceAll('-', ' · ').toUpperCase() : 'SHARED'}</span>
          </div>
          <div className={'risk-card risk-' + riskNow.level}>
            <span>NOW</span>
            <b>{riskNow.label}</b>
            <em>
              {seg2
                ? sample.cyclistOnRoad
                  ? sample.cyclistClearance.toFixed(2) + ' m'
                  : 'cyclist off the junction'
                : sample.pedOnRoad
                  ? sample.clearance.toFixed(2) + ' m'
                  : 'pedestrian off road'}
            </em>
          </div>
          {branch3 ? (
            <div className={'risk-card risk-' + riskOf(branch3.minCyclist).level}>
              <span>WORST MOMENT</span>
              <b>{riskOf(branch3.minCyclist).label}</b>
              <em>
                {branch3.minCyclist.toFixed(2)} m at {branch3.minCyclistAt.toFixed(1)} s
              </em>
            </div>
          ) : (
            branch && (
            <div className={'risk-card risk-' + riskOf(branch.minClearance).level}>
              <span>WORST MOMENT</span>
              <b>{riskOf(branch.minClearance).label}</b>
              <em>
                {branch.minClearance.toFixed(2)} m at {branch.minClearanceAt.toFixed(1)} s
              </em>
            </div>
            )
          )}
          <div className="metric">
            <span>SIGN.CLEARANCE</span>
            <b className={sample.signClearance < SIGN_BUFFER ? 'alert' : ''}>{sample.signClearance.toFixed(2)} m</b>
          </div>
          <div className="metric">
            <span>LANE</span>
            <b className={sample.inOncomingLane ? 'alert' : ''}>{sample.inOncomingLane ? 'ONCOMING' : 'OWN'}</b>
          </div>
          <div className="metric">
            <span>ROBOT.SPEED</span>
            <b>{sample.robot.speed.toFixed(2)} m/s</b>
          </div>
          <div className="metric">
            <span>SIM.TIME</span>
            <b>{sample.t.toFixed(1)} s</b>
          </div>
          <div className="rail-chart">
            <DataCurve label="ROBOT SPEED" source="SIM" unit="m/s" time={t - t0} duration={DURATION} values={series.speed} />
          </div>
          <div className="rail-chart">
            <DataCurve label="RENDER MATCH" source="SAM 3" unit="%" time={t - t0} duration={DURATION} values={series.iou} />
          </div>
        </aside>
        <section className="world-center" aria-label="Automatic scenario tour">
          <div className="world-stage">
            <WorldlineScene
              phase={pick ? 'clip' : step.phase}
              active={pick ? shown : leaf}
              selected={plannerPath}
              rendered={RENDERED}
              time={t}
              speed={running ? 1 : 0}
              follow={follow}
              onManual={() => setFollow(false)}
              onReady={() => setReady(true)}
              onProgress={(done, total) => setAtlases({ loaded: done, total })}
            />
            <div className="stage-label">
              <span>{step.kicker}</span>
              <h1>{step.title}</h1>
              <small>{follow ? 'CAMERA / GUIDED FLIGHT' : 'CAMERA / FREE ORBIT'}</small>
            </div>
            <div className="stage-path">DECISION TREE → 3 CONTROLS AT THE CROSSING × 2 SIDES AT THE SIGN × 3 OPTIONS AT THE JUNCTION (SLOW BRANCH, 15 → 30 s)</div>
            <div className="result-window">
              <div className="result-top">
                <span>
                  {step.phase === 'decision' ? `H3 · PLANNER PATH ${seg + 1}/2` : seg2 ? 'H3 · 15 → 30 s' : 'H3 · 0 → 15 s'}
                  {shown && world === 'snow' && (SNOW.includes(shown) ? ' · SNOW' : ' · SNOW N/A')}
                </span>
                <span>
                  {shown
                    ? verified(shownKey) === undefined
                      ? 'VERIFYING…'
                      : verified(shownKey)
                        ? 'VERIFIED'
                        : 'REJECTED · DRIFT'
                    : 'CHASE CAMERA'}
                </span>
              </div>
              <div className="robot-video-shell sim2real-shell">
                {shown ? (
                  // One clip at a time; segment 2 starts on segment 1's last frame, so the path plays without a cut.
                  <video
                    ref={h3}
                    key={`h3-${index}-${seg}-${world}-${pick || ''}`}
                    className="h3-video"
                    src={videoSrc(clipUrl(shown))}
                    // Switching world keeps the moment: resume where the previous video was.
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget,
                        t = resumeAt.current ?? elapsedRef.current;
                      if (t >= v.duration - 0.1 && !pick && !reversing.current) {
                        // Resumed at the very end of a clip: go straight on to the next one.
                        resumeAt.current = null;
                        ended();
                        return;
                      }
                      if (t > 0.1) v.currentTime = Math.min(t, v.duration - 0.05);
                      else resumeAt.current = null;
                      if (running && playing) void v.play().catch(() => {});
                    }}
                    onSeeked={() => {
                      resumeAt.current = null;
                      reveal();
                    }}
                    onPlaying={() => resumeAt.current === null && reveal()}
                    poster={world === 'snow' && SNOW.includes(shown) ? `/sim2real/${shown}-snow-poster.jpg` : `/sim2real/${shown}-poster.jpg`}
                    muted
                    playsInline
                    preload="auto"
                    onEnded={ended}
                  />
                ) : (
                  <img src={`/sim2real/${planner.leaf}-poster.jpg`} alt="The shared starting frame rendered by H3" />
                )}
                {cover && <img className={'clip-cover' + (coverFade ? ' fading' : '')} src={cover} alt="" aria-hidden="true" />}
                {shown && (
                  <div className="box-layer" aria-hidden="true">
                    {drawBox(gt?.pedestrian || null, 'truth', seg2 ? 'CYCLIST' : 'PED')}
                    {drawBox(gt?.robot || null, 'truth', 'ROBOT')}
                    {drawBox(measured?.pedestrian || null, 'measured', seg2 ? 'CYCLIST' : 'PED')}
                    {drawBox(measured?.robot || null, 'measured', 'ROBOT')}
                  </div>
                )}
              </div>
              <div className="result-caption">
                <span>
                  {t.toFixed(2)} / {(t0 + DURATION).toFixed(2)}s
                </span>
                <div>
                  <i style={{ width: `${((t - t0) / DURATION) * 100}%` }} />
                </div>
                <span>F{frame.toString().padStart(3, '0')}</span>
              </div>
              <div className="result-observation">
                <span>RENDER CHECK</span>
                <p>
                  {!shown
                    ? 'One state. Three decisions. Twelve possible futures.'
                    : verified(shownKey) === false
                      ? 'The render drifts from the simulated path. Rejected.'
                      : verified(shownKey)
                        ? `Robot and ${seg2 ? 'cyclist' : 'pedestrian'} match the simulation.`
                        : checkLabel(shownKey) === 'ROBOT ONLY'
                          ? 'Robot matches; the person track was not measured.'
                          : 'Verification pending.'}
                </p>
              </div>
            </div>
            <div className="stage-bottom">
              <span>SIM → RENDER → VERIFY</span>
              <span>DRAG TO ORBIT · SCROLL TO ZOOM</span>
            </div>
          </div>
          <div className="world-analysis">
            <section className="analysis-cell">
              <div className="analysis-title">
                TIME / SERIES<span>SIMULATED</span>
              </div>
              <Clearances t={t} active={shown} />
            </section>
            <section className="analysis-cell decision-trace">
              <div className="analysis-title">
                PIPELINE / TRACE<span>{step.phase === 'present' ? 'READY' : 'RECORDED'}</span>
              </div>
              <p className="objective">
                1 · ≥ {SAFETY_BUFFER.toFixed(1)} m from the pedestrian, then fastest. 2 · Sign in own lane if ≥ {SIGN_BUFFER.toFixed(1)} m clear. 3 · ≥{' '}
                {SAFETY_BUFFER.toFixed(1)} m from the cyclist, then shortest route.
              </p>
              <div className="decision-chain">
                <span className={eventPhase >= 1 ? 'lit' : ''}>01 SIMULATE</span>
                <i>→</i>
                <span className={eventPhase >= 2 ? 'lit' : ''}>02 RANK</span>
                <i>→</i>
                <span className={eventPhase >= 3 ? 'lit' : ''}>03 H3 RENDER</span>
                <i>→</i>
                <span className={eventPhase >= 3 && elapsed > 2 ? 'lit' : ''}>04 VERIFY</span>
              </div>
            </section>
            <section className="analysis-cell event-ledger">
              <div className="analysis-title">
                EVENT / LEDGER<span>REPLAY</span>
              </div>
              {[
                ['SIM.STATE', 'crossing · pedestrian scripted'],
                ['PLANNER.RANK', `${planner.selected} → ${planner.side} → ${planner3.selected}`],
                ['H3.REF2V · 15 s', shown ? (H3_REQUESTS[shown] || 'not rendered').slice(-12) : `${RENDERED.length} renders`],
                ['SAM3.VERIFY', shown && fid?.pedestrian ? `ped ${(fid.pedestrian.match_rate * 100).toFixed(0)}%` + (fid.robot ? ` · robot ${(fid.robot.match_rate * 100).toFixed(0)}%` : '') : 'pending'],
              ].map(([label, value], i) => (
                <div className={'event-row ' + (i <= eventPhase ? 'received' : '')} key={label}>
                  <time>{time(tourTime)}</time>
                  <span>
                    {label}
                    <small>{value}</small>
                  </span>
                  <b>{i <= eventPhase ? 'ok' : '·'}</b>
                </div>
              ))}
            </section>
          </div>
        </section>
        <aside className="data-rail right-rail" aria-label="Candidates, planner decision and verification">
          <div className="rail-label">
            DECISION 1 · CROSSING<span>03</span>
          </div>
          <div className="candidate-list">
            {planner.ranking.map((c) => (
              <div
                key={c.id}
                className={
                  'candidate pickable ' + (step.phase !== 'present' && c.id === planner.selected ? 'chosen ' : '') + (c.id === action ? 'viewing' : '')
                }
                onClick={() => pickBranch(`${c.id}-${shown && !isLeaf3(shown) ? splitLeaf(shown as LeafId)[1] : planner.side}` as LeafId)}
              >
                <span>
                  {actionMeta(c.id).short}
                  <em>{c.conflict ? 'BLOCKED' : c.id === planner.selected ? 'CHOSEN' : 'SAFE'}</em>
                </span>
                <dl>
                  <dt>CLOSEST</dt>
                  <dd className={c.conflict ? 'alert' : ''}>{c.minClearance.toFixed(2)} m</dd>
                  <dt>DISTANCE</dt>
                  <dd>{c.progress.toFixed(1)} m</dd>
                </dl>
              </div>
            ))}
          </div>
          <div className="rail-label section-gap">
            DECISION 2 · NO-ENTRY SIGN<span>02</span>
          </div>
          <div className="candidate-list">
            {planner.sides.map((c) => {
              const sd = splitLeaf(c.leaf)[1];
              const chosen = step.phase !== 'present' && sd === planner.side;
              return (
                <div
                  key={c.leaf}
                  onClick={() => pickBranch(`${action && !seg2 ? action : planner.selected}-${sd}` as LeafId)}
                  className={'candidate pickable ' + (chosen ? 'chosen ' : '') + (shown && (isLeaf3(shown) ? splitLeaf3(shown).side : splitLeaf(shown)[1]) === sd ? 'viewing' : '')}>
                  <span>
                    {SIDES.find((x) => x.id === sd)!.short}
                    <em>{sd === planner.side ? 'CHOSEN' : c.oncoming > 0 ? 'ONCOMING LANE' : 'SAFE'}</em>
                  </span>
                  <dl>
                    <dt>SIGN CLEAR</dt>
                    <dd>{c.signClearance.toFixed(2)} m</dd>
                    <dt>ONCOMING</dt>
                    <dd className={c.oncoming > 0 ? 'alert' : ''}>{c.oncoming.toFixed(1)} s</dd>
                  </dl>
                </div>
              );
            })}
          </div>
          <div className="rail-label section-gap">
            DECISION 3 · JUNCTION + CYCLIST<span>03</span>
          </div>
          <div className="candidate-list">
            {planner3.all.map((c) => {
              const chosen = step.phase !== 'present' && c.option === planner3.selected;
              return (
                <div key={c.option} className={'candidate ' + (chosen ? 'chosen ' : '') + (seg2 && splitLeaf3(shown as Leaf3Id).option === c.option ? 'viewing' : '')}>
                  <span>
                    {OPTIONS.find((o) => o.id === c.option)!.short}
                    <em>{c.conflict ? 'BLOCKED' : c.option === planner3.selected ? 'CHOSEN' : 'SAFE'}</em>
                  </span>
                  <dl>
                    <dt>CYCLIST</dt>
                    <dd className={c.conflict ? 'alert' : ''}>{c.minCyclist.toFixed(2)} m</dd>
                    <dt>ROUTE LEFT</dt>
                    <dd>{c.remaining.toFixed(0)} m</dd>
                  </dl>
                </div>
              );
            })}
          </div>
          <div className="rail-label section-gap">
            RENDER CHECK<span>SAM 3</span>
          </div>
          {[...LEAVES, ...LEAVES3].map((key) => {
            const f = fidelity?.clips[key]?.pedestrian;
            const name = isLeaf3(key)
              ? `${splitLeaf3(key).side[0].toUpperCase()} · ${OPTIONS.find((o) => o.id === splitLeaf3(key).option)!.short.split(' ')[0]}`
              : `${actionMeta(splitLeaf(key)[0]).short.split(' ')[0]} · ${splitLeaf(key)[1].toUpperCase()}`;
            return (
              <div className={'preference ' + (key === shownKey ? 'preferred' : '')} key={key}>
                <div>
                  <span>{name}</span>
                  <b>{checkLabel(key)}</b>
                </div>
                <div className="preference-track">
                  <i style={{ width: f ? `${f.match_rate * 100}%` : '0%' }} />
                  <u style={{ left: `${PASS_RATE * 100}%` }} />
                </div>
              </div>
            );
          })}
          <div className="right-bottom">
            <a href="/sim2real/fidelity.json" target="_blank" rel="noreferrer">
              Verification data ↗
            </a>
          </div>
        </aside>
      </div>
      <footer className="world-transport">
        <Button className="robot-tour" onClick={() => setRunning((v) => !v)}>
          {running ? <Pause size={13} /> : <Play size={13} />} {running ? 'PAUSE TOUR' : 'RESUME TOUR'}
        </Button>
        <Button variant="ghost" aria-label="Restart tour" onClick={restart}>
          <RotateCcw size={13} />
        </Button>
        <Button variant="ghost" className="step-prev" aria-label="Previous step" onClick={() => goStep(-1)}>
          ◀ STEP
        </Button>
        <Button
          variant="ghost"
          className="rewind"
          aria-label="Hold to rewind"
          disabled={!playing}
          onPointerDown={() => {
            reversing.current = true;
            holdStart.current = performance.now();
          }}
          onPointerUp={() => {
            reversing.current = false;
            if (running) void h3.current?.play().catch(() => {});
          }}
          onPointerLeave={() => {
            if (!reversing.current) return;
            reversing.current = false;
            if (running) void h3.current?.play().catch(() => {});
          }}
        >
          ⟲ HOLD
        </Button>
        <Button variant="ghost" className="step-next" aria-label="Next step" onClick={() => goStep(1)}>
          STEP ▶
        </Button>
        <div className="world-switch" role="group" aria-label="World">
          {(['day', 'snow'] as const).map((w) => (
            <button key={w} className={world === w ? 'on' : ''} onClick={() => switchWorld(w)}>
              {w === 'day' ? 'DAY' : 'SNOW'}
            </button>
          ))}
        </div>
        <span className="tour-counter">
          {time(tourTime)} / {time(total)}
          <small>
            STEP {index + 1} / {STEPS.length}
          </small>
        </span>
        <div className="tour-line">
          <i style={{ width: `${(tourTime / total) * 100}%` }} />
        </div>
        <Button variant="ghost" className="robot-free" onClick={() => setFollow((v) => !v)}>
          <MousePointer2 size={13} />
          {follow ? 'FREE CAMERA' : 'FOLLOW CAMERA'}
        </Button>
        <Button
          variant="ghost"
          className="robot-fullscreen"
          onClick={() =>
            document.fullscreenElement
              ? void document.exitFullscreen()
              : void document.querySelector('.robot-world')?.requestFullscreen().catch(() => {})
          }
        >
          <Expand size={13} /> FULLSCREEN
        </Button>
      </footer>
      {!loaded && (
        <div className="load-screen" role="status" aria-live="polite">
          <span>WORLDLINE / SIMULATION → H3</span>
          <b>
            LOADING RENDERS {Math.min(loadDone, loadTotal).toString().padStart(2, '0')} / {loadTotal}
          </b>
          <div className="load-line">
            <i style={{ width: `${(Math.min(loadDone, loadTotal) / loadTotal) * 100}%` }} />
          </div>
          <small>3D frames, verification data and the first videos</small>
        </div>
      )}
    </main>
  );
}
