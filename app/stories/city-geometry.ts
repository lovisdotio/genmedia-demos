import * as THREE from 'three';
import type {TimeNode} from './types';

// Archived city-walk layout, including generated rejoins and a narrowing arrival region.
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
// Preserve the branching layout while letting time recede into the scene.
const depthSpace = (point: THREE.Vector3) => v(point.x * .8, point.z * .9, -point.y * 1.12 - 25);
type ArrivalGroup={key:string;ids:string[];center:THREE.Vector3};
const arrivalCache=new WeakMap<TimeNode[],{ids:Set<string>;points:Map<string,THREE.Vector3>;groups:ArrivalGroup[];minZ:number}>();
const visualDepth=(depth:number)=>depth<=6?depth:6+(depth-6)*.34;
function endingFamily(node:TimeNode) {
  if(node.worldAnchor==='sidewalk'||/street/i.test(node.title))return 'street';
  if(node.worldAnchor==='window'||node.worldAnchor==='reflection'||/reflection/i.test(node.title))return 'reflection';
  if(/loop/i.test(node.title))return 'loop';
  return 'signal';
}
export function cityArrival(nodes:TimeNode[]) {
  let layout=arrivalCache.get(nodes);
  if(!layout) {
    const parents=new Set(nodes.map(n=>n.parent));
    const terminal=nodes.filter(n=>!parents.has(n.id)&&!n.rejoinTarget).sort((a,b)=>a.id.localeCompare(b.id));
    const z=-205-Math.max(3,Math.max(...nodes.map(n=>visualDepth(n.depth)))-3)*52;
    const families=[{key:'signal',x:-31,y:17},{key:'reflection',x:25,y:23},{key:'loop',x:-23,y:-23},{key:'street',x:34,y:-17}];
    const points=new Map<string,THREE.Vector3>();
    const groups=families.map(({key,x,y})=>{
      const members=terminal.filter(node=>endingFamily(node)===key),center=v(x,y-44,z);
      // Compact organic clusters, rather than an identical point for different
      // footage. Each terminal keeps its own stable, clickable destination.
      members.forEach((node,index)=>{
        const angle=index*Math.PI*(3-Math.sqrt(5)),radius=1.7*Math.sqrt(index);
        points.set(node.id,center.clone().add(v(Math.cos(angle)*radius,Math.sin(angle)*radius,0)));
      });
      return {key,ids:members.map(node=>node.id),center};
    });
    layout={ids:new Set(terminal.map(node=>node.id)),points,groups,minZ:z};
    arrivalCache.set(nodes,layout);
  }
  return layout;
}
function tip(node: TimeNode, nodes: TimeNode[]) {
  if (node.rejoinTarget) {
    const target = nodes.find(n => n.id === node.rejoinTarget);
    const parent = nodes.find(n => n.id === target?.parent);
    if (parent) return tip(parent,nodes);
  }
  if(node.storyPosition)return v(...node.storyPosition);
  const arrival=cityArrival(nodes);
  if(arrival.ids.has(node.id)) {
    // Only routes reaching this same node share an exact destination.
    return arrival.points.get(node.id)!.clone();
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
    const radius = Math.max(40,140-(stage-4)*18);
    return v(Math.sin(angle)*radius,Math.cos(angle)*radius*.9-(stage-3)*22,-205-(stage-3)*52);
  }
  const index = choices.reduce((acc, c) => acc * 4 + c, 0), count = 4 ** node.depth;
  const angle = -Math.PI * .88 + (index + .5) / count * Math.PI * 1.76;
  const radius = [0, 60, 125, 165][node.depth];
  return depthSpace(v(Math.sin(angle) * radius, node.depth * 62 - 35 + (node.depth === 3 ? Math.sin(angle * 3) * 9 : 0), Math.cos(angle) * radius * .8));
}

/** Keep control points in front of the finale plane, including return links. */
export function boundCityCurve(curve:THREE.CubicBezierCurve3,nodes:TimeNode[]) {
  const z=cityArrival(nodes).minZ;
  curve.v1.z=Math.max(z,curve.v1.z);
  curve.v2.z=Math.max(z,curve.v2.z);
  return curve;
}
export function cityCurve(node: TimeNode, nodes: TimeNode[]):THREE.CubicBezierCurve3 {
  return boundCityCurve(curveFor(node,nodes),nodes);
}
function curveFor(node: TimeNode, nodes: TimeNode[]):THREE.CubicBezierCurve3 {
  if(!node.parent&&node.storyPosition) {
    const end=tip(node,nodes);
    return new THREE.CubicBezierCurve3(end.clone().add(v(-12,-8,60)),end.clone().add(v(-8,-4,44)),end.clone().add(v(0,0,20)),end);
  }
  if (node.sharedEnding) return new THREE.CubicBezierCurve3(v(0,7,-240),v(-3,8,-260),v(3,7,-282),tip(node,nodes));
  if (!node.parent) return new THREE.CubicBezierCurve3(depthSpace(v(0, -94, 0)), depthSpace(v(-12, -80, 12)), depthSpace(v(7, -54, 0)), depthSpace(v(0, -35, 0)));
  const parent = nodes.find(n => n.id === node.parent)!;
  const start = tip(parent, nodes), end = tip(node, nodes);
  const parentCurve = cityCurve(parent, nodes);
  // Equal handles give matching position AND velocity at a two-second boundary.
  // All forks initially share their parent's tangent before bending apart.
  const incoming = start.clone().add(parentCurve.v3.clone().sub(parentCurve.v2));
  if(cityArrival(nodes).ids.has(node.id)) {
    // Settle into this ending's cluster without a lateral hook at the tip.
    const approach=Math.min(23,Math.max(1,(start.z-end.z)/3));
    return new THREE.CubicBezierCurve3(start,incoming,end.clone().add(v(0,0,approach)),end);
  }
  if (node.rejoinTarget) {
    const destination = nodes.find(n => n.id === node.rejoinTarget);
    const destinationParent = nodes.find(n => n.id === destination?.parent);
    const approach = destinationParent ? cityCurve(destinationParent,nodes) : parentCurve;
    const outgoing = end.clone().sub(approach.v3.clone().sub(approach.v2));
    return new THREE.CubicBezierCurve3(start,incoming,outgoing,end);
  }
  if (node.depth > 3) {
    const side = Math.sign(end.x-start.x) || 1;
    return new THREE.CubicBezierCurve3(start,incoming,end.clone().add(v(-side*10,12,23)),end);
  }
  return new THREE.CubicBezierCurve3(start, incoming, end.clone().add(v(-Math.sign(end.x - start.x) * 5.5, -1.6, 24)), end);
}
