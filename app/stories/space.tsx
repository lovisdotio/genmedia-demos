'use client';
import {useEffect, useRef, useState, type RefObject} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {Line2} from 'three/addons/lines/Line2.js';
import {LineGeometry} from 'three/addons/lines/LineGeometry.js';
import {LineMaterial} from 'three/addons/lines/LineMaterial.js';
import {Focus, GitBranch, Scan, RotateCcw, Waves} from 'lucide-react';
import {pathThrough, revealFrontier, type BranchLink, type TimeJump, type TimeNode, type TimePoint} from './types';
import {atlasRows, framesIn, locate, timelineFor} from './timing';
import actionCutouts from './action-cutouts.json';
import {classicCurve} from './classic-geometry';
import {boundCityCurve, cityArrival, cityCurve} from './city-geometry';

const cutoutByTitle: Record<string,{image:string;sourceScene:string;size:number[];bounds:number[]}> = actionCutouts.byTitle;

type Props = {nodes: TimeNode[]; classic?:boolean; city?:boolean; connections: BranchLink[]; selected: string; frame: number; path: string[];
  visited: string[]; jumps: TimeJump[]; playing: boolean; focus: number; restart: number; media: RefObject<HTMLVideoElement | null>;
  onPick: (point: TimePoint) => void; onPause: () => void};
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
// Preserve the branching layout while letting time recede into the scene.
const depthSpace = (point: THREE.Vector3) => v(point.x * .8, point.z * .9, -point.y * 1.12 - 25);
const arrivalCache=new WeakMap<TimeNode[],{ranks:Map<string,number>;z:number}>();
const visualDepth=(depth:number)=>depth<=6?depth:6+(depth-6)*.34;
// The complete route sits inside two rounded volumes, rather than extending
// each new two-second segment farther down an ever-growing straight axis.
// Handles are shared at joins, including the two filmed return passages.
const storyShape:Record<string,{point:[number,number,number];handle:[number,number,number]}>= {
  root:{point:[0,-45,80],handle:[-2,7,-10]},
  a:{point:[-5,-22,54],handle:[-2,8,-9]},
  a1:{point:[-10,1,24],handle:[0,8,-10]},
  a14:{point:[-8,22,-7],handle:[2,6,-10]},
  a14r:{point:[0,35,-35],handle:[0,20,-62]},
  a14r1:{point:[-240,100,-100],handle:[-35,-40,-15]},
  a14r1t:{point:[-225,-70,-190],handle:[35,-40,-30]},
  a14r3:{point:[135,-110,-180],handle:[40,45,-25]},
  a14r3t:{point:[165,60,-285],handle:[-35,30,65]},
  a14r2:{point:[40,85,-230],handle:[14,-1,-32]},
  a14r2t:{point:[90,57,-300],handle:[12,-15,-20]},
  'closing-1':{point:[105,10,-350],handle:[-2,-16,-16]},
  'closing-2':{point:[82,-35,-390],handle:[-12,-12,-11]},
  'closing-3':{point:[38,-62,-418],handle:[-17,-5,-6]},
  'closing-4':{point:[-12,-65,-433],handle:[-21,4,-5]},
  'late-orbit-1':{point:[-135,65,-460],handle:[16,37,-20]},
  'late-orbit-2':{point:[35,65,-510],handle:[32,-18,6]},
  'late-drop-1':{point:[-80,-172,-405],handle:[36,-3,-23]},
  'late-4':{point:[103,-8,-495],handle:[7,-24,10]},
  'late-5':{point:[76,-65,-467],handle:[-20,-12,8]},
  'late-6':{point:[10,-78,-446],handle:[-22,3,5]},
  'late-7':{point:[-49,-59,-434],handle:[-17,9,3]},
};
function arrivals(nodes:TimeNode[]) {
  let layout=arrivalCache.get(nodes);
  if(!layout) {
    const generated=nodes.filter(n=>!n.finalization);
    const parents=new Set(generated.map(n=>n.parent));
    const terminal=generated.filter(n=>!parents.has(n.id)&&!n.rejoinTarget).sort((a,b)=>a.id.localeCompare(b.id));
    layout={ranks:new Map(terminal.map((node,i)=>[node.id,i])),z:-425};
    arrivalCache.set(nodes,layout);
  }
  return layout;
}
type FinalAnchor = {hold: TimeNode; point: THREE.Vector3};
const finalAnchorCache = new WeakMap<TimeNode[], Map<string, FinalAnchor>>();
function finalAnchors(nodes: TimeNode[]) {
  let anchors = finalAnchorCache.get(nodes);
  if (!anchors) {
    anchors = new Map();
    for (const hold of nodes.filter(node => node.finalization === 'hold')) {
      const parent = nodes.find(node => node.id === hold.parent);
      // A still hold occupies its parent's final point, never another time-axis
      // segment. Prefer the established rounded route in both archive variants.
      const point = (parent && storyShape[parent.id]?.point) || parent?.storyPosition
        || hold.storyPosition || [0, -16, -450] as [number, number, number];
      anchors.set(hold.id, {hold, point: v(...point)});
    }
    finalAnchorCache.set(nodes, anchors);
  }
  return anchors;
}
function finalAtTip(node: TimeNode, nodes: TimeNode[]): FinalAnchor | undefined {
  const anchors = finalAnchors(nodes);
  return anchors.get(node.id) || (node.rejoinTarget ? anchors.get(node.rejoinTarget) : undefined)
    || [...anchors.values()].find(anchor => anchor.hold.parent === node.id);
}
function arrivalRoute(node: TimeNode, nodes: TimeNode[]) {
  const chain = [node], seen = new Set([node.id]);
  let current = node;
  while (current.parent) {
    const parent = nodes.find(candidate => candidate.id === current.parent);
    if (!parent || parent.finalization !== 'arrival' || parent.arrivalFrom !== node.arrivalFrom || seen.has(parent.id)) break;
    chain.unshift(parent); seen.add(parent.id); current = parent;
  }
  current = node;
  while (!current.rejoinTarget) {
    const child = nodes.find(candidate => candidate.parent === current.id && candidate.finalization === 'arrival'
      && candidate.arrivalFrom === node.arrivalFrom && !seen.has(candidate.id));
    if (!child) break;
    chain.push(child); seen.add(child.id); current = child;
  }
  const target = chain.at(-1)?.rejoinTarget;
  return {chain, anchor: target ? finalAnchors(nodes).get(target) : undefined};
}
function tip(node: TimeNode, nodes: TimeNode[]):THREE.Vector3 {
  if(node.storyPosition&&node.storyHandle)return v(...node.storyPosition);
  const final = finalAtTip(node, nodes);
  if (final) return final.point.clone();
  if (node.rejoinTarget) {
    const target = nodes.find(n => n.id === node.rejoinTarget);
    const parent = nodes.find(n => n.id === target?.parent);
    if (parent) return tip(parent,nodes);
  }
  if(node.finalization==='arrival'&&node.arrivalFrom) {
    const source=nodes.find(n=>n.id===node.arrivalFrom);
    const {chain,anchor}=arrivalRoute(node,nodes);
    if(source&&anchor) {
      const at=tip(source,nodes),destination=anchor.point;
      const fraction=(chain.indexOf(node)+1)/chain.length;
      const delta=at.clone().sub(destination),distance=delta.length();
      const side=v(delta.y,-delta.x,0);
      if(side.lengthSq()<1e-8)side.set(1,0,0);
      const round=Math.sin(Math.PI*fraction);
      // A bounded lateral arc cannot create a large hook on a short arrival.
      return at.lerp(destination,fraction).addScaledVector(side.normalize(),round*Math.min(18,distance*.16))
        .add(v(0,0,-round*Math.min(8,distance*.08)));
    }
  }
  if(node.storyPosition)return v(...(storyShape[node.id]?.point||node.storyPosition));
  const arrival=arrivals(nodes),rank=arrival.ranks.get(node.id);
  if(rank!==undefined) {
    // Different recorded endings occupy one arrival region, without asserting
    // that they share media. Short branches also reach this final visual stage.
    const angle=rank/arrival.ranks.size*Math.PI*2;
    return v(Math.sin(angle)*28,Math.cos(angle)*26-16,arrival.z+Math.sin(angle*2)*10);
  }
  if (node.sharedEnding) return v(0, 7, -300);
  if (!node.parent) return depthSpace(v(0, -35, 0));
  const choices: number[] = []; let current: TimeNode | undefined = node;
  while (current?.parent) {choices.unshift(current.choice); current = nodes.find(n => n.id === current!.parent);}
  if (node.depth > 3) {
    const stage=visualDepth(node.depth);
    const index = choices.slice(0,3).reduce((acc,c)=>acc*4+c,0);
    const turn = choices[4] === undefined ? 0 : (choices[4]-1.5)*.3;
    const angle = -Math.PI*.88+(index+.5)/64*Math.PI*1.76+(stage-3)*.32+turn;
    // Open the middle, then gradually narrow the later stages toward arrivals.
    const radius = Math.max(24,180-(stage-4)*32);
    return v(Math.sin(angle)*radius,Math.cos(angle)*radius*.95-(stage-3)*3,-205-(1-Math.exp(-(stage-3)/3.1))*226);
  }
  const index = choices.reduce((acc, c) => acc * 4 + c, 0), count = 4 ** node.depth;
  const angle = -Math.PI * .88 + (index + .5) / count * Math.PI * 1.76;
  const radius = [0, 72, 155, 215][node.depth];
  return depthSpace(v(Math.sin(angle) * radius, node.depth * 62 - 35 + (node.depth === 3 ? Math.sin(angle * 3) * 9 : 0), Math.cos(angle) * radius * .8));
}

