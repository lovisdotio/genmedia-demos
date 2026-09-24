import type {StoryNode} from './story/types';

export type TimeNode = StoryNode & {
  parent: string | null;
  depth: number;
  frameCount: number;
  continuation: boolean;
  sharedEnding?: boolean;
  parents?: string[];
  worldAnchor?: string;
  rejoinTarget?: string;
  storyPosition?: [number, number, number];
  storyHandle?: [number, number, number];
  storyStartPosition?: [number, number, number];
  storyControl1?: [number, number, number];
  storyControl2?: [number, number, number];
  revealStart?: number;
  revealEnd?: number;
  revealAhead?: number;
  storyEnding?: boolean;
  cutoutTitle?: string;
  cutout?: {image:string;sourceScene:string;size:number[];bounds:number[]};
  finalization?: 'arrival' | 'hold';
  arrivalFrom?: string;
  finalImage?: string;
};
export type TimeManifest = {
  title: string; nodes: TimeNode[]; ready: number; total: number;
  duration: number; fps: number; shotDuration: number; codec: string; join: string;
  revision?: string; mode?: 'complete-story';
  defaultPath?: string[];
  /** Reviewed full routes eligible for Random; [] deliberately disables it. */
  randomPaths?: string[][];
  visualOnly?: boolean;
  layout?: 'classic' | 'city';
};
export type TimePoint = {id: string; frame: number};
export type TimeJump = {from: TimePoint; to: TimePoint};

/** Recorded continuations, explicit bridges, and the archive's shared ending. */
export function continuations(nodes: TimeNode[], id: string): TimeNode[] {
  const target = nodes.find(n => n.id === id)?.rejoinTarget;
  const children=nodes.filter(n => (target ? n.id === target : n.parent === id) && n.status === 'ready');
  return children.length||target?children:nodes.filter(n=>n.sharedEnding&&n.parents?.includes(id)&&n.status==='ready');
}

/** Show the next real decision throughout the shot, not its tiny last window. */
export function upcomingFork(nodes: TimeNode[], path: string[], depth: number) {
  for (let index=depth;index<path.length;index++) {
    const choices=continuations(nodes,path[index]);
    if(choices.length>1)return {depth:index,choices};
    if(!choices.length)break;
  }
  return {depth,choices:[] as TimeNode[]};
}

/** Random follows recorded routes, never the graph's editorial navigation links. */
export function randomContinuation(nodes: TimeNode[], prefix: string[], random = Math.random): string[] {
  const route = [...prefix], seen = new Set(route);
  while (route.length) {
    const children = continuations(nodes, route.at(-1)!).filter(n => !seen.has(n.id));
    if (!children.length) break;
    const child = children[Math.min(children.length-1, Math.max(0, Math.floor(random()*children.length)))];
    route.push(child.id); seen.add(child.id);
  }
  return route;
}

/** Replay from the shared beginning with a different, valid generated future. */
export function randomPassage(nodes: TimeNode[], currentPath: string[], random = Math.random, approvedPaths?: string[][]): {path: string[]; depth: number} | null {
  if(approvedPaths!==undefined) {
    const byId=new Map(nodes.map(n=>[n.id,n]));
    const candidates=approvedPaths.filter(path=>path.length&&path.join('|')!==currentPath.join('|')&&new Set(path).size===path.length&&path.every((id,index)=> {
      const node=byId.get(id);
      return node?.status==='ready'&&(index===0?!node.parent:continuations(nodes,path[index-1]).some(n=>n.id===id));
    })&&!continuations(nodes,path.at(-1)!).length);
    if(!candidates.length)return null;
    // Prefer a different opening direction, but retain other reviewed futures
    // if only one direction has viable results.
    const fork=currentPath.findIndex(id=>continuations(nodes,id).length>1);
    const different=candidates.filter(path=>fork>=0&&path[fork+1]!==currentPath[fork+1]);
    const pool=different.length?different:candidates;
    const path=pool[Math.min(pool.length-1,Math.max(0,Math.floor(random()*pool.length)))];
    return {path:[...path],depth:0};
  }
  const otherRoots=nodes.filter(n=>!n.parent && !n.sharedEnding && n.status==='ready' && n.id!==currentPath[0]);
  if(otherRoots.length && (currentPath[0]!=='root' || random()<.2)) {
    const root=otherRoots[Math.min(otherRoots.length-1,Math.floor(random()*otherRoots.length))];
    return {path:randomContinuation(nodes,[root.id],random),depth:0};
  }
  // A complete story can share several opening scenes before the first choice.
  const fork=currentPath.findIndex((id,index)=>continuations(nodes,id).some(n=>n.id!==currentPath[index+1]));
  if(fork<0)return null;
  const directions=continuations(nodes,currentPath[fork]).filter(n=>n.id!==currentPath[fork+1]);
  const direction=directions[Math.min(directions.length-1,Math.floor(random()*directions.length))];
  const path = randomContinuation(nodes, [...currentPath.slice(0,fork+1), direction.id], random);
  return {path, depth: 0};
}
export type BranchLink = {id: string; from: TimePoint; to: TimePoint; label: string; kind: 'crossing' | 'rejoin' | 'ending' | 'loop' | 'shortcut'; featured?: boolean};

