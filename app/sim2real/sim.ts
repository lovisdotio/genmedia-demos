// Deterministic kinematic scenario. Units: metres, seconds, radians.
// Robot drives along -z in the right lane of a two-way street; a pedestrian
// crosses on the zebra from the right kerb to the left kerb. The pedestrian
// script is identical in every branch; only the robot's control profile changes.
// After the crossing, a no-entry sign stands in the lane: a second decision
// picks the side of the detour. Three crossing controls × two sides = 6 leaves.

export const FPS = 24;
export const DURATION = 15; // seconds, H3 Max's longest single render
export const FRAMES = DURATION * FPS;

export const WORLD = {
  roadHalfWidth: 3.5,
  sidewalk: 3,
  crossing: { zNear: -4.8, zFar: -7.2 }, // zebra band along z
  goalZ: -16,
};

export const ROBOT = {
  length: 0.95,
  width: 0.72,
  bodyHeight: 0.62,
  clearance: 0.2,
  mastHeight: 1.18,
  startZ: 0,
  x: 0.4,
  cruise: 1.5,
};

export const PEDESTRIAN = {
  radius: 0.25,
  height: 1.74,
  z: -6,
  startX: 4.9,
  endX: -5.2,
  speed: 1.3,
  startTime: 1.7,
};

export const SAFETY_BUFFER = 1.0; // metres, blocking constraint used by the planner

// No-entry sign in the robot's lane after the crossing: the plate faces the
// robot and spans x ± 0.3 m; the pole carries it at 0.95 m.
export const SIGN = { x: 0.5, z: -11, halfWidth: 0.3, halfDepth: 0.04, poleHeight: 1.25, plateY: 0.95, radius: 0.3 };
export const SIGN_BUFFER = 0.5; // metres, blocking constraint for static obstacles

// Detour as a function of progress: shift sideways by DETOUR m between z0→z1,
// hold past the sign, return z2→z3. Smoothstep keeps curvature low.
// Left (−x) crosses the centre line into the oncoming lane; right stays in lane.
const DETOUR = { left: -1.4, right: 1.4 };
const DZ = { z0: -8.4, z1: -10.2, z2: -11.8, z3: -13.8 };
const smooth = (a: number, b: number, v: number) => {
  const u = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return u * u * (3 - 2 * u);
};
export type Side = 'left' | 'right';
export const SIDES: { id: Side; label: string; short: string }[] = [
  { id: 'left', label: 'Swerve left, through the oncoming lane', short: 'LEFT' },
  { id: 'right', label: 'Swerve right, stay in own lane', short: 'RIGHT' },
];
export const laneX = (z: number, side: Side = 'right') =>
  ROBOT.x + DETOUR[side] * (smooth(-DZ.z0, -DZ.z1, -z) - smooth(-DZ.z2, -DZ.z3, -z));

export type ActionId = 'continue' | 'slow' | 'stop';
export type LeafId = `${ActionId}-${Side}`;
export const leafOf = (a: ActionId, side: Side): LeafId => `${a}-${side}`;
export const splitLeaf = (id: LeafId) => id.split('-') as [ActionId, Side];

type Phase = { until: number; accel: number; minSpeed?: number; maxSpeed?: number };

export const ACTIONS: {
  id: ActionId;
  label: string;
  short: string;
  profile: string;
  phases: Phase[];
}[] = [
  {
    id: 'continue',
    label: 'Continue at cruise speed',
    short: 'CONTINUE',
    profile: 'hold 1.5 m/s',
    phases: [{ until: Infinity, accel: 0 }],
  },
  {
    id: 'slow',
    label: 'Slow down, pass behind',
    short: 'SLOW DOWN',
    profile: '−0.6 m/s² to 0.25 m/s, then +0.5 m/s²',
    phases: [
      { until: 1.0, accel: 0 },
      { until: 6.3, accel: -0.6, minSpeed: 0.25 },
      { until: Infinity, accel: 0.5, maxSpeed: 1.5 },
    ],
  },
  {
    id: 'stop',
    label: 'Stop at the line, yield, resume',
    short: 'STOP + YIELD',
    profile: '−1.0 m/s² to 0, hold, +0.8 m/s²',
    phases: [
      { until: 1.6, accel: 0 },
      { until: 6.6, accel: -1.0, minSpeed: 0 },
      { until: Infinity, accel: 0.8, maxSpeed: 1.5 },
    ],
  },
];