function curveFor(node: TimeNode, nodes: TimeNode[]):THREE.CubicBezierCurve3 {
  if(node.storyPosition&&node.storyStartPosition&&node.storyControl1&&node.storyControl2) {
    // Exact native-time subcurves: absolute controls must not be rescaled.
    return new THREE.CubicBezierCurve3(v(...node.storyStartPosition),v(...node.storyControl1),v(...node.storyControl2),v(...node.storyPosition));
  }
  if(node.storyPosition&&node.storyHandle) {
    const parent=nodes.find(n=>n.id===node.parent);
    const end=v(...node.storyPosition);
    const start=parent?tip(parent,nodes):v(...(node.storyStartPosition||node.storyPosition));
    // Stored handles use a two-second reference interval. Scale BOTH controls
    // by this window's real duration, preserving velocity through native joins.
    const scale=node.duration/2;
    const handle=parent?.storyHandle?v(...parent.storyHandle).multiplyScalar(scale):v(0,0,0);
    return new THREE.CubicBezierCurve3(start,start.clone().add(handle),end.clone().sub(v(...node.storyHandle).multiplyScalar(scale)),end);
  }
  if(node.finalization==='hold') {
    const point=tip(node,nodes);
    return new THREE.CubicBezierCurve3(point.clone(),point.clone(),point.clone(),point.clone());
  }
  if(!node.parent&&node.storyPosition) {
    const end=tip(node,nodes);
    const handle=v(...storyShape.root.handle);
    return new THREE.CubicBezierCurve3(end.clone().add(v(0,-30,44)),end.clone().add(v(0,-20,30)),end.clone().sub(handle),end);
  }
  if (node.sharedEnding) return new THREE.CubicBezierCurve3(v(0,7,-240),v(-3,8,-260),v(3,7,-282),tip(node,nodes));
  if (!node.parent) return new THREE.CubicBezierCurve3(depthSpace(v(0, -94, 0)), depthSpace(v(-12, -80, 12)), depthSpace(v(7, -54, 0)), depthSpace(v(0, -35, 0)));
  const parent = nodes.find(n => n.id === node.parent)!;
  const start = tip(parent, nodes), end = tip(node, nodes);
  const parentCurve = curveFor(parent, nodes);
  // Equal handles give matching position AND velocity at a two-second boundary.
  // All forks initially share their parent's tangent before bending apart.
  const incoming = start.clone().add(parentCurve.v3.clone().sub(parentCurve.v2));
  if(finalAtTip(node,nodes)) {
    // Ease to rest at the shared photograph. The stationary hold has the same
    // zero derivative, so every incoming route is C1 continuous at this point.
    return new THREE.CubicBezierCurve3(start,incoming,end.clone(),end);
  }
  if (node.rejoinTarget) {
    const destination = nodes.find(n => n.id === node.rejoinTarget);
    const destinationParent = nodes.find(n => n.id === destination?.parent);
    const approach = destinationParent ? curveFor(destinationParent,nodes) : parentCurve;
    const outgoing = end.clone().sub(approach.v3.clone().sub(approach.v2));
    return new THREE.CubicBezierCurve3(start,incoming,outgoing,end);
  }
  if(node.storyPosition&&storyShape[node.id]) {
    return new THREE.CubicBezierCurve3(start,incoming,end.clone().sub(v(...storyShape[node.id].handle)),end);
  }
  if (node.depth > 3) {
    const children=nodes.filter(candidate=>candidate.parent===node.id&&!candidate.rejoinTarget);
    const next=children.length?children.reduce((sum,child)=>sum.add(tip(child,nodes)),v(0,0,0)).divideScalar(children.length):null;
    const handle=next?next.clone().sub(start):end.clone().sub(start);
    const length=Math.min(start.distanceTo(end),next?end.distanceTo(next):Infinity)*.3;
    handle.normalize().multiplyScalar(length);
    return new THREE.CubicBezierCurve3(start,incoming,end.clone().sub(handle),end);
  }
  return new THREE.CubicBezierCurve3(start, incoming, end.clone().add(v(-Math.sign(end.x - start.x) * 5.5, -1.6, 24)), end);
}