/** Presentation reveal, not a media-loading signal. Follow playback closely. */
export function revealFrontier(nodes: TimeNode[], selected: string, frame: number, path: string[]): Map<string, number> {
  const active = nodes.find(n => n.id === selected);
  if (!active) return new Map();
  // The shared opening is a single still. Future rails start with the film,
  // never as a pre-drawn line behind the isolated beginning image.
  if(!active.parent&&active.duration<=.5)return new Map(nodes.map(n=>[n.id,n.id===active.id?1:0]));
  const progress=Math.max(0,Math.min(active.frameCount-1,frame))/active.frameCount;
  const logical=active.revealStart!==undefined&&active.revealEnd!==undefined;
  const horizon = logical ? active.revealStart!+(active.revealEnd!-active.revealStart!)*progress+(active.revealAhead??.15) : active.depth+progress+.75;
  const targets = new Map(nodes.map(n => [n.id, Math.max(0, Math.min(1, logical&&n.revealStart!==undefined&&n.revealEnd!==undefined
    ? (horizon-n.revealStart-n.choice*.009)/Math.max(.01,n.revealEnd-n.revealStart) : horizon-n.depth-n.choice*.035))]));
  // Navigation can jump to any frame. Its history must be available immediately;
  // real rejoin targets can have a lower depth than their source.
  for (const id of path.slice(0, path.indexOf(selected) + 1)) targets.set(id, 1);
  targets.set(selected, 1);
  return targets;
}