export type RobotState = { x: number; z: number; heading: number; speed: number; accel: number };
export type PedState = { x: number; z: number; walking: boolean; phase: number };
export type CyclistState = { x: number; z: number; riding: boolean; phase: number };
export type Sample = {
  t: number;
  robot: RobotState;
  pedestrian: PedState;
  clearance: number; // robot footprint to pedestrian disc, metres
  signClearance: number; // robot footprint to the sign plate, metres
  inOncomingLane: boolean; // any part of the footprint left of the centre line (x < 0)
  onCrossing: boolean;
  pedOnRoad: boolean;
  cyclist: CyclistState;
  cyclistClearance: number; // robot footprint to the bicycle footprint, metres
  cyclistOnRoad: boolean; // inside the junction or the main road
};

export function pedestrianAt(t: number): PedState {
  const p = PEDESTRIAN;
  const walked = Math.max(0, t - p.startTime) * p.speed;
  const x = Math.max(p.endX, p.startX - walked);
  const walking = t > p.startTime && x > p.endX;
  return { x, z: p.z, walking, phase: walked / 0.72 };
}

function signDistance(r: RobotState) {
  const dx = Math.max(Math.abs(SIGN.x - r.x) - ROBOT.width / 2 - SIGN.halfWidth, 0);
  const dz = Math.max(Math.abs(SIGN.z - r.z) - ROBOT.length / 2 - SIGN.halfDepth, 0);
  return Math.hypot(dx, dz);
}

function footprintDistance(r: RobotState, px: number, pz: number) {
  const dx = Math.max(Math.abs(px - r.x) - ROBOT.width / 2, 0);
  const dz = Math.max(Math.abs(pz - r.z) - ROBOT.length / 2, 0);
  return Math.hypot(dx, dz) - PEDESTRIAN.radius;
}

// ── Segment 2 (t = 15 → 30 s): a crossroads after the sign. A cyclist rides out
// of the right-hand side street and crosses the junction from right to left.
export const DURATION2 = 30;
export const JUNCTION = { zNear: -21.5, zFar: -28, sideLaneZ: -23.1, turnRadius: 2.5, stopZ: -20.7 };
// startTime calibrated on the segment-2 H3 renders: SAM puts the rider a median 0.6 s earlier
// than the first 3D references (19 s), so the scenario is shifted to match the videos.
export const CYCLIST = { z: -26.4, startX: 14, endX: -16, speed: 4, startTime: 18.4, length: 1.7, width: 0.6, height: 1.75 };
// Delivery address straight ahead; through the side street it is a loop around the block.
export const ADDRESS_Z = -45;
export const BLOCK_DETOUR = 80;
export type OptionId = 'straight' | 'turn' | 'wait';
export const OPTIONS: { id: OptionId; label: string; short: string }[] = [
  { id: 'straight', label: 'Go straight through the junction', short: 'STRAIGHT' },
  { id: 'turn', label: 'Turn right into the side street', short: 'TURN RIGHT' },
  { id: 'wait', label: 'Stop at the junction, wait for the cyclist', short: 'STOP + WAIT' },
];
// Only the planner's crossing control (slow) is expanded to the third decision.
export type Leaf3Id = `slow-${Side}-${OptionId}`;
export const leaf3Of = (side: Side, o: OptionId): Leaf3Id => `slow-${side}-${o}`;
export const splitLeaf3 = (id: Leaf3Id) => {
  const [a, side, o] = id.split('-') as [ActionId, Side, OptionId];
  return { parent: leafOf(a, side), side, option: o };
};
export const isLeaf3 = (id: string): id is Leaf3Id => id.split('-').length === 3;