export default function TimeSpace(props: Props) {
  const host = useRef<HTMLDivElement>(null), latest = useRef(props); latest.current = props;
  const mode = useRef<'tree' | 'follow' | 'free' | 'point'>('tree');
  const [view, setView] = useState('tree'), [error, setError] = useState(''), [showLinks, setShowLinks] = useState(true);
  const linksVisible = useRef(true);
  const [progressive, setProgressive] = useState(true);
  const progressiveMode = useRef(true), revealed = useRef(new Map<string, number>());
  const revealCount = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState<{node: TimeNode; frame: number; x: number; y: number} | null>(null);
  const [hoverLink, setHoverLink] = useState<{target: TimePoint; label: string; x: number; y: number} | null>(null);
  const command = useRef(0);

  useEffect(() => {
    const mount = host.current!;
    if(props.frame===0&&!props.nodes.find(n=>n.id===props.selected)?.parent)revealed.current.clear();
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({antialias: true, alpha: true}); }
    catch { setError('3D is unavailable in this browser. The frame strip below still lets you explore every moment.'); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, .1, 4000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = .075;
    controls.minDistance = 7; controls.maxDistance = 2200;
    const resources: {dispose: () => void}[] = [];
    const keep = <T extends {dispose: () => void}>(item: T): T => {resources.push(item); return item;};
    const loader = new THREE.TextureLoader(), maps = new Map<string, THREE.Texture>();
    const textureWarmQueue: THREE.Texture[] = [];
    let disposed = false;
    const lineMaterials: LineMaterial[] = [];
    const texture = (url: string) => {
      if (!maps.has(url)) { const map = keep(loader.load(url, loaded => {if(!disposed)textureWarmQueue.push(loaded);})); map.colorSpace = THREE.SRGBColorSpace;
        map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); maps.set(url, map); }
      return maps.get(url)!;
    };
    function line(points: THREE.Vector3[], opacity: number, width: number, dashed = false) {
      const geometry = keep(new LineGeometry()); geometry.setPositions(points.flatMap(p => p.toArray()));
      const material = keep(new LineMaterial({color: 0xd9e5f5, transparent: true, opacity, linewidth: width,
        depthWrite: false, dashed, dashSize: 1.4, gapSize: 1.1}));
      material.onBeforeCompile = shader => {
        shader.vertexShader = 'varying float vRailDepth;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('vec4 mvPosition = ( position.y < 0.5 ) ? start : end;', 'vec4 mvPosition = ( position.y < 0.5 ) ? start : end; vRailDepth=-mvPosition.z;');
        shader.fragmentShader = 'varying float vRailDepth;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('gl_FragColor = vec4( diffuseColor.rgb, alpha );', 'gl_FragColor = vec4( diffuseColor.rgb, alpha * smoothstep(18.,42.,vRailDepth) );');
      };
      lineMaterials.push(material);
      const object = new Line2(geometry, material); object.computeLineDistances(); scene.add(object);
      return object;
    }
    function label(text: string, position: THREE.Vector3, width: number) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;ctx.font='28px "Courier New", monospace';
      canvas.width=Math.ceil(ctx.measureText(text).width)+24;canvas.height=48;
      ctx.font='28px "Courier New", monospace';
      ctx.fillStyle = '#d5dbe2'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, canvas.width/2, 24);
      const map = keep(new THREE.CanvasTexture(canvas)); map.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(keep(new THREE.SpriteMaterial({map, transparent: true, depthWrite: false, depthTest: false})));
      sprite.position.copy(position); sprite.scale.set(width, width*canvas.height/canvas.width, 1); scene.add(sprite); return sprite;
    }
    type Track = {node: TimeNode; curve: THREE.CubicBezierCurve3; baseCurve: THREE.CubicBezierCurve3; images: THREE.InstancedMesh | null; rail: Line2; end: THREE.Sprite; dot: THREE.Mesh;
      positions: THREE.Vector3[]; rotations: THREE.Quaternion[]; matrices: THREE.Matrix4[]; slotFrames: number[];
      frameUniform: {value: number}; pulseUniform: {value: number}; revealUniform: {value: number};
      sampleUniform: {value: number}; stride: number; sampleLimit: number; sortDirty: boolean;
      reveal: number; railReveal: number; lift: number; appliedStart: number; appliedEnd: number};
    const tracks: Track[] = [], hitTargets: THREE.Object3D[] = [];
    const dotGeo = keep(new THREE.SphereGeometry(.65, 12, 10));
    for (const node of props.nodes) {
      const count = framesIn(node), rows = atlasRows(node);
      const curve = props.city?cityCurve(node,props.nodes):props.classic?classicCurve(node,props.nodes):curveFor(node, props.nodes);
      const rail = line(curve.getPoints(160).map(point => point.add(v(0,-5,0))), .36, 1.1);
      const positions: THREE.Vector3[] = [], rotations: THREE.Quaternion[] = [], matrices: THREE.Matrix4[] = [];
      for (let f = 0; f < count; f++) {
        const t = (f + .5) / count, tangent = node.finalization==='hold' ? v(0,0,-1) : curve.getTangent(t).normalize();
        // Upright photographs, with restrained yaw: a gallery of moments in depth.
        const yaw = THREE.MathUtils.clamp(Math.atan2(-tangent.x, -tangent.z) * .32, -.38, .38);
        const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
        const position = curve.getPoint(t);
        positions.push(position); rotations.push(rotation);
        matrices.push(new THREE.Matrix4().compose(position, rotation, v(1, 1, 1)));
      }
      const frameUniform = {value: -100};
      const pulseUniform = {value: -100};
      const initialReveal = revealed.current.get(node.id) ?? (node.id === props.selected ? 1 : 0);
      const revealUniform = {value: initialReveal * count};
      const sampleUniform = {value: 1};
      const slotFrames = Array.from({length: count}, (_, i) => i);
      let images: THREE.InstancedMesh | null = null;
      if (node.atlas) {
        const geometry = keep(new THREE.PlaneGeometry(17, 9.5625));
        const tiles = new Float32Array(count * 2), indices = new Float32Array(count);
        for (let f = 0; f < count; f++) {tiles[f * 2] = f % 8; tiles[f * 2 + 1] = rows - 1 - Math.floor(f / 8); indices[f] = f;}
        geometry.setAttribute('frameTile', new THREE.InstancedBufferAttribute(tiles, 2));
        geometry.setAttribute('frameIndex', new THREE.InstancedBufferAttribute(indices, 1));
        const material = keep(new THREE.MeshBasicMaterial({map: texture(node.atlas), side: THREE.DoubleSide, transparent: true, opacity: .52, depthWrite: false}));
        material.onBeforeCompile = shader => {
          shader.uniforms.atlasGrid = {value: new THREE.Vector2(8, rows)};
          shader.uniforms.focusedFrame = frameUniform;
          shader.uniforms.pulseFrame = pulseUniform;
          shader.uniforms.revealedFrames = revealUniform;
          shader.uniforms.sampleWeight = sampleUniform;
          shader.vertexShader = 'uniform vec2 atlasGrid;\nattribute vec2 frameTile;\nattribute float frameIndex;\nvarying float vFrameIndex;\nvarying vec2 vFrameUv;\nvarying float vCameraDepth;\n' + shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = (vMapUv * .988 + .006 + frameTile) / atlasGrid;\nvFrameIndex=frameIndex;\nvFrameUv=uv;');
          shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nvCameraDepth=-mvPosition.z;');
          shader.fragmentShader = 'uniform float focusedFrame;\nuniform float pulseFrame;\nuniform float revealedFrames;\nuniform float sampleWeight;\nvarying float vFrameIndex;\nvarying vec2 vFrameUv;\nvarying float vCameraDepth;\n' + shader.fragmentShader;
          shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
            float edge = smoothstep(0.,.16,vFrameUv.x)*smoothstep(0.,.16,1.-vFrameUv.x)
              *smoothstep(0.,.14,vFrameUv.y)*smoothstep(0.,.12,1.-vFrameUv.y);
            float anchor = 1. - step(.5,mod(vFrameIndex,4.));
            float intermediate = 1. - step(.5,mod(vFrameIndex,2.));
            float emphasis = max(exp(-abs(vFrameIndex-focusedFrame)*.9),exp(-abs(vFrameIndex-pulseFrame)*.35)*.75);
            float history = focusedFrame > -1. && vFrameIndex < focusedFrame-3. ? ${props.city?'.24':'.5'} : 1.;
            float reveal = smoothstep(0.,2.,revealedFrames-vFrameIndex);
            diffuseColor.a *= reveal * edge * min(1.,sampleWeight*max((${props.city?'.045 + intermediate*.27 + anchor*.3':'.065 + intermediate*.30 + anchor*.33'})*history, emphasis*.85)) * smoothstep(${props.city?'16.,36.':'12.,28.'},vCameraDepth);
          `);
        };
        material.customProgramCacheKey = () => props.city?'city-archived-trails':'time-responsive-trails-visible-history';
        images = new THREE.InstancedMesh(geometry, material, count);
        for (let f = 0; f < count; f++) images.setMatrixAt(f, matrices[f]);
        images.instanceMatrix.needsUpdate = true; images.computeBoundingSphere(); images.userData.id = node.id;
        scene.add(images); hitTargets.push(images);
      }
      const dot = new THREE.Mesh(dotGeo, keep(new THREE.MeshBasicMaterial({color: 0xe6ebf1, transparent: true, opacity: .65})));
      dot.position.copy(curve.getPoint(1)).add(v(0,-5,0)); dot.scale.setScalar(.5); dot.userData.id = node.id; dot.userData.frame = count - 1; scene.add(dot); hitTargets.push(dot);
      const end = label(node.title, curve.getPoint(1).add(v(0, -8, 0)), 35);
      end.visible=false;
      tracks.push({node, curve, baseCurve: curve.clone(), images, rail, end, dot, positions, rotations, matrices, slotFrames,
        frameUniform, pulseUniform, revealUniform, sampleUniform, stride: 1, sampleLimit: count, sortDirty: true,
        reveal: initialReveal, railReveal: -1, lift: 0, appliedStart: 0, appliedEnd: 0});
    }
    const originLabel = label('ONE SHARED BEGINNING', depthSpace(v(0, -94, 0)).add(v(0,-7,0)), 43);
    // One clear, fully exposed photograph marks the current moment among the trails.
    const activePhotoMaterial = keep(new THREE.ShaderMaterial({
      uniforms: {atlas: {value: null}, tile: {value: new THREE.Vector2()}, grid: {value: new THREE.Vector2(8,6)}},
      vertexShader: 'varying vec2 photoUv; void main(){photoUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `uniform sampler2D atlas; uniform vec2 tile; uniform vec2 grid; varying vec2 photoUv;
        void main(){vec4 photo=texture2D(atlas,(photoUv*.988+.006+tile)/grid);
          float edge=smoothstep(0.,.025,photoUv.x)*smoothstep(0.,.025,1.-photoUv.x)*smoothstep(0.,.04,photoUv.y)*smoothstep(0.,.04,1.-photoUv.y);
          gl_FragColor=vec4(photo.rgb,edge*.96);
          #include <colorspace_fragment>
        }`,
      side: THREE.DoubleSide, transparent: true, depthWrite: false, depthTest: false,
    }));
    const activePhoto = new THREE.Mesh(keep(new THREE.PlaneGeometry(17,9.5625)),activePhotoMaterial);
    activePhoto.renderOrder=498;scene.add(activePhoto);
    const corners = new THREE.BufferGeometry().setFromPoints([
      v(-8.7,-3.8,0),v(-8.7,-4.95,0),v(-8.7,-4.95,0),v(-7.4,-4.95,0),
      v(8.7,-3.8,0),v(8.7,-4.95,0),v(8.7,-4.95,0),v(7.4,-4.95,0),
      v(-8.7,3.8,0),v(-8.7,4.95,0),v(-8.7,4.95,0),v(-7.4,4.95,0),
      v(8.7,3.8,0),v(8.7,4.95,0),v(8.7,4.95,0),v(7.4,4.95,0),
    ]);
    const activeCorners = new THREE.LineSegments(keep(corners),keep(new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.8,depthTest:false})));
    activeCorners.renderOrder=499;scene.add(activeCorners);
    const activeCurve = line([v(0, 0, 0), v(0, .1, 0)], .95, 2.2);
    const marker = new THREE.Mesh(keep(new THREE.SphereGeometry(.23, 20, 16)), keep(new THREE.MeshBasicMaterial({color: 0xffffff, depthTest: false})));
    marker.renderOrder = 500; scene.add(marker);
    const halo = new THREE.Mesh(keep(new THREE.RingGeometry(.56, .63, 48)), keep(new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: .65, side: THREE.DoubleSide, depthTest: false})));
    halo.renderOrder = 501; scene.add(halo);
    const handoffMaterial = keep(new THREE.MeshBasicMaterial({color:0xf2f7ff,transparent:true,opacity:0,side:THREE.DoubleSide,depthTest:false,depthWrite:false}));
    const handoffRing = new THREE.Mesh(keep(new THREE.RingGeometry(.945,1,80)),handoffMaterial);
    handoffRing.visible=false;handoffRing.renderOrder=502;scene.add(handoffRing);
    const trackById = new Map(tracks.map(track => [track.node.id, track]));
    const cityEnding=props.city?cityArrival(props.nodes):null;
    const siblingCounts = new Map<string | null, number>();
    for (const track of tracks) siblingCounts.set(track.node.parent, (siblingCounts.get(track.node.parent) || 0) + 1);
    function endpointLift(track: Track): number {
      // Selection can lift a route, but each ending's own destination stays fixed.
      if(cityEnding?.ids.has(track.node.id))return 0;
      const final=finalAtTip(track.node,props.nodes);
      if(final)return trackById.get(final.hold.id)?.lift ?? track.lift;
      const targetParent=track.node.rejoinTarget ? trackById.get(track.node.rejoinTarget)?.node.parent : null;
      return targetParent ? trackById.get(targetParent)?.lift ?? track.lift : track.lift;
    }
    function endpointLifts(track: Track) {
      const end=endpointLift(track);
      const parent=track.node.parent ? trackById.get(track.node.parent) : undefined;
      // All final arrivals and the still hold share the very same animated
      // anchor, even when only one of those routes belongs to the selected path.
      return {start:track.node.finalization==='hold' ? end : parent ? endpointLift(parent) : 0,end};
    }
    function movingPoint(track: Track, progress: number) {
      const point = track.baseCurve.getPoint(THREE.MathUtils.clamp(progress,0,1));
      const {start,end}=endpointLifts(track);
      point.y += THREE.MathUtils.lerp(start,end,progress*progress*(3-2*progress));
      return point;
    }
    const actionMarkers = tracks.flatMap(track=>{
      const asset=track.node.cutout||cutoutByTitle[track.node.cutoutTitle||track.node.title];
      if(!asset)return [];
      const [x0,y0,x1,y1]=asset.bounds,[width,height]=asset.size;
      const map=texture(asset.image);
      map.repeat.set((x1-x0)/width,(y1-y0)/height);map.offset.set(x0/width,1-y1/height);
      const material=keep(new THREE.SpriteMaterial({map,transparent:true,opacity:0,depthTest:false,depthWrite:false}));
      const sprite=new THREE.Sprite(material);sprite.center.set(.5,0);sprite.visible=false;sprite.renderOrder=480;
      sprite.userData.id=track.node.id;sprite.userData.frame=0;scene.add(sprite);hitTargets.push(sprite);
      track.end.userData.id=track.node.id;track.end.userData.frame=0;track.end.renderOrder=481;hitTargets.push(track.end);
      const leader=line([v(0,0,0),v(0,.01,0)],0,.7);leader.visible=false;
      const textImage=track.end.material.map!.image as HTMLCanvasElement;
      return [{track,sprite,leader,aspect:(x1-x0)/(y1-y0),labelAspect:textImage.width/textImage.height,
        opacity:0,targetOpacity:0,labelOpacity:0,targetLabelOpacity:0,placed:false,targetPosition:v(0,0,0),targetLabel:v(0,0,0),
        targetHeight:0,targetLabelHeight:0,anchor:v(0,0,0),offset:new THREE.Vector2(),captioned:false}];
    });
    const completeStory=props.nodes.length<80&&props.nodes.some(n=>n.storyEnding);
    const boundaries=tracks.filter(track=>track.node.id==='root'||track.node.storyEnding||track.node.finalization==='hold').map(track=>{
      const start=track.node.id==='root',text=label(start?'BEGINNING':'FINALE',v(0,0,0),24);
      text.renderOrder=485;text.userData.id=track.node.id;text.userData.frame=start?0:framesIn(track.node)-1;hitTargets.push(text);
      return {track,text,start};
    });
    const arrivalLayout=arrivals(props.nodes);
    const arrivalRegion=props.classic||props.city||completeStory||props.nodes.some(n=>n.finalization==='hold')?null:{
      ring:line(Array.from({length:81},(_,i)=>{const angle=i/80*Math.PI*2;return v(Math.sin(angle)*39,Math.cos(angle)*35-16,arrivalLayout.z);}),.24,.8),
      text:label('ARRIVALS',v(0,-67,arrivalLayout.z),28),
    };
    let actionLayoutTime=-1000;
    const positionOf = (point: TimePoint) => trackById.get(point.id)!.positions[Math.min(framesIn(trackById.get(point.id)!.node)-1, point.frame)].clone();
    const bridgeGeo = keep(new THREE.OctahedronGeometry(.6));
    const connections=props.connections.filter(link=>trackById.has(link.from.id)&&trackById.has(link.to.id));
    const bridges = connections.map((link, index) => {
      const a = positionOf(link.from).add(v(0,-5,0)), b = positionOf(link.to).add(v(0,-5,0));
      const lift = link.kind === 'rejoin' ? v((index % 2 ? 1 : -1) * 24, 22, 42)
        : v((index % 2 ? 1 : -1) * 12, 10, 22 + (index % 3) * 9);
      const side = index % 2 ? 1 : -1;
      const curve = link.featured
        ? new THREE.CubicBezierCurve3(a, a.clone().add(v(side*90,-70,-55)), b.clone().add(v(side*110,-55,45)), b)
        : link.kind === 'ending'
        ? new THREE.CubicBezierCurve3(a, a.clone().add(v(0,8,-32)), b.clone().add(v(a.x*.28,a.y*.15,32)), b)
        : link.kind === 'loop'
        ? new THREE.CubicBezierCurve3(a, a.clone().add(v(side*34,24,-24)), b.clone().add(v(side*38,18,-28)), b)
        : link.kind === 'shortcut'
        ? new THREE.CubicBezierCurve3(a, a.clone().add(v(side*22,-22,-30)), b.clone().add(v(-side*14,-16,28)), b)
        : new THREE.CubicBezierCurve3(a, a.clone().lerp(b,.3).add(lift), a.clone().lerp(b,.7).add(lift), b);
      if(props.city)boundCityCurve(curve,props.nodes);
      const rail = line(curve.getPoints(64), 0, 1.15, true);
      const material = keep(new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: .55, wireframe: true, depthWrite: false}));
      const handle = new THREE.Mesh(bridgeGeo, material); handle.position.copy(curve.getPoint(.5)); handle.userData.link = link;
      scene.add(handle); hitTargets.push(handle);
      const dot = new THREE.Mesh(dotGeo, keep(new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: .65, depthWrite: false})));
      dot.scale.setScalar(.45); scene.add(dot);
      return {link, curve, baseCurve: curve.clone(), rail, handle, dot};
    });
    const junctionIds = [...new Set(connections.filter(link => link.kind === 'rejoin' || link.kind === 'ending').map(link => link.to.id))];
    const junctions = junctionIds.map((id, i) => {
      const position = positionOf({id, frame: 0}).add(v(0,-5,0));
      const mesh = new THREE.Mesh(keep(new THREE.RingGeometry(.56, .68, 32)), keep(new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: .72, side: THREE.DoubleSide, depthWrite: false})));
      mesh.position.copy(position); mesh.userData.id=id; mesh.userData.frame=0; scene.add(mesh); hitTargets.push(mesh);
      const title = label(trackById.get(id)?.node.sharedEnding ? 'ALL PATHS / ONE ENDING' : `REJOIN ${id.toUpperCase()}`, position.clone().add(v(i%2 ? 15 : -15,-5,3)), 20);
      return {id, mesh, title, labelOffset: title.position.clone().sub(position)};
    });
    type TravelLeg = {from: TimePoint; to: TimePoint; curve?: THREE.CubicBezierCurve3; reverse?: boolean};
    const travelGraph = new Map<string, TravelLeg[]>();
    function addTravel(leg: TravelLeg) {
      if (!trackById.has(leg.from.id)||!trackById.has(leg.to.id)) return;
      travelGraph.set(leg.from.id,[...(travelGraph.get(leg.from.id)||[]),leg]);
      travelGraph.set(leg.to.id,[...(travelGraph.get(leg.to.id)||[]),{from:leg.to,to:leg.from,curve:leg.curve,reverse:true}]);
    }
    for (const track of tracks) if (track.node.parent) addTravel({from:{id:track.node.parent,frame:framesIn(trackById.get(track.node.parent)?.node)-1},to:{id:track.node.id,frame:0}});
    for (const track of tracks) if (track.node.rejoinTarget) addTravel({from:{id:track.node.id,frame:framesIn(track.node)-1},to:{id:track.node.rejoinTarget,frame:0}});
    for (const bridge of bridges) addTravel({from:bridge.link.from,to:bridge.link.to,curve:bridge.curve});
    function journey(jump: TimeJump) {
      // History can outlive a removed scene or a graph refresh. Never animate
      // against a curve belonging to a different renderer snapshot.
      if (!trackById.has(jump.from.id)||!trackById.has(jump.to.id)) return null;
      const queue: {id:string; legs:TravelLeg[]}[] = [{id:jump.from.id,legs:[]}], seen = new Set([jump.from.id]);
      let legs: TravelLeg[] = [], found=false;
      for (let i=0;i<queue.length;i++) {
        const item=queue[i];
        if (item.id===jump.to.id) {legs=item.legs;found=true;break;}
        for (const leg of travelGraph.get(item.id)||[]) if (!seen.has(leg.to.id)) {
          seen.add(leg.to.id);queue.push({id:leg.to.id,legs:[...item.legs,leg]});
        }
      }
      if (!found) return null;
      const points: THREE.Vector3[] = [];
      const add = (point: THREE.Vector3) => {if (!points.length || points.at(-1)!.distanceToSquared(point)>.0001) points.push(point);};
      const along = (from:TimePoint,to:TimePoint) => {
        const track=trackById.get(from.id);
        if (!track) return;
        const count=Math.max(2,Math.ceil(Math.abs(to.frame-from.frame)/3));
        for(let i=0;i<=count;i++) add(track.curve.getPoint((THREE.MathUtils.lerp(from.frame,to.frame,i/count)+.5)/framesIn(track.node)));
      };
      let cursor=jump.from;
      for (const leg of legs) {
        along(cursor,leg.from);
        if (leg.curve) {const samples=leg.curve.getPoints(48);if(leg.reverse)samples.reverse();samples.forEach(point=>add(point.add(v(0,5,0))));}
        else add(positionOf(leg.to));
        cursor=leg.to;
      }
      along(cursor,jump.to);
      if (points.length<2) points.push(points[0].clone().add(v(0,0,.001)));
      return new THREE.CatmullRomCurve3(points,false,'centripetal');
    }
    let jumpLines: {jump:TimeJump; line:Line2}[] = [], jumpSignature = '';
    let trip: {jump: TimeJump; curve: THREE.CatmullRomCurve3; start: number; duration: number; offset: THREE.Vector3} | null = null;
    let sortTime = 0;
    let overviewTime=-1000;
    const overviewTarget=v(0,0,8),overviewEye=v(0,0,300);
    let layoutTime = 0, revealStatusTime = 0, revealFocus = props.focus, frontierSignature = '', frontier = new Map<string, number>();
    let signature = '', pulseStarted = -10000, engaged = false;
    let motionScene = props.selected, handoffStarted = -10000, handoffCount = 0;
    const lastSortEye = v(Infinity, Infinity, Infinity), lastSortDirection = v(0,0,0);
    let focusPoint: THREE.Vector3 | null = null, focusEye: THREE.Vector3 | null = null;
    let focusMoment = false;
    let lastFocus = props.focus, lastRestart = props.restart, lastCommand = command.current, first = true, last = performance.now();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const down = {x: 0, y: 0, moved: false};
    const ray = new THREE.Raycaster();
    function hit(event: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), camera);
      const result = ray.intersectObjects(hitTargets.filter(object => object.visible)).find(candidate => {
        if (candidate.instanceId === undefined) return true;
        const track = trackById.get(String(candidate.object.userData.id));
        if (!track || track.slotFrames[candidate.instanceId] + 1 >= track.revealUniform.value) return false;
        return -candidate.point.clone().applyMatrix4(camera.matrixWorldInverse).z > 20
          && (!candidate.uv || candidate.uv.x > .03 && candidate.uv.x < .97 && candidate.uv.y > .03 && candidate.uv.y < .97);
      });
      if (!result) return null;
      const link = result.object.userData.link as BranchLink | undefined;
      if (link) {
        const target = latest.current.selected === link.to.id ? link.from : link.to;
        return {...target, link};
      }
      const id = String(result.object.userData.id);
      if (!latest.current.nodes.some(node=>node.id===id)) return null;
      return {id, frame: result.instanceId === undefined ? Number(result.object.userData.frame ?? 0) : trackById.get(id)!.slotFrames[result.instanceId], link: undefined};
    }
    const onDown = (event: PointerEvent) => { down.x = event.clientX; down.y = event.clientY; down.moved = false; };
    const onMove = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) down.moved = true;
      if (event.buttons) {setHover(null); setHoverLink(null); return;}
      const point = hit(event), rect = mount.getBoundingClientRect();
      renderer.domElement.style.cursor = point ? 'pointer' : 'grab';
      if (point?.link) {
        setHover(null); setHoverLink({target: point, label: point.link.label,
          x: Math.min(mount.clientWidth-260,Math.max(12,event.clientX-rect.left+18)), y: Math.max(12,event.clientY-rect.top-85)});
      } else if (point) {setHoverLink(null); setHover({node: props.nodes.find(n => n.id === point.id)!, frame: point.frame,
        x: Math.min(mount.clientWidth - 254, Math.max(12, event.clientX - rect.left + 18)),
        y: Math.min(mount.clientHeight - 182, Math.max(12, event.clientY - rect.top - 165))});}
      else {setHover(null); setHoverLink(null);}
    };
    const onUp = (event: PointerEvent) => {
      if (down.moved || event.button !== 0) return;
      const point = hit(event);
      if (point) {latest.current.onPick({id:point.id,frame:point.frame}); mode.current = 'point'; setView('point'); setHover(null); setHoverLink(null);}
      else {
        latest.current.onPause();
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), controls.target);
        const target = ray.ray.intersectPlane(plane, new THREE.Vector3());
        if (target) {focusMoment=false;focusPoint = target; focusEye = camera.position.clone().add(target.clone().sub(controls.target)); mode.current = 'point'; setView('point');}
      }
    };
    const onLeave = () => {setHover(null); setHoverLink(null);};
    const onControl = () => {trip=null;mode.current = 'free'; setView('free');};
    controls.addEventListener('start', onControl);
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointerleave', onLeave);
    const resize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      renderer.setSize(mount.clientWidth, mount.clientHeight); camera.aspect = mount.clientWidth / mount.clientHeight; camera.updateProjectionMatrix();
      lineMaterials.forEach(m => m.resolution.set(mount.clientWidth, mount.clientHeight));
    };
    const observer = new ResizeObserver(resize); observer.observe(mount); resize();
    renderer.setAnimationLoop(() => {
      const now = performance.now(), dt = Math.min(.08, (now - last) / 1000); last = now;
      // Upload a few already-loaded atlases ahead of their reveal, avoiding a
      // whole new layer's first texture uploads on one animation frame.
      for(let warmed=0;warmed<2&&textureWarmQueue.length&&performance.now()-now<3;warmed++)renderer.initTexture(textureWarmQueue.shift()!);
      const state = latest.current;
      if (state.nodes!==props.nodes || state.connections!==props.connections) return;
      // Sample the media clock on every rendered frame. React's integer video
      // frame remains useful for the atlas, but must not quantize 3D motion.
      const movie = state.media.current;
      const cursor = state.playing && movie && movie.readyState >= 2 ? locate(timelineFor(state.nodes,state.path),movie.currentTime) : null;
      const routeIndex = cursor ? cursor.depth : state.path.indexOf(state.selected);
      const progress = cursor ? cursor.progress : state.frame/framesIn(trackById.get(state.selected)?.node);
      const p = cursor ? {...state,selected:state.path[routeIndex],frame:cursor.frame} : state;
      const active = tracks.find(t => t.node.id === p.selected) || tracks[0];
      if (!active) return;
      const openingOnly=progressiveMode.current&&!active.node.parent&&!active.node.sharedEnding&&(active.node.duration<=.5||(!p.playing&&p.frame===0));
      if (p.restart !== lastRestart) {
        lastRestart=p.restart;lastFocus=p.focus;revealFocus=p.focus;
        revealed.current.clear();revealed.current.set(p.selected,1);
        progressiveMode.current=true;setProgressive(true);
        trip=null;focusMoment=false;focusPoint=null;focusEye=null;
        mode.current='tree';setView('tree');setHover(null);setHoverLink(null);
        handoffStarted=-10000;motionScene=p.selected;
      }
      if (motionScene !== active.node.id) {
        motionScene=active.node.id;
        if (!first && !reduced) {
          handoffStarted=now;handoffCount++;
          mount.dataset.sceneTransition=String(handoffCount);mount.dataset.transitionActive='true';
        }
      }
      if (p.focus !== revealFocus) {
        revealFocus = p.focus;
        // Seeking restarts the presentation from this moment. The cached media
        // remains playable; only the visual preview of future scenes resets.
        const history = new Set(p.path.slice(0, p.path.indexOf(p.selected) + 1));
        for (const track of tracks) revealed.current.set(track.node.id, history.has(track.node.id) ? 1 : 0);
      }
      const nextFrontierSignature = `${p.selected}:${p.frame}:${p.path.join('|')}`;
      if (frontierSignature !== nextFrontierSignature) {
        frontierSignature = nextFrontierSignature;
        frontier = revealFrontier(props.nodes, p.selected, p.frame, p.path);
      }
      for (const track of tracks) {
        const previous = revealed.current.get(track.node.id) ?? 0;
        const target = Math.max(previous, frontier.get(track.node.id) ?? 0);
        // The next branches unfold slowly around the playhead, never on a timer
        // that races to the end of the network while the video is paused.
        const value = reduced || track === active ? target : Math.min(target, previous + dt * .65);
        revealed.current.set(track.node.id, value);
        track.reveal = progressiveMode.current ? value : 1;
        track.revealUniform.value = track.reveal * (framesIn(track.node)+2);
        if (track.images) track.images.visible = track.reveal > .001&&!(openingOnly&&track===active);
      }
      if (now - revealStatusTime > 200) {
        revealStatusTime = now;
        const count = tracks.filter(track => track.reveal >= .999).length;
        const visible = tracks.filter(track => track.reveal > .02).length;
        mount.dataset.revealedScenes = String(count); mount.dataset.visibleScenes = String(visible);
        mount.dataset.revealMode = progressiveMode.current ? 'progressive' : 'all';
        if (revealCount.current) revealCount.current.textContent = `${count} / ${tracks.length} scenes`;
      }
      const nextSignature=p.path.join('|')+':'+p.selected;
      if (signature!==nextSignature) {if(signature)engaged=true;signature=nextSignature;pulseStarted=now;}
      const ease = reduced ? 1 : 1-Math.exp(-dt*4.2);
      for (const track of tracks) {
        const lift = engaged || p.playing || p.focus>0
          ? p.path.includes(track.node.id) ? 8 : -6 : 0;
        track.lift=THREE.MathUtils.lerp(track.lift,lift,ease);
      }
      let layoutChanged=false;
      if (now-layoutTime>32) {
        layoutTime=now;
        for (const track of tracks) {
          const {start,end}=endpointLifts(track);
          if (Math.abs(start-track.appliedStart)+Math.abs(end-track.appliedEnd)<.01) continue;
          layoutChanged=true;track.sortDirty=true;track.appliedStart=start;track.appliedEnd=end;
          const {curve,baseCurve}=track;
          curve.v0.y=baseCurve.v0.y+start;curve.v1.y=baseCurve.v1.y+start;
          curve.v2.y=baseCurve.v2.y+end;curve.v3.y=baseCurve.v3.y+end;
          for(let f=0;f<framesIn(track.node);f++) {curve.getPoint((f+.5)/framesIn(track.node),track.positions[f]);track.matrices[f].setPosition(track.positions[f]);}
          if(track.images) {track.slotFrames.forEach((f,slot)=>track.images!.setMatrixAt(slot,track.matrices[f]));track.images.instanceMatrix.needsUpdate=true;track.images.computeBoundingSphere();}
          track.railReveal = -1;
          track.dot.position.copy(curve.v3).add(v(0,-5,0));
        }
        if (layoutChanged) {
          for(const bridge of bridges) {
            const a=positionOf(bridge.link.from).y-5-bridge.baseCurve.v0.y;
            const b=positionOf(bridge.link.to).y-5-bridge.baseCurve.v3.y;
            bridge.curve.v0.y=bridge.baseCurve.v0.y+a;bridge.curve.v1.y=bridge.baseCurve.v1.y+THREE.MathUtils.lerp(a,b,1/3);
            bridge.curve.v2.y=bridge.baseCurve.v2.y+THREE.MathUtils.lerp(a,b,2/3);bridge.curve.v3.y=bridge.baseCurve.v3.y+b;
            bridge.rail.geometry.setPositions(bridge.curve.getPoints(48).flatMap(point=>point.toArray()));
            bridge.rail.computeLineDistances();
            bridge.handle.position.copy(bridge.curve.getPoint(.5));
          }
          for(const junction of junctions) {junction.mesh.position.copy(positionOf({id:junction.id,frame:0})).add(v(0,-5,0));junction.title.position.copy(junction.mesh.position).add(junction.labelOffset);}
          for(const entry of jumpLines) {
            const curve=journey(entry.jump);
            if(curve) {entry.line.geometry.setPositions(curve.getPoints(120).flatMap(point=>point.add(v(0,-5,0)).toArray()));entry.line.computeLineDistances();}
          }
          if(trip) {const curve=journey(trip.jump);if(curve)trip.curve=curve;else trip=null;}
        }
      }
      const point = movingPoint(active,progress);
      activePhoto.position.copy(point);
      const openingScale=openingOnly?2.8:1;
      activePhoto.scale.lerp(v(openingScale,openingScale,openingScale),first||reduced?1:1-Math.exp(-dt*6));
      activeCorners.scale.copy(activePhoto.scale);
      const tangent=active.node.finalization==='hold' ? v(0,0,-1) : active.baseCurve.getTangent(progress).normalize();
      const yaw=THREE.MathUtils.clamp(Math.atan2(-tangent.x,-tangent.z)*.32,-.38,.38);
      const orientation=new THREE.Quaternion().setFromEuler(new THREE.Euler(0,yaw,0));
      activePhoto.quaternion.slerp(orientation,first||reduced||!p.playing?1:1-Math.exp(-dt*18));
      activeCorners.position.copy(point);activeCorners.quaternion.copy(activePhoto.quaternion);
      activePhoto.visible=Boolean(active.node.atlas);activeCorners.visible=activePhoto.visible;
      if(active.node.atlas)activePhotoMaterial.uniforms.atlas.value=texture(active.node.atlas);
      activePhotoMaterial.uniforms.tile.value.set(p.frame%8,atlasRows(active.node)-1-Math.floor(p.frame/8));
      activePhotoMaterial.uniforms.grid.value.set(8,atlasRows(active.node));
      const cameraOffset = v(14,9,34);
      if (p.focus !== lastFocus) {
        lastFocus = p.focus; focusMoment=true;mode.current = 'point'; setView('point');
      }
      if(focusMoment) {focusPoint=point.clone();focusEye=point.clone().add(cameraOffset);}
      if (command.current !== lastCommand) {lastCommand = command.current; trip=null;focusMoment=false;focusPoint = null; focusEye = null;}
      for (const track of tracks) {
        const chosen = p.path.includes(track.node.id), visited = p.visited.includes(track.node.id);
        track.rail.visible = !openingOnly&&track.reveal > .005&&track.baseCurve.v0.distanceToSquared(track.baseCurve.v3)>1e-8;
        if (Math.abs(track.reveal - track.railReveal) > .007 || track.reveal === 1 && track.railReveal !== 1) {
          track.railReveal = track.reveal;
          track.rail.geometry.setPositions(Array.from({length:65},(_,i)=>track.curve.getPoint(i/64*track.reveal).add(v(0,-5,0))).flatMap(point=>point.toArray()));
        }
        // Keep every real arrival visible, including unchosen terminal scenes.
        track.dot.visible = track.reveal > .01&&!openingOnly;
        track.dot.position.copy(track.curve.getPoint(track.reveal)).add(v(0,-5,0));
        track.dot.scale.setScalar(track.reveal < .99 ? .8 : chosen ? .65 : .38);
        track.dot.userData.frame = Math.max(0, Math.min(framesIn(track.node)-1, Math.floor(track.reveal * framesIn(track.node)) - 1));
        track.rail.material.opacity = THREE.MathUtils.lerp(track.rail.material.opacity,chosen ? .95 : visited ? .5 : .27,ease);
        track.rail.material.linewidth = THREE.MathUtils.lerp(track.rail.material.linewidth,chosen ? 1.9 : .85,ease);
        if (track.images) {
          const material=track.images.material as THREE.MeshBasicMaterial;
          const opacity=props.city
            ? track===active ? 1 : mode.current==='tree' ? chosen ? .92 : visited ? .52 : .32 : track.node.depth>active.node.depth&&chosen ? .6 : chosen ? .2 : .12
            : track===active ? 1 : mode.current==='tree' ? chosen ? .94 : visited ? .62 : .48 : track.node.depth>active.node.depth&&chosen ? .74 : chosen ? .5 : .3;
          material.opacity=THREE.MathUtils.lerp(material.opacity,opacity,ease);
        }
        track.frameUniform.value = track === active ? p.frame : -100;
        const pulse=(now-pulseStarted)/900*48-(track.node.depth-active.node.depth)*24;
        track.pulseUniform.value=!reduced&&chosen&&pulse>=-10&&pulse<=65 ? pulse : -100;
        track.sampleUniform.value=THREE.MathUtils.lerp(track.sampleUniform.value,track.stride===4?1.55:track.stride===2?1.1:1,ease);
      }
      originLabel.visible = false;
      // A short continuous wake crosses the joint instead of disappearing and
      // restarting from zero at every new scene.
      const wake: THREE.Vector3[]=[];
      const previousTrack=routeIndex>0 ? trackById.get(p.path[routeIndex-1]) : undefined;
      if (previousTrack && progress<.55) for(let i=0;i<=20;i++) wake.push(movingPoint(previousTrack,1-(.55-progress)*(1-i/20)).add(v(0,-5,0)));
      for(let i=0;i<=32;i++) wake.push(movingPoint(active,THREE.MathUtils.lerp(Math.max(0,progress-.55),progress,i/32)).add(v(0,-5,0)));
      activeCurve.geometry.setPositions(wake.flatMap(q=>q.toArray()));
      activeCurve.visible=!openingOnly&&active.baseCurve.v0.distanceToSquared(active.baseCurve.v3)>1e-8;
      marker.visible=!openingOnly;halo.visible=!openingOnly;
      mount.dataset.openingOnly=String(openingOnly);
      mount.dataset.visibleRails=String(tracks.filter(track=>track.rail.visible).length);
      marker.position.copy(point).add(v(0,-5.1,0)); halo.position.copy(marker.position); halo.quaternion.copy(camera.quaternion);
      halo.scale.setScalar(reduced ? 1 : 1 + .12 * Math.sin(now * .003));
      for (const bridge of bridges) {
        const ending = bridge.link.kind === 'ending';
        const adjacent = bridge.link.from.id === p.selected || bridge.link.to.id === p.selected && (!ending || p.path.includes(bridge.link.from.id));
        const rejoin = bridge.link.kind === 'rejoin' || ending;
        const crossLevel = bridge.link.kind === 'loop' || bridge.link.kind === 'shortcut';
        const available = trackById.get(bridge.link.from.id)!.reveal * framesIn(trackById.get(bridge.link.from.id)!.node) > bridge.link.from.frame
          && trackById.get(bridge.link.to.id)!.reveal * framesIn(trackById.get(bridge.link.to.id)!.node) > bridge.link.to.frame;
        // Do not hide a valid connection merely because the graph is dense.
        // Only its navigation handle needs to recede outside the active area.
        bridge.rail.visible = linksVisible.current && available;
        bridge.handle.visible = bridge.rail.visible && (!rejoin || Boolean(bridge.link.featured)) && (adjacent || Boolean(bridge.link.featured)&&mode.current === 'tree');
        const opacity=!available ? 0 : adjacent ? .86 : mode.current === 'tree' ? bridge.link.featured ? .52 : ending ? .3 : rejoin ? .26 : crossLevel ? .16 : .075 : bridge.link.featured ? .14 : .035;
        bridge.rail.material.opacity=THREE.MathUtils.lerp(bridge.rail.material.opacity,opacity,ease);
        bridge.rail.material.dashScale = mode.current === 'tree' ? 1 : 3;
        bridge.rail.material.linewidth = adjacent ? 1.8 : bridge.link.featured ? 1.3 : rejoin ? 1.1 : .8;
        bridge.handle.scale.lerp(v(adjacent?1.5:.65,adjacent?1.5:.65,adjacent?1.5:.65),ease);
        bridge.handle.rotation.y = reduced ? 0 : now * .00035;
        bridge.dot.visible = bridge.rail.visible && (adjacent || Boolean(bridge.link.featured));
        if (bridge.dot.visible) bridge.dot.position.copy(bridge.curve.getPoint(reduced ? .5 : (now * .00015 + bridge.link.from.frame * .013) % 1));
      }
      for (const junction of junctions) {
        const adjacent = p.selected === junction.id || props.connections.some(link => link.kind !== 'crossing' && link.to.id === junction.id && link.from.id === p.selected);
        junction.mesh.visible = linksVisible.current && trackById.get(junction.id)!.reveal > .08 && camera.position.distanceTo(junction.mesh.position)>22;
        junction.mesh.quaternion.copy(camera.quaternion);
        junction.mesh.scale.setScalar(adjacent ? 1.35 : 1);
        junction.title.visible = false;
        junction.title.material.opacity = adjacent ? 1 : .65;
        const pixel = 2 * camera.position.distanceTo(junction.title.position) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / mount.clientHeight;
        junction.title.scale.set(pixel * 250, pixel * 31.25, 1);
      }
      const validJumps=p.jumps.filter(jump=>trackById.has(jump.from.id)&&trackById.has(jump.to.id)).slice(-8);
      const nextJumpSignature=validJumps.map(jump=>`${jump.from.id}:${jump.from.frame}>${jump.to.id}:${jump.to.frame}`).join('|');
      if (jumpSignature !== nextJumpSignature) {
        jumpSignature = nextJumpSignature; jumpLines.forEach(({line}) => {scene.remove(line); line.geometry.dispose(); line.material.dispose();}); jumpLines = [];
        trip=null;
        for (const jump of validJumps) {
          const curve=journey(jump);
          if (!curve) continue;
          const object = line(curve.getPoints(120).map(point=>point.add(v(0,-5,0))), .3, 1.15, true); object.material.resolution.set(mount.clientWidth, mount.clientHeight); jumpLines.push({jump,line:object});
        }
        const recent = validJumps.at(-1);
        if (recent && !reduced) {
          const curve=journey(recent);
          if(curve) trip = {jump:recent,curve,duration:THREE.MathUtils.clamp(curve.getLength()/95, .85, 2.4)*1000,
            start: now, offset: camera.position.clone().sub(controls.target)};
        }
      }
      let target: THREE.Vector3 | null = null, eye: THREE.Vector3 | null = null;
      if (mode.current === 'tree' || first) {
        if(first||now-overviewTime>180) {
          overviewTime=now;
          const backward=(props.classic||props.city?v(.5,.3,.8):v(.85,.32,.58)).normalize(),right=v(0,1,0).cross(backward).normalize(),up=backward.clone().cross(right);
          const bounds=new THREE.Box3(),samples:THREE.Vector3[]=[];
          for(const track of tracks)if(track.reveal>.01)for(let i=0;i<=8;i++) {
            if(openingOnly&&i>0)continue;
            if(openingOnly&&track!==active)continue;
            const sample=movingPoint(track,i/8*track.reveal);
            samples.push(sample);bounds.expandByPoint(v(sample.dot(right),sample.dot(up),sample.dot(backward)));
          }
          const center=bounds.getCenter(v(0,0,0));
          overviewTarget.copy(right).multiplyScalar(center.x).addScaledVector(up,center.y).addScaledVector(backward,center.z);
          const tanY=Math.tan(THREE.MathUtils.degToRad(camera.fov/2)),tanX=tanY*camera.aspect;
          let distance=220/Math.max(.65,camera.aspect);
          for(const sample of samples) {
            const relative=sample.clone().sub(overviewTarget),z=relative.dot(backward);
            distance=Math.max(distance,z+(Math.abs(relative.dot(right))+30)/(tanX*.82),z+(Math.abs(relative.dot(up))+30)/(tanY*.79));
          }
          overviewEye.copy(overviewTarget).addScaledVector(backward,distance);
        }
        target=overviewTarget;eye=overviewEye;
      } else if (mode.current === 'follow') {
        target = point.clone().add(v(0,0,-5)); eye = point.clone().add(v(20,13,56));
      } else if (mode.current === 'point' && focusPoint && focusEye) {target = focusPoint; eye = focusEye;}
      if (trip && mode.current === 'point') {
        const t = Math.min(1,(now-trip.start)/trip.duration), smooth = t*t*(3-2*t);
        target = trip.curve.getPointAt(smooth); eye = target.clone().add(trip.offset.clone().lerp(cameraOffset,smooth));
        if (t === 1) trip = null;
      }
      if (target && eye) {
        const ease = first || reduced ? 1 : 1 - Math.exp(-dt * 3.7);
        camera.up.set(0,1,0);
        controls.target.lerp(target, ease); camera.position.lerp(eye, ease);
      }
      first = false; controls.update(); camera.updateMatrixWorld();
      if(openingOnly){activePhoto.quaternion.copy(camera.quaternion);activeCorners.quaternion.copy(camera.quaternion);}
      for(const boundary of boundaries) {
        boundary.text.visible=boundary.start||boundary.track.reveal>=.99;
        const at=movingPoint(boundary.track,boundary.start?0:1).add(v(0,openingOnly&&boundary.start?-19:-10,0));
        const pixels=2*camera.position.distanceTo(at)*Math.tan(THREE.MathUtils.degToRad(camera.fov/2))/mount.clientHeight;
        boundary.text.position.copy(at);boundary.text.scale.set(115*pixels,24*pixels,1);
      }
      if(arrivalRegion) {
        const visible=tracks.some(track=>arrivalLayout.ranks.has(track.node.id)&&track.reveal>.9);
        arrivalRegion.ring.visible=visible;arrivalRegion.text.visible=visible;
        const pixels=2*camera.position.distanceTo(arrivalRegion.text.position)*Math.tan(THREE.MathUtils.degToRad(camera.fov/2))/mount.clientHeight;
        arrivalRegion.text.scale.set(105*pixels,24*pixels,1);
      }
      // Keep every revealed action illustrated. Only text labels need packing;
      // an action must not disappear just because playback follows another fork.
      if(now-actionLayoutTime>120) {
        actionLayoutTime=now;
        const right=v(1,0,0).applyQuaternion(camera.quaternion),up=v(0,1,0).applyQuaternion(camera.quaternion);
        const width=mount.clientWidth,height=mount.clientHeight;
        const pixelsPerUnit=height/(2*Math.tan(THREE.MathUtils.degToRad(camera.fov/2)));
        const boxes: {left:number;top:number;right:number;bottom:number}[]=[];
        const photoCenter=point.clone().project(camera),photoWidth=17*pixelsPerUnit/Math.max(1,-point.clone().applyMatrix4(camera.matrixWorldInverse).z);
        if(photoWidth>100) {
          const x=(photoCenter.x*.5+.5)*width,y=(.5-photoCenter.y*.5)*height;
          boxes.push({left:x-photoWidth*.5-8,top:y-photoWidth*.28125-8,right:x+photoWidth*.5+8,bottom:y+photoWidth*.28125+8});
        }
        const shownTitles=new Set<string>();
        const priority=(track:Track)=>track===active?0:track.node.parent===active.node.id||active.node.rejoinTarget===track.node.id?1:
          track.node.parent===active.node.parent&&track.node.depth===active.node.depth?2:
          track.node.storyEnding||(siblingCounts.get(track.node.parent)||0)>1?3:p.path.includes(track.node.id)?4:5;
        const candidates=actionMarkers.filter(item=>!openingOnly&&item.track.reveal>.12)
          .sort((a,b)=>priority(a.track)-priority(b.track)||a.track.node.id.localeCompare(b.track.node.id));
        for(const item of actionMarkers){item.targetOpacity=0;item.targetLabelOpacity=0;}
        let shown=0,labels=0;
        for(const item of candidates) {
          if(shownTitles.has(item.track.node.title)&&priority(item.track)>1)continue;
          // Keep the characters on their actual ribbon. Packing them in distant
          // screen-space rings hid the shape of the graph behind long tethers.
          const relevant=priority(item.track)<=1;
          const anchors=[.82,.55,.3].map(t=>movingPoint(item.track,Math.min(t,item.track.reveal*.9)));
          let best:{anchor:THREE.Vector3;x:number;y:number;px:number;imageHeight:number;box:typeof boxes[number];score:number}|null=null;
          for(const anchor of anchors) {
            const projected=anchor.clone().project(camera);
            if(projected.z< -1||projected.z>1||Math.abs(projected.x)>1.1||Math.abs(projected.y)>1.1)continue;
            const x=(projected.x*.5+.5)*width,y=(.5-projected.y*.5)*height;
            const px=Math.max(1,-anchor.clone().applyMatrix4(camera.matrixWorldInverse).z)/pixelsPerUnit;
            const imageHeight=relevant?THREE.MathUtils.clamp(28/px,44,80):THREE.MathUtils.clamp(20/px,20,46);
            const half=imageHeight*item.aspect/2;
            const box={left:x-half-3,top:y-imageHeight+5/px,right:x+half+3,bottom:y+5/px};
            const overlap=boxes.reduce((sum,other)=>sum+Math.max(0,Math.min(box.right,other.right)-Math.max(box.left,other.left))*Math.max(0,Math.min(box.bottom,other.bottom)-Math.max(box.top,other.top)),0);
            const score=overlap+anchors.indexOf(anchor)*.01;
            if(!best||score<best.score)best={anchor,x,y,px,imageHeight,box,score};
          }
          if(!best)continue;
          const {anchor,x,y,px,imageHeight,box}=best;
          boxes.push(box);
          item.anchor.copy(anchor);
          item.targetPosition.copy(anchor).add(v(0,-5,0));
          item.targetHeight=imageHeight*px;
          item.targetOpacity=relevant?1:.88;
          item.targetLabel.copy(item.targetPosition);item.targetLabelHeight=21*px;
          item.offset.set(0,0);item.captioned=false;
          shownTitles.add(item.track.node.title);shown++;
          const labelHeight=21,labelWidth=item.labelAspect*labelHeight;
          const labelOffsets=[[0,-imageHeight-10],[0,18],[-Math.min(48,labelWidth*.2),-imageHeight-22],[Math.min(48,labelWidth*.2),18]];
          for(const [dx,dy] of labels<(width<500?4:8)?labelOffsets:[]) {
            const caption={left:x+dx-labelWidth/2-5,top:y+dy-labelHeight/2,right:x+dx+labelWidth/2+5,bottom:y+dy+labelHeight/2};
            if(caption.left<12||caption.right>width-12||caption.top<48||caption.bottom>height-72)continue;
            if(boxes.some(other=>caption.left<other.right+5&&caption.right>other.left-5&&caption.top<other.bottom+5&&caption.bottom>other.top-5))continue;
            boxes.push(caption);labels++;
            item.targetLabel.copy(anchor).addScaledVector(right,dx*px).addScaledVector(up,-dy*px);
            item.targetLabelOpacity=relevant?.98:.72;
            item.captioned=true;
            break;
          }
          if(!item.placed){item.sprite.position.copy(item.targetPosition);item.track.end.position.copy(item.targetLabel);item.placed=true;}
        }
        mount.dataset.actionMarkers=String(shown);
        mount.dataset.actionLabels=String(labels);
        mount.dataset.actionTitles=[...shownTitles].join('|');
      }
      const actionEase=reduced?1:1-Math.exp(-dt*12);
      for(const item of actionMarkers) {
        item.opacity=THREE.MathUtils.lerp(item.opacity,item.targetOpacity,actionEase);
        item.labelOpacity=THREE.MathUtils.lerp(item.labelOpacity,item.targetLabelOpacity,actionEase);
        item.sprite.visible=item.opacity>.02;item.track.end.visible=item.labelOpacity>.02;
        item.leader.visible=item.sprite.visible&&item.offset.length()>16;
        if(!item.sprite.visible)continue;
        item.sprite.material.opacity=item.opacity;item.track.end.material.opacity=item.labelOpacity;
        item.sprite.position.lerp(item.targetPosition,actionEase);item.track.end.position.lerp(item.targetLabel,actionEase);
        item.sprite.scale.lerp(v(item.targetHeight*item.aspect,item.targetHeight,1),actionEase);
        item.track.end.scale.lerp(v(item.targetLabelHeight*item.labelAspect,item.targetLabelHeight,1),actionEase);
        item.leader.material.opacity=item.opacity*(item.captioned?.42:.24);
        const railAnchor=item.anchor.clone().add(v(0,-5,0));
        const mid=railAnchor.clone().lerp(item.sprite.position,.5).add(v(0,2,0));
        item.leader.geometry.setPositions(new THREE.QuadraticBezierCurve3(railAnchor,mid,item.sprite.position).getPoints(12).flatMap(q=>q.toArray()));
      }
      const burst = (now-handoffStarted)/240;
      handoffRing.visible=!reduced && burst>=0 && burst<1;
      if (handoffRing.visible) {
        const pixel=2*camera.position.distanceTo(point)*Math.tan(THREE.MathUtils.degToRad(camera.fov/2))/Math.max(1,mount.clientHeight);
        handoffRing.position.copy(point);handoffRing.quaternion.copy(camera.quaternion);
        handoffRing.scale.setScalar(pixel*(9+35*(1-(1-burst)**3)));
        handoffMaterial.opacity=(1-burst)**2*.95;
      } else if(mount.dataset.transitionActive==='true') mount.dataset.transitionActive='false';
      const direction = camera.getWorldDirection(new THREE.Vector3());
      if (now-sortTime > 100) {
        const moved=lastSortEye.distanceToSquared(camera.position)>1 || lastSortDirection.distanceToSquared(direction)>.0001;
        sortTime=now; lastSortEye.copy(camera.position); lastSortDirection.copy(direction);
        const matrix=camera.matrixWorldInverse.elements;
        const pixelsPerUnit=mount.clientHeight/(2*Math.tan(THREE.MathUtils.degToRad(camera.fov/2)));
        for (const track of tracks) {
          if (!track.images?.visible) continue;
          const distance=Math.max(1,camera.position.distanceTo(track.positions[Math.floor(framesIn(track.node)/2)]));
          const width=17*pixelsPerUnit/distance;
          // Sparse photographs in the overview; all native frames return nearby.
          // Hysteresis prevents rapid changes while orbiting at a threshold.
          let stride=track.stride;
          if(width>150)stride=1;
          else if(width<46)stride=4;
          else if(width>60&&width<120)stride=2;
          if(track===active)stride=1;
          else if(completeStory||p.path.includes(track.node.id))stride=Math.min(stride,2);
          const limit=Math.min(framesIn(track.node),Math.max(1,Math.ceil(track.revealUniform.value)));
          const changed=stride!==track.stride || limit!==track.sampleLimit;
          if(!changed&&!moved&&!track.sortDirty)continue;
          if(changed)track.slotFrames=Array.from({length:limit},(_,i)=>i).filter(f=>f%stride===0);
          track.stride=stride;track.sampleLimit=limit;track.sortDirty=false;
          // Transform each position once, instead of allocating vectors inside
          // every comparison of every scene's transparent frames.
          const depths=track.positions.map(q=>q.x*matrix[2]+q.y*matrix[6]+q.z*matrix[10]);
          track.slotFrames.sort((a,b)=>depths[a]-depths[b]);
          track.images.count=track.slotFrames.length;
          const tile = track.images.geometry.attributes.frameTile, index = track.images.geometry.attributes.frameIndex;
          track.slotFrames.forEach((f,slot) => {track.images!.setMatrixAt(slot,track.matrices[f]); tile.setXY(slot,f%8,atlasRows(track.node)-1-Math.floor(f/8)); index.setX(slot,f);});
          tile.needsUpdate=true; index.needsUpdate=true; track.images.instanceMatrix.needsUpdate=true;
          track.images.computeBoundingSphere();
        }
      }
      renderer.render(scene, camera);
    });
    return () => {
      disposed=true;textureWarmQueue.length=0;
      renderer.setAnimationLoop(null); observer.disconnect(); controls.dispose();
      resources.forEach(r => r.dispose()); renderer.dispose(); renderer.domElement.remove();
    };
  }, [props.nodes, props.connections, props.classic, props.city]);
  return <div className="time-space">
    <div ref={host} className="time-canvas" aria-label="Interactive 3D time network. Every image is a video frame. Branches cross and rejoin shared destinations. Click a frame to pause, drag to orbit, scroll to zoom." />
    <div className="time-reveal-status"><span>{progressive ? 'Progressive reveal' : 'Full network'} <small>· precomputed</small></span><span ref={revealCount}/></div>
    <div className="time-map-tools">
      <button aria-label="Whole tree" title="Whole tree" className={view === 'tree' ? 'active' : ''} onClick={() => {mode.current = 'tree'; command.current++; setView('tree');}}><Scan size={15}/></button>
      <button aria-label="Follow time" title="Follow time" className={view === 'follow' ? 'active' : ''} onClick={() => {mode.current = 'follow'; command.current++; setView('follow');}}><Focus size={15}/></button>
      <button aria-label="Crossings" title="Show connections" aria-pressed={showLinks} className={showLinks ? 'active' : ''} onClick={() => {linksVisible.current=!linksVisible.current;setShowLinks(linksVisible.current);}}><GitBranch size={15}/></button>
      <button aria-label="Progressive reveal" title={progressive ? 'Show all scenes' : 'Reveal scenes ahead of playback'} aria-pressed={progressive} className={progressive ? 'active' : ''} onClick={() => {progressiveMode.current=!progressiveMode.current;setProgressive(progressiveMode.current);}}><Waves size={15}/></button>
      <button aria-label="Return to the first frame" title="Return to the first frame" onClick={() => props.onPick({id: 'root', frame: 0})}><RotateCcw size={15}/></button>
    </div>
    {hover?.node.atlas && <div className="time-hover" style={{left: hover.x, top: hover.y}}>
      <div style={{backgroundImage: `url(${hover.node.atlas})`, backgroundSize: `800% ${atlasRows(hover.node)*100}%`, backgroundPosition: `${(hover.frame % 8) / 7 * 100}% ${Math.floor(hover.frame / 8) / Math.max(1,atlasRows(hover.node)-1) * 100}%`}}/>
      <span>{((timelineFor(props.nodes,props.path.includes(hover.node.id)?props.path:pathThrough(props.nodes,hover.node.id)).moments.find(m=>m.id===hover.node.id)?.start || 0) + hover.frame / 24).toFixed(2)}s · frame {hover.frame + 1}</span><strong>{hover.node.title}</strong>
    </div>}
    {hoverLink && <div className="time-cross-hover" style={{left:hoverLink.x,top:hoverLink.y}}><span>SWITCH TIMELINE</span><strong>→ {hoverLink.target.id.toUpperCase()} / {hoverLink.label}</strong><small>Navigation jump · click to cross</small></div>}
    {error && <p className="time-map-error">{error}</p>}
  </div>;
}