/** Navigation links connect existing timelines; they never assert a generated seam. */
export function branchLinks(nodes: TimeNode[]): BranchLink[] {
  // In the complete demonstration every connection is playable footage. The
  // parent tracks and two reviewed bridges already draw the entire graph.
  if(nodes.some(n=>n.storyEnding))return [];
  // Final arrivals are already connected by their actual media. Keep the
  // archive's editorial navigation groups based on the original branches.
  nodes=nodes.filter(n=>!n.finalization);
  const links: BranchLink[] = [];
  for (let depth = 1; depth <= 3; depth++) {
    const groups = new Map<string, TimeNode[]>();
    for (const node of nodes.filter(n => n.depth === depth)) {
      const key = depth === 1 ? 'direction' : depth === 2 ? String(node.choice) : node.title;
      groups.set(key, [...(groups.get(key) || []), node]);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.id.localeCompare(b.id));
      group.forEach((node, i) => {
        const target = group[(i + 1) % group.length];
        if (target.id === node.id || (depth > 1 && target.parent === node.parent)) return;
        links.push({id: `${node.id}~${target.id}`, from: {id: node.id, frame: 35},
          to: {id: target.id, frame: 12}, label: depth === 3 ? node.title : 'Another direction', kind: 'crossing'});
      });
    }
  }
  // Several routes can enter the SAME existing scene and continue along its path.
  // These are explicit editorial navigation jumps, not shared model checkpoints.
  for (const depth of [2, 3]) {
    for (let choice = 0; choice < 4; choice++) {
      const prefix = String.fromCharCode(97 + choice);
      const target = nodes.find(n => n.id === prefix + String(choice + 1).repeat(depth - 1));
      if (!target) continue;
      const sources = nodes.filter(n => n.depth === depth - 1 && n.id !== target.parent && (depth === 2 || n.choice === choice));
      for (const source of sources) links.push({id: `${source.id}>${target.id}`, kind: 'rejoin',
        from: {id: source.id, frame: 47}, to: {id: target.id, frame: 0}, label: target.title});
    }
  }
  // Editorial cross-level routes form cycles through several different branches.
  // Keep these outside parent pointers: recorded generation ancestry stays intact.
  for (const node of nodes.filter(n => n.depth === 2 || n.depth === 3)) {
    const rootIndex = node.id.charCodeAt(0) - 97;
    const otherRoot = String.fromCharCode(97 + (rootIndex + 1) % 4);
    const returning = node.depth === 3;
    const targetId = returning ? `${otherRoot}${node.choice + 1}`
      : `${otherRoot}${(node.choice + 1) % 4 + 1}${node.choice + 1}`;
    const target = nodes.find(n => n.id === targetId);
    if (target) links.push({id: `${node.id}:${target.id}`, kind: returning ? 'loop' : 'shortcut',
      from: {id: node.id, frame: 35}, to: {id: target.id, frame: returning ? 16 : 8},
      label: `${returning ? 'Loop back' : 'Jump ahead'}: ${target.title}`});
  }
  const ending = nodes.find(node => node.sharedEnding);
  if (ending) for (const id of ending.parents || []) {
    if (nodes.some(node => node.id === id)) links.push({id: `${id}>${ending.id}`, kind: 'ending',
      from: {id, frame: 47}, to: {id: ending.id, frame: 0}, label: 'One shared ending'});
  }
  // Related actions can be explored across takes without splicing their media.
  const anchors = [...new Set(nodes.filter(n => n.depth === 5).map(n => n.worldAnchor).filter(Boolean))];
  for (const anchor of anchors) {
    const group = nodes.filter(n => n.depth === 5 && n.worldAnchor === anchor);
    if (group.length < 2) continue;
    group.forEach((node, i) => {
      const target = group[(i+1)%group.length];
      links.push({id:`${node.id}~${target.id}`,kind:'crossing',from:{id:node.id,frame:32},to:{id:target.id,frame:16},label:'Explore another take: '+target.title});
    });
  }
  // A few large return loops make the deeper network legible. Each family
  // converges on a real earlier scene in the next family, then can branch again.
  // These remain navigation jumps, NOT newly generated continuous footage.
  for (const source of nodes.filter(n => n.depth === 6 && !n.rejoinTarget)) {
    const family = source.id.charCodeAt(0) - 97;
    if (family < 0 || family > 3) continue;
    const next = (family + 1) % 4;
    const target = nodes.find(n => n.id === `${String.fromCharCode(97 + next)}${next + 1}`);
    if (target) links.push({id: `return:${source.id}:${target.id}`, kind: 'loop', featured: true,
      from: {id: source.id, frame: 38}, to: {id: target.id, frame: 8}, label: `Return to: ${target.title}`});
  }
  const hubs = nodes.filter(n => n.depth === 4 && nodes.some(child => child.parent === n.id && child.depth === 5));
  for (const [i, hub] of hubs.entries()) {
    const sources = nodes.filter(n => n.depth === 4 && n.id[0] === hubs[(i + 3) % hubs.length].id[0] && n.id !== hub.id);
    for (const source of [sources[3], sources[11]].filter(Boolean)) links.push({
      id: `converge:${source.id}:${hub.id}`, kind: 'rejoin', featured: true,
      from: {id: source.id, frame: 40}, to: {id: hub.id, frame: 6}, label: `Shared destination: ${hub.title}`,
    });
  }
  return links;
}

export type Ranking = {model: string; revision?: string; decisions: Record<string, {selectedId: string; order: string[]; probabilities: Record<string, number>; reviews: Record<string, {observations: string; continuity: string; interest: string}>}>};
export function pathThrough(nodes: TimeNode[], id: string, preferred?: Record<string, string>, currentPath?: string[]): string[] {
  const ending = nodes.find(node => node.sharedEnding);
  if (ending && id === ending.id) {
    const previousLeaf = currentPath?.findLast(item => ending.parents?.includes(item));
    return pathThrough(nodes, previousLeaf || 'root', preferred);
  }
  // A shared final scene can be reached from many parents. Preserve the actual
  // incoming route when revisiting it, rather than jumping to its canonical one.
  const path: string[] = currentPath?.includes(id) ? currentPath.slice(0,currentPath.indexOf(id)+1) : [];
  let node = path.length ? undefined : nodes.find(n => n.id === id);
  while (node) {
    path.unshift(node.id);
    node = nodes.find(n => n.id === node!.parent);
  }
  const next = (parent: string) => continuations(nodes,parent).find(n => !path.includes(n.id) && n.id === preferred?.[parent]) || continuations(nodes,parent).find(n => !path.includes(n.id));
  let child = next(path.at(-1)!);
  while (child) {
    path.push(child.id);
    child = next(child.id);
  }
  if (ending && ending.parents?.includes(path.at(-1)!)) path.push(ending.id);
  return path;
}
