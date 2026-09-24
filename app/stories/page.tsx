'use client';
import {useEffect, useMemo, useRef, useState} from 'react';
import {Check, ChevronLeft, ChevronRight, Dice5, Expand, Pause, Play, RotateCcw, Volume2, VolumeX} from 'lucide-react';
import TimeSpace from './space';
import {StoryPlayer} from './story/player';
import {branchLinks, continuations, pathThrough, randomPassage, upcomingFork, type Ranking, type TimeJump, type TimeManifest, type TimePoint} from './types';
import {atlasRows, decisionFrontier, framesIn, locate, preloadAt, timelineFor, uninterruptedEnd} from './timing';
import ExperienceNav from '../experience-nav';
import './tree.css';
const noNodes: TimeManifest['nodes'] = [];

export default function TimeTree() {
  const [manifest, setManifest] = useState<TimeManifest | null>(null), [error, setError] = useState('');
  const [newAdventure, setNewAdventure] = useState(true);
  const [path, setPath] = useState<string[]>(['root', 'a', 'a1', 'a11']), [time, setTime] = useState(0);
  const [ranking, setRanking] = useState<Ranking | null>(null);
  const touched = useRef(false), rankingLoaded = useRef(false);
  const entryOpened = useRef(false);
  const rankingRevision = useRef('');
  const [phase, setPhase] = useState<'idle' | 'playing' | 'paused' | 'preparing' | 'complete'>('idle');
  const [muted, setMuted] = useState(false), [focus, setFocus] = useState(0), [visited, setVisited] = useState<string[]>(['root']);
  const [playbackRate,setPlaybackRate] = useState(1);
  const [jumps, setJumps] = useState<TimeJump[]>([]), [cinema, setCinema] = useState(false);
  const [restart, setRestart] = useState(0);
  const [allExplorations,setAllExplorations]=useState(true);
  const video = useRef<HTMLVideoElement>(null), stage = useRef<HTMLElement>(null), strip = useRef<HTMLDivElement>(null);
  const player = useRef<StoryPlayer | null>(null), running = useRef(false), serial = useRef(0);
  const enginePath = useRef<string[]>([]), seekAbort = useRef<AbortController | null>(null);
  const pendingPlay = useRef(false), preparing = useRef(false);
  const committed = useRef(new Set<number>()), prefetched = useRef(new Set<string>());
  const latest = useRef({manifest, path, time}); latest.current = {manifest, path, time};
  const timeline = timelineFor(manifest?.nodes || noNodes, path), duration = timeline.total;
  const {depth, local, frame, progress} = locate(timeline, time);
  const moment = timeline.moments[depth];
  const node = manifest?.nodes.find(n => n.id === path[depth]);
  const fork = useMemo(()=>upcomingFork(manifest?.nodes || noNodes,path,depth),[manifest,path,depth]);
  const choiceLocked = committed.current.has(fork.depth+1) || (depth===fork.depth && local>=preloadAt(moment?.duration || 2));
  const decision = ranking?.decisions[path[fork.depth] || ''];
  const order = (id:string,choice:number) => {const rank=decision?.order.indexOf(id);return rank!==undefined&&rank>=0?rank:choice;};
  const next = [...fork.choices].sort((a,b) => order(a.id,a.choice)-order(b.id,b.choice));
  const preferred = ranking ? Object.fromEntries(Object.entries(ranking.decisions).map(([id,d]) => [id,d.selectedId])) : undefined;
  const ready = Boolean(manifest?.nodes.find(n => n.id === 'root' && n.status === 'ready'));
  const connections = useMemo(() => branchLinks(manifest?.nodes || []), [manifest?.nodes]);

  useEffect(() => {
    if (!manifest) return;
    if(manifest.visualOnly)setMuted(true);
    StoryPlayer.prefetch(decisionFrontier(manifest.nodes,manifest.defaultPath || path,0));
    const known = new Set(manifest.nodes.map(n=>n.id));
    setJumps(previous=>{
      const retained=previous.filter(jump=>known.has(jump.from.id)&&known.has(jump.to.id));
      return retained.length===previous.length?previous:retained;
    });
    setVisited(previous=>{
      const retained=previous.filter(id=>known.has(id));
      return retained.length===previous.length?previous:retained;
    });
    const retained = latest.current.path.filter(id => manifest.nodes.some(n => n.id === id));
    const extended = !touched.current && manifest.defaultPath ? manifest.defaultPath : pathThrough(manifest.nodes, retained.at(-1) || 'root', preferred, retained);
    if (extended.join('|') === latest.current.path.join('|')) return;
    serial.current++; seekAbort.current?.abort(); player.current?.destroy(); player.current = null;
    running.current = false; preparing.current = false; committed.current = new Set(); enginePath.current = [];
    setPath(extended); setTime(0); setPhase('idle');
  }, [manifest]);

  useEffect(() => {
    if (!player.current) {setPhase('idle'); setTime(0);}
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    // The published site ships the City walk version only (its recorded paths and media).
    const source='continuity-city';
    setAllExplorations(false);
    setNewAdventure(false);
    const refresh = async () => {
      try {
        const response = await fetch(`/cast/${source}/manifest.json`);
        if (!response.ok) throw Error('The connected scenes are being prepared.');
        const data = await response.json() as TimeManifest;
        if (stopped) return;
        setManifest(old => old?.ready === data.ready && old?.total === data.total&&old?.revision===data.revision || running.current || preparing.current ? old : data);
        {
          const response = await fetch(`/cast/${source}/decisions.json`);
          if (response.ok) {
            const ranks = await response.json() as Ranking;
            if (!rankingLoaded.current || rankingRevision.current !== (ranks.revision || 'initial')) {
              setRanking(ranks); rankingLoaded.current = true; rankingRevision.current = ranks.revision || 'initial';
              if (!touched.current) setPath(data.defaultPath || pathThrough(data.nodes, 'root', Object.fromEntries(Object.entries(ranks.decisions).map(([id,d]) => [id,d.selectedId]))));
            }
          }
        }
      } catch (e) {if (!stopped) {setError(e instanceof Error ? e.message : 'Could not load the tree.'); timer = setTimeout(refresh, 5000);}}
    };
    void refresh();
    return () => {
      stopped = true; clearTimeout(timer); serial.current++; seekAbort.current?.abort(); player.current?.destroy();
      player.current = null; running.current = false; preparing.current = false;
      committed.current = new Set(); prefetched.current = new Set(); enginePath.current = [];
    };
  }, []);

  useEffect(() => {
    let raf = 0, lastUpdate = 0;
    const pump = () => {
      const state = latest.current, movie = video.current;
      // Media loading must continue even if WebGL misses an animation frame or
      // play() is waiting for enough buffered data to resolve.
      if ((running.current || pendingPlay.current) && !preparing.current && movie && state.manifest) {
        const lastDepth = state.path.length - 1;
        const clock = timelineFor(state.manifest.nodes, state.path), cursor = locate(clock, movie.currentTime), d = cursor.depth;
        const id = state.path[d];
        if (!prefetched.current.has(id)) {
          prefetched.current.add(id); player.current?.prefetch(decisionFrontier(state.manifest.nodes,state.path,d));
        }
        // Catch up a missing current segment as well as the next one. A stalled
        // clock can already be at the boundary after a busy animation frame.
        let bufferEnd=uninterruptedEnd(state.manifest.nodes,state.path,d);
        if(bufferEnd<lastDepth && movie.currentTime>=clock.moments[bufferEnd].end-.75)
          bufferEnd=uninterruptedEnd(state.manifest.nodes,state.path,bufferEnd+1);
        for(let appendDepth=0;appendDepth<=bufferEnd;appendDepth++) {
          if(committed.current.has(appendDepth))continue;
          const route = state.path;
          committed.current.add(appendDepth);
          const candidate = state.manifest.nodes.find(n => n.id === route[appendDepth]);
          if (!candidate) return;
          const engine = player.current, token = serial.current;
          enginePath.current[appendDepth] = candidate.id;
          void engine?.append(candidate, appendDepth, clock.moments[appendDepth].start, candidate.duration).then(() => {if (player.current === engine && appendDepth === route.length - 1) engine.finish();})
            .catch(e => {if (serial.current === token) {committed.current.delete(appendDepth); pendingPlay.current=false;running.current=false;movie.pause();setPhase('paused');setError(e.message);}});
        }
      }
    };
    const tick = (now: number) => {
      pump();
      const movie=video.current,state=latest.current;
      if(running.current && movie && now-lastUpdate>30) {
        const cursor=locate(timelineFor(state.manifest?.nodes || noNodes,state.path),movie.currentTime),t=cursor.time,d=cursor.depth;
        setTime(t);lastUpdate=now;
        setVisited(previous=>previous.includes(state.path[d])?previous:[...previous,state.path[d]]);
      }
      raf = requestAnimationFrame(tick);
    };
    const interval=setInterval(pump,120);
    raf = requestAnimationFrame(tick);
    return () => {cancelAnimationFrame(raf);clearInterval(interval);};
  }, []);

  async function begin(newPath: string[], seconds: number, play: boolean) {
    if (!manifest || !video.current) return;
    if (!StoryPlayer.supported(manifest.codec)) {setError('Continuous playback needs Chrome or Edge. You can still explore every frame in the tree.'); return;}
    const clock = timelineFor(manifest.nodes, newPath), cursor = locate(clock, seconds);
    const lastDepth = newPath.length - 1, totalDuration = clock.total;
    const token = ++serial.current, selectedDepth = cursor.depth;
    running.current = false; video.current.pause(); pendingPlay.current = play; preparing.current = true;
    seekAbort.current?.abort(); const controller = new AbortController(); seekAbort.current = controller;
    // Rewind in the existing buffer whenever its committed scenes still match.
    // Only a different, already-buffered branch needs a fresh MediaSource.
    const reusable = player.current?.available && enginePath.current.length === newPath.length && [...committed.current].every(d => enginePath.current[d] === newPath[d]);
    if (!reusable) {player.current?.destroy(); player.current = null; committed.current = new Set(); prefetched.current = new Set();}
    setPath(newPath); latest.current.path = newPath; latest.current.time = seconds; setTime(seconds); setPhase('preparing'); setError('');
    const engine = player.current || new StoryPlayer(video.current, manifest.codec, totalDuration, 2); player.current = engine;
    enginePath.current = [...newPath];
    try {
      // Seeking near the final frame needs the next segment's samples too.
      // Otherwise some browsers never fire seeked and play() stays pending.
      await engine.setDuration(totalDuration);
      let bufferedDepth=uninterruptedEnd(manifest.nodes,newPath,selectedDepth);
      if(bufferedDepth<lastDepth && seconds>=clock.moments[bufferedDepth].end-.75)
        bufferedDepth=uninterruptedEnd(manifest.nodes,newPath,bufferedDepth+1);
      engine.prefetch(decisionFrontier(manifest.nodes,newPath,selectedDepth));
      for (let d = 0; d <= bufferedDepth; d++) {
        const n = manifest.nodes.find(item => item.id === newPath[d])!;
        if (n.status !== 'ready') throw Error('This branch has not finished generating yet.');
        committed.current.add(d); await engine.append(n, d, clock.moments[d].start, n.duration);
        if (serial.current !== token) return;
      }
      if (bufferedDepth === lastDepth) engine.finish();
      const movie = video.current;
      movie.defaultPlaybackRate=playbackRate;movie.playbackRate=playbackRate;movie.preservesPitch=true;
      const target = Math.min(totalDuration - .001, seconds + .001);
      await new Promise<void>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout>;
        const cleanup = () => {clearTimeout(timeout); movie.removeEventListener('seeked', done); controller.signal.removeEventListener('abort', cancelled);};
        const done = () => {cleanup(); resolve();};
        const cancelled = () => {cleanup(); reject(Error('Seek replaced.'));};
        movie.addEventListener('seeked', done, {once:true}); controller.signal.addEventListener('abort', cancelled, {once:true});
        timeout = setTimeout(() => {cleanup(); reject(Error('The frame did not load. Try selecting it again.'));}, 8000);
        movie.currentTime = target;
        if (!movie.seeking && movie.readyState >= 2) done();
      });
      if (serial.current !== token) return;
      preparing.current = false;
      if (pendingPlay.current) {await movie.play(); if (serial.current !== token) return; running.current = true; setPhase('playing');}
      else setPhase('paused');
    } catch (e) {if (serial.current === token) {preparing.current=false;pendingPlay.current=false;running.current=false;engine.destroy();player.current=null;committed.current=new Set();enginePath.current=[];setPhase('paused');setError(e instanceof Error ? e.message : 'Playback could not start.');}}
  }
  function pause() {pendingPlay.current = false; video.current?.pause(); running.current = false; if (phase === 'playing') setPhase('paused');}
  function toggle() {
    if (preparing.current) {pendingPlay.current = true; return;}
    if (phase === 'idle' || phase === 'complete') {void begin(path, 0, true); return;}
    if (!player.current?.available || video.current?.error) {void begin(path, time, true); return;}
    if (running.current && !video.current?.paused) pause();
    else {const token = serial.current;pendingPlay.current=true;setError('');void video.current?.play().then(() => {if(serial.current === token) {running.current=true;setPhase('playing');}}).catch(() => {if(serial.current === token) {pendingPlay.current=false;setError('Press play to continue.');}});}
  }
  function inspect(point: TimePoint) {
    if (!manifest) return;
    const selected = manifest.nodes.find(n => n.id === point.id);
    if (!selected) return;
    touched.current = true;
    // Seeking back within your route preserves the choices already made.
    const newPath = path.includes(selected.id) ? [...path] : pathThrough(manifest.nodes, selected.id, preferred, path);
    const same = path[depth] === point.id;
    if (!same || Math.abs(frame - point.frame) > 12) setJumps(previous => [...previous, {from: {id: path[depth], frame}, to: point}]);
    setVisited(previous => previous.includes(selected.id) ? previous : [...previous, selected.id]);
    setFocus(value => value + 1);
    void begin(newPath, timelineFor(manifest.nodes,newPath).moments[newPath.indexOf(selected.id)].start + Math.max(0, Math.min(framesIn(selected)-1, point.frame)) / 24, false);
  }
  function choose(id: string) {
    if (!manifest || (phase === 'playing' && choiceLocked)) return;
    touched.current = true;
    const retained = path.slice(0,fork.depth+1);
    const future = pathThrough(manifest.nodes, id, preferred);
    const newPath = next.some(n => n.id === id) ? [...retained,...future.slice(future.indexOf(id))] : future;
    setPath(newPath); latest.current.path = newPath;
    if (phase === 'paused') void begin(newPath, time, false);
    else if (player.current) void player.current.setDuration(timelineFor(manifest.nodes,newPath).total).catch(e=>setError(e.message));
  }
  function shuffle() {
    if (!manifest) return;
    const current = latest.current;
    const passage = randomPassage(manifest.nodes, current.path, Math.random, manifest.randomPaths);
    if (!passage) return;
    touched.current = true;
    setJumps([]); setVisited([passage.path[0]]); setRestart(value => value + 1);
    void begin(passage.path, 0, true);
  }
  function stepFrame(direction: number) {
    const target = Math.min(Math.round(duration * 24) - 1, Math.max(0, Math.floor(time * 24 + 1e-7) + direction));
    const cursor = locate(timeline, target / 24);
    inspect({id: path[cursor.depth], frame: cursor.frame});
  }
  useEffect(() => {
    if (!manifest || entryOpened.current) return;
    entryOpened.current = true;
    const id = new URLSearchParams(window.location.search).get('scene');
    if (id && manifest.nodes.some(n => n.id === id)) inspect({id, frame: 0});
  }, [manifest]);
  useEffect(() => {if (video.current) video.current.muted = muted;}, [muted]);
  useEffect(() => {if(video.current){video.current.defaultPlaybackRate=playbackRate;video.current.playbackRate=playbackRate;video.current.preservesPitch=true;}},[playbackRate,manifest]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('button,a,input')) return;
      if (e.code === 'Space') {e.preventDefault(); toggle();}
      if (e.code === 'ArrowLeft') {e.preventDefault(); stepFrame(-1);}
      if (e.code === 'ArrowRight') {e.preventDefault(); stepFrame(1);}
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });

  return <main className={'time-app ' + (cinema ? 'time-cinema' : '')} data-phase={phase}>
    <ExperienceNav current="stories" />
    {!manifest ? <div className="time-loading">{error || 'Opening…'}</div> : <>
      <section className="time-workspace" ref={stage}>
        <section className="time-map" aria-label="Scene network">
          <TimeSpace nodes={manifest.nodes} classic={manifest.layout==='classic'} city={manifest.layout==='city'} connections={connections} selected={path[depth]} frame={frame} path={path} visited={visited} jumps={jumps} playing={phase === 'playing'} focus={focus} restart={restart} media={video} onPick={inspect} onPause={pause}/>
        </section>
        <aside className="time-inspector">
          <div className="time-viewer">
            <div className="time-film" aria-busy={phase === 'preparing'}>
              <video ref={video} playsInline muted={muted} preload="auto" poster={node?.frame || undefined}
                onEnded={() => {running.current=false;pendingPlay.current=false;setPhase('complete');setTime(duration);}}
                onError={() => {if (!preparing.current) setError('This video could not be played. Select a frame to reopen it.');}}/>
              {phase==='complete'&&node?.finalImage&&<img className="time-final-image" src={node.finalImage} alt="The shared final frame"/>}
              {(phase === 'idle' || phase === 'paused') && <button className="time-start" disabled={!ready} onClick={toggle} aria-label="Play this path"><Play size={28}/></button>}
              {phase === 'preparing' && <span className="time-buffering" aria-label="Loading frame"/>}
              <div className="time-video-progress"><i style={{transform: `scaleX(${progress})`}}/></div>
            </div>
            <div className="time-transport">
              <button onClick={() => stepFrame(-1)} aria-label="Previous frame" title="Previous frame"><ChevronLeft size={18}/></button>
              <button onClick={toggle} aria-label={phase === 'playing' ? 'Pause' : 'Play'} title="Play / pause" disabled={!ready}>{phase === 'playing' ? <Pause size={20}/> : <Play size={20}/>}</button>
              <button onClick={() => stepFrame(1)} aria-label="Next frame" title="Next frame"><ChevronRight size={18}/></button>
              <span aria-live="off">{(time/playbackRate).toFixed(2)} <small>/ {(duration/playbackRate).toFixed(2)}s</small></span>
              <button className="time-speed" onClick={()=>setPlaybackRate(rate=>rate===1?2:1)} aria-label={`Playback speed ${playbackRate}×`} title="Playback speed">{playbackRate}×</button>
              <button aria-label="Random" title={manifest.randomPaths?'Start a reviewed path from the beginning':'Start a new path from the beginning'} className="time-random" onClick={shuffle} disabled={!ready||manifest.randomPaths?.length===0}><Dice5 size={17}/><span>Random</span></button>
              {!manifest.visualOnly && <button onClick={() => setMuted(v => !v)} aria-label={muted ? 'Enable sound' : 'Mute sound'} title={muted ? 'Enable sound' : 'Mute sound'}>{muted ? <VolumeX size={17}/> : <Volume2 size={17}/>}</button>}
              <button onClick={() => setCinema(v => !v)} aria-label={cinema ? 'Show the full tree' : 'Enlarge the film'} title="Resize view"><Expand size={17}/></button>
            </div>
            <div className="time-route" aria-label="Your selected scenes">{path.map((id, i) => {
              const scene = manifest.nodes.find(n => n.id === id)!;
              return <button key={id} className={i === depth ? 'active' : ''} aria-label={`Go to scene ${id.toUpperCase()}`} aria-current={i === depth ? 'step' : undefined} title={`${scene?.title} · ${(timeline.moments[i].start/playbackRate).toFixed(2)}s`} onClick={() => inspect({id, frame: 0})}><span style={{transform: `scaleX(${i < depth ? 1 : i === depth ? progress : 0})`}}/></button>;
            })}</div>
            <div className="time-choice-grid" aria-label="Next scenes">{next.map((n, i) => <button key={n.id} className={path[fork.depth + 1] === n.id ? 'chosen' : ''} aria-label={`Choose ${n.id.toUpperCase()}: ${n.title}`} aria-pressed={path[fork.depth + 1] === n.id} title={`${n.title}${decision && Number.isFinite(decision.probabilities[n.id]) ? ` · Jev ${Math.round(decision.probabilities[n.id] * 100)}%` : ''}`} disabled={(phase === 'playing' && choiceLocked) || phase === 'preparing' || n.status !== 'ready'} onClick={() => choose(n.id)}>
              {n.frame && <img src={n.frame} alt=""/>}<span><em>{n.title}</em>{path[fork.depth + 1] === n.id && <Check size={15}/>}</span>
            </button>)}</div>
            {error && <p className="time-error" role="status">{error}</p>}
          </div>
        </aside>
      </section>
      <section className="time-filmstrip">
        <button className="time-reset" title="Start over" aria-label="Start over" onClick={() => {setVisited([path[0]]); inspect({id: path[0], frame: 0}); setJumps([]);}}><RotateCcw size={16}/></button>
        <div className="time-strip" ref={strip} aria-label="Every frame of the selected scene">{Array.from({length: framesIn(node)}, (_, f) => <button key={node?.id + ':' + f} className={f === frame ? 'selected' : ''} aria-label={`Go to frame ${f + 1}, ${((moment.start + f / 24)/playbackRate).toFixed(2)} seconds`} aria-current={f === frame ? 'true' : undefined} onClick={() => inspect({id: path[depth], frame: f})}>
          <span className="time-thumb" style={{backgroundImage: node?.atlas ? `url(${node.atlas})` : undefined, backgroundSize: `800% ${atlasRows(node)*100}%`, backgroundPosition: `${f % 8 / 7 * 100}% ${Math.floor(f / 8) / Math.max(1,atlasRows(node)-1) * 100}%`}}/><span>{((moment.start + f / 24)/playbackRate).toFixed(2)}s</span>
        </button>)}</div>
      </section>
    </>}
  </main>;
}
