import {continuations,type TimeNode} from './types';

export const framesIn = (node?: TimeNode) => Math.max(1, node?.frameCount || 48);
export const atlasRows = (node?: TimeNode) => Math.ceil(framesIn(node) / 8);
type Moment = {id: string; node?: TimeNode; start: number; end: number; duration: number};
const cache = new WeakMap<TimeNode[], WeakMap<string[], ReturnType<typeof buildTimeline>>>();

function buildTimeline(nodes: TimeNode[], path: string[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  let total = 0;
  const moments: Moment[] = path.map(id => {
    const node = byId.get(id), start = total, duration = node?.duration || 2;
    total += duration;
    return {id, node, start, end: total, duration};
  });
  return {moments, total};
}
export function timelineFor(nodes: TimeNode[], path: string[]) {
  let paths = cache.get(nodes);
  if (!paths) {paths = new WeakMap(); cache.set(nodes, paths);}
  let timeline = paths.get(path);
  if (!timeline) {timeline = buildTimeline(nodes, path); paths.set(path, timeline);}
  return timeline;
}
export function locate(timeline: ReturnType<typeof timelineFor>, seconds: number) {
  const time = Math.max(0, Math.min(timeline.total, seconds));
  let depth = timeline.moments.findIndex(moment => time < moment.end - 1e-8);
  if (depth < 0) depth = Math.max(0, timeline.moments.length - 1);
  const moment = timeline.moments[depth], duration = moment?.duration || 2;
  const local = Math.max(0, Math.min(duration, time - (moment?.start || 0)));
  return {time, depth, local, progress: local / duration,
    frame: Math.min(framesIn(moment?.node) - 1, Math.floor(local * 24 + 1e-7))};
}
export const preloadAt = (duration: number) => Math.max(0, duration - .75);

/** Buffer every window up to the next genuine choice, without choosing for it. */
export function uninterruptedEnd(nodes:TimeNode[],path:string[],from:number) {
  let end=from;
  while(end<path.length-1) {
    const next=continuations(nodes,path[end]);
    if(next.length!==1||next[0].id!==path[end+1])break;
    end++;
  }
  return end;
}

/** Download the current shot plus all candidates before reaching the fork. */
export function decisionFrontier(nodes:TimeNode[],path:string[],from:number) {
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const end=uninterruptedEnd(nodes,path,from),result=path.slice(from,end+1).map(id=>byId.get(id)!);
  for(const choice of continuations(nodes,path[end])) {
    let current=choice;const seen=new Set<string>();
    while(!seen.has(current.id)) {
      seen.add(current.id);result.push(current);
      const next=continuations(nodes,current.id);
      if(next.length!==1)break;
      current=next[0];
    }
  }
  return [...new Map(result.map(n=>[n.id,n])).values()];
}
