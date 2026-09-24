import type {StoryNode} from './types';

// Keep downloaded scenes across seeks. Reopening a branch must not fetch the
// same media again, and an old player's cancellation must not cancel a new one.
const sceneBytes = new Map<string, Promise<ArrayBuffer>>();
function loadScene(node:StoryNode) {
  const key=node.stream!;
  let pending=sceneBytes.get(key);
  if(!pending) {
    pending=fetch(key).then(r=>{
      if(!r.ok) throw Error('A prepared scene could not be loaded.'); return r.arrayBuffer();
    });
    sceneBytes.set(key,pending);
    pending.catch(()=>{if(sceneBytes.get(key)===pending)sceneBytes.delete(key);});
  } else {
    sceneBytes.delete(key);sceneBytes.set(key,pending);
  }
  // Retain a complete decision frontier, including each candidate's contiguous
  // windows, instead of evicting the next shot while its alternatives download.
  while(sceneBytes.size>96) sceneBytes.delete(sceneBytes.keys().next().value!);
  return pending;
}

/** Append prepared scenes at their actual duration on one uninterrupted timeline. */
export class StoryPlayer {
  private source = new MediaSource();
  private buffer: SourceBuffer | null = null;
  private url = URL.createObjectURL(this.source);
  private chain: Promise<void> = Promise.resolve();
  private abort = new AbortController();
  private closed = false;
  private failed = false;
  private appended = new Set<number>();
  private open: Promise<void>;

  static supported(codec:string) { return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(codec); }
  static prefetch(nodes:StoryNode[]) {
    for(const node of nodes) if(node.stream) void loadScene(node).catch(()=>{});
  }
  get available() { return !this.closed && !this.failed && this.video.getAttribute('src') === this.url; }

  constructor(private video:HTMLVideoElement, codec:string, duration:number, private shotDuration=5) {
    this.open = new Promise((resolve,reject) => {
      const fail=()=>reject(Error('The prepared media stream could not be opened.'));
      this.source.addEventListener('sourceopen',()=>{
        try { this.buffer=this.source.addSourceBuffer(codec); this.source.duration=duration; resolve(); }
        catch { fail(); }
      },{once:true});
      this.abort.signal.addEventListener('abort',fail,{once:true});
    });
    video.src=this.url;
  }

  prefetch(nodes:StoryNode[]) {
    StoryPlayer.prefetch(nodes);
  }

  setDuration(duration:number) {
    this.chain=this.chain.then(async()=>{
      await this.open;
      if(!this.closed && this.source.readyState==='open' && Math.abs(this.source.duration-duration)>.001) this.source.duration=duration;
    });
    return this.chain;
  }

  append(node:StoryNode,chapter:number,start=chapter*this.shotDuration,duration=this.shotDuration) {
    if(this.appended.has(chapter)) return this.chain;
    this.appended.add(chapter);
    this.chain=this.chain.then(async()=>{
      const [data]=await Promise.all([loadScene(node),this.open]);
      if(this.closed) return;
      const buffer=this.buffer!;
      await new Promise<void>((resolve,reject)=>{
        const cleanup=()=>{buffer.removeEventListener('updateend',done);buffer.removeEventListener('error',fail);this.abort.signal.removeEventListener('abort',fail);};
        const done=()=>{cleanup();resolve();};
        const fail=()=>{cleanup();reject(Error('The next scene could not be prepared.'));};
        buffer.addEventListener('updateend',done,{once:true});buffer.addEventListener('error',fail,{once:true});this.abort.signal.addEventListener('abort',fail,{once:true});
        try {
          buffer.timestampOffset=start;
          buffer.appendWindowEnd=Infinity;
          // Cumulative frame durations are floating-point values. A tiny
          // tolerance keeps an exact 24-fps boundary sample from being culled.
          buffer.appendWindowStart=Math.max(0,start-.00001);
          buffer.appendWindowEnd=start+duration+.00001;
          buffer.appendBuffer(data);
        } catch { fail(); }
      });
    }).catch(error=>{this.failed=true;this.appended.delete(chapter);throw error;});
    return this.chain;
  }

  finish() { if(this.source.readyState==='open' && !this.buffer?.updating) this.source.endOfStream(); }
  destroy() {
    this.closed=true;this.abort.abort();
    if(this.video.getAttribute('src')===this.url) {this.video.pause();this.video.removeAttribute('src');this.video.load();}
    URL.revokeObjectURL(this.url);
  }
}