export function cyclistAt(t: number): CyclistState {
  const c = CYCLIST;
  const x = Math.max(c.endX, c.startX - (t - c.startTime) * c.speed);
  return { x, z: c.z, riding: x > c.endX, phase: (c.startX - x) / 1.9 };
}
// Plan distance between the robot footprint (turned by its heading) and the bicycle.
function cyclistDistance(r: RobotState, cy: CyclistState) {
  const c = Math.abs(Math.cos(r.heading)),
    sn = Math.abs(Math.sin(r.heading));
  const hx = (ROBOT.width / 2) * c + (ROBOT.length / 2) * sn,
    hz = (ROBOT.length / 2) * c + (ROBOT.width / 2) * sn;
  const dx = Math.max(Math.abs(cy.x - r.x) - hx - CYCLIST.length / 2, 0);
  const dz = Math.max(Math.abs(cy.z - r.z) - hz - CYCLIST.width / 2, 0);
  return Math.hypot(dx, dz);
}

const cache = new Map<string, Sample[]>();

// Integrates at 240 Hz and samples at the video frame rate (frame i ↔ t = i / FPS).
// A bare crossing control means its planner-preferred side (right).
export function simulate(leaf: LeafId | ActionId): Sample[] {
  const hit = cache.get(leaf);
  if (hit) return hit;
  const [id, side] = (leaf.includes('-') ? leaf.split('-') : [leaf, 'right']) as [ActionId, Side];
  const action = ACTIONS.find((a) => a.id === id)!;
  const out: Sample[] = [];
  const sub = 10,
    dt = 1 / (FPS * sub);
  let z = ROBOT.startZ,
    v = ROBOT.cruise,
    a = 0;
  for (let i = 0; i <= FRAMES; i++) {
    const t = i / FPS;
    // Heading follows the path tangent: positive = turning left (towards -x).
    const slope = (laneX(z - 0.05, side) - laneX(z + 0.05, side)) / 0.1;
    const robot = { x: laneX(z, side), z, heading: -Math.atan(slope), speed: v, accel: a };
    const pedestrian = pedestrianAt(t);
    out.push({
      t,
      robot,
      pedestrian,
      clearance: footprintDistance(robot, pedestrian.x, pedestrian.z),
      signClearance: signDistance(robot),
      inOncomingLane: robot.x - ROBOT.width / 2 < 0,
      onCrossing:
        z - ROBOT.length / 2 < WORLD.crossing.zNear &&
        z + ROBOT.length / 2 > WORLD.crossing.zFar,
      pedOnRoad: Math.abs(pedestrian.x) < WORLD.roadHalfWidth,
      ...cyclistFields(robot, t),
    });
    for (let s = 0; s < sub; s++) {
      const time = t + s * dt;
      const phase = action.phases.find((p) => time < p.until)!;
      a = phase.accel;
      v += a * dt;
      if (phase.minSpeed !== undefined && v < phase.minSpeed) {
        v = phase.minSpeed;
        a = 0;
      }
      if (phase.maxSpeed !== undefined && v > phase.maxSpeed) {
        v = phase.maxSpeed;
        a = 0;
      }
      // Speed is along the path; the detour's slope is small (≤ 0.9).
      const sl = (laneX(z - 0.05, side) - laneX(z + 0.05, side)) / 0.1;
      z -= (v * dt) / Math.sqrt(1 + sl * sl);
    }
  }
  cache.set(leaf, out);
  return out;
}

function cyclistFields(robot: RobotState, t: number) {
  const cyclist = cyclistAt(t);
  return { cyclist, cyclistClearance: cyclistDistance(robot, cyclist), cyclistOnRoad: Math.abs(cyclist.x) < WORLD.roadHalfWidth + 3 };
}

// Segment-2 path by arc length s from the robot's position at t = 15 s.
function pathAt(o: OptionId, x0: number, z0: number, s: number) {
  const { turnRadius: R, sideLaneZ } = JUNCTION;
  const zTurn = sideLaneZ + R;
  if (o !== 'turn' || z0 - s > zTurn) return { x: x0, z: z0 - s, heading: 0 };
  const sa = z0 - zTurn,
    th = (s - sa) / R;
  if (th < Math.PI / 2) return { x: x0 + R - R * Math.cos(th), z: zTurn - R * Math.sin(th), heading: -th };
  return { x: x0 + R + (s - sa - (R * Math.PI) / 2), z: sideLaneZ, heading: -Math.PI / 2 };
}

// Samples for t = 15 → 30 s (frame i ↔ t = 15 + i / FPS), continuing the parent leaf.
export function simulate2(id: Leaf3Id): Sample[] {
  const hit = cache.get(id);
  if (hit) return hit;
  const { parent, option } = splitLeaf3(id);
  const start = simulate(parent)[FRAMES];
  const x0 = start.robot.x,
    z0 = start.robot.z;
  let v = start.robot.speed,
    a = 0,
    s = 0;
  // Wait: brake at 0.8 m/s² to stop at the junction's stop line, hold until the
  // cyclist has left the road, then accelerate back to cruise.
  const brakeAt = DURATION + (z0 - JUNCTION.stopZ - (v * v) / 1.6) / v;
  const phases: Phase[] =
    option === 'straight'
      ? [{ until: Infinity, accel: 0 }]
      : option === 'wait'
        ? [
            { until: brakeAt, accel: 0 },
            { until: 23.6, accel: -0.8, minSpeed: 0 },
            { until: Infinity, accel: 0.8, maxSpeed: ROBOT.cruise },
          ]
        : [
            { until: 16, accel: 0 },
            { until: 17, accel: -0.5, minSpeed: 1.0 },
            { until: 24.5, accel: 0 },
            { until: Infinity, accel: 0.5, maxSpeed: ROBOT.cruise },
          ];
  const out: Sample[] = [];
  const sub = 10,
    dt = 1 / (FPS * sub);
  for (let i = 0; i <= FRAMES; i++) {
    const t = DURATION + i / FPS;
    const p = pathAt(option, x0, z0, s);
    const robot = { x: p.x, z: p.z, heading: p.heading, speed: v, accel: a };
    const pedestrian = pedestrianAt(t);
    out.push({
      t,
      robot,
      pedestrian,
      clearance: footprintDistance(robot, pedestrian.x, pedestrian.z),
      signClearance: signDistance(robot),
      inOncomingLane: robot.x - ROBOT.width / 2 < 0,
      onCrossing: false,
      pedOnRoad: false,
      ...cyclistFields(robot, t),
    });
    for (let k = 0; k < sub; k++) {
      const phase = phases.find((ph) => t + k * dt < ph.until)!;
      a = phase.accel;
      v += a * dt;
      if (phase.minSpeed !== undefined && v < phase.minSpeed) {
        v = phase.minSpeed;
        a = 0;
      }
      if (phase.maxSpeed !== undefined && v > phase.maxSpeed) {
        v = phase.maxSpeed;
        a = 0;
      }
      s += v * dt;
    }
  }
  cache.set(id, out);
  return out;
}
// The whole 30 s path of a third-level leaf.
export const simulatePath = (id: Leaf3Id) => [...simulate(splitLeaf3(id).parent).slice(0, FRAMES), ...simulate2(id)];

export type Consequences3 = {
  leaf: Leaf3Id;
  option: OptionId;
  minCyclist: number;
  minCyclistAt: number;
  conflict: boolean;
  remaining: number; // route left to the address at t = 30 s, metres
  waiting: number;
};
export function consequences3(id: Leaf3Id): Consequences3 {
  const s = simulate2(id);
  const { option } = splitLeaf3(id);
  let min = Infinity,
    at = 0,
    waiting = 0;
  for (const x of s) {
    if (x.cyclistOnRoad && x.cyclistClearance < min) {
      min = x.cyclistClearance;
      at = x.t;
    }
    if (x.robot.speed < 0.05) waiting += 1 / FPS;
  }
  const end = s.at(-1)!.robot;
  const remaining =
    option === 'turn'
      ? JUNCTION.sideLaneZ - ADDRESS_Z + BLOCK_DETOUR - Math.max(0, end.x - ROBOT.x - JUNCTION.turnRadius)
      : end.z - ADDRESS_Z;
  return { leaf: id, option, minCyclist: min, minCyclistAt: at, conflict: min < SAFETY_BUFFER, remaining, waiting };
}
// 3. Junction: drop options closer than 1 m to the cyclist, then take the one
//    with the shortest remaining route to the address.
export function rank3(side: Side) {
  const all = OPTIONS.map((o) => consequences3(leaf3Of(side, o.id)));
  const ok = all.filter((c) => !c.conflict).sort((a, b) => a.remaining - b.remaining);
  return { all, selected: (ok[0] ?? all.find((c) => c.option === 'wait')!).option };
}

export type Consequences = {
  id: ActionId;
  leaf: LeafId;
  oncoming: number; // seconds spent in the oncoming lane
  minClearance: number;
  minClearanceAt: number;
  signClearance: number;
  conflict: boolean;
  progress: number;
  waiting: number;
  maxDecel: number;
  finalSpeed: number;
};

export function consequences(id: ActionId, side: Side = 'right'): Consequences {
  const s = simulate(leafOf(id, side));
  let min = Infinity,
    at = 0,
    waiting = 0,
    maxDecel = 0,
    sign = Infinity,
    oncoming = 0;
  for (const x of s) {
    sign = Math.min(sign, x.signClearance);
    if (x.inOncomingLane) oncoming += 1 / FPS;
    if (x.pedOnRoad && x.clearance < min) {
      min = x.clearance;
      at = x.t;
    }
    if (x.robot.speed < 0.05) waiting += 1 / FPS;
    maxDecel = Math.max(maxDecel, -x.robot.accel);
  }
  return {
    id,
    leaf: leafOf(id, side),
    oncoming,
    minClearance: min,
    minClearanceAt: at,
    signClearance: sign,
    conflict: min < SAFETY_BUFFER || sign < SIGN_BUFFER,
    progress: ROBOT.startZ - s.at(-1)!.robot.z,
    waiting,
    maxDecel,
    finalSpeed: s.at(-1)!.robot.speed,
  };
}

// Explicit planner rules, not a learned model.
// 1. Crossing: drop controls closer than 1 m to the pedestrian, then prefer progress.
// 2. Sign: stay in the own lane if the sign clearance is ≥ 0.5 m; otherwise take
//    the side with more clearance.
export function rank() {
  const all = ACTIONS.map((a) => consequences(a.id, 'right'));
  const admissible = all.filter((c) => !c.conflict).sort((a, b) => b.progress - a.progress);
  const rejected = all.filter((c) => c.conflict).sort((a, b) => b.minClearance - a.minClearance);
  const selected = admissible[0]?.id ?? 'stop';
  const sides = SIDES.map((sd) => consequences(selected, sd.id));
  const inLane = sides.filter((c) => c.oncoming === 0 && c.signClearance >= SIGN_BUFFER);
  const side = (inLane[0] ?? [...sides].sort((a, b) => b.signClearance - a.signClearance)[0]).leaf.split('-')[1] as Side;
  const leaves = ACTIONS.flatMap((a) => SIDES.map((sd) => consequences(a.id, sd.id)));
  return { ranking: [...admissible, ...rejected], selected, side, leaf: leafOf(selected, side), sides, leaves, all };
}
