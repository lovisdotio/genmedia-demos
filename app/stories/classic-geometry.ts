import * as THREE from 'three';
import type {TimeNode} from './types';

// Recovered classic layout (September 23, captures13–17). Keep its broad
// crown: later terminal-ring overrides would collapse the original ribbons.
const v=(x:number,y:number,z:number)=>new THREE.Vector3(x,y,z);
const depthSpace=(p:THREE.Vector3)=>v(p.x*.8,p.z*.9,-p.y*1.12-25);
function tip(node:TimeNode,nodes:TimeNode[]):THREE.Vector3 {
  if(node.sharedEnding)return v(0,7,-300);
  if(!node.parent)return depthSpace(v(0,-35,0));
  const choices:number[]=[];let current:TimeNode|undefined=node;
  while(current?.parent){choices.unshift(current.choice);current=nodes.find(n=>n.id===current!.parent);}
  const index=choices.reduce((acc,c)=>acc*4+c,0),count=4**node.depth;
  const angle=-Math.PI*.88+(index+.5)/count*Math.PI*1.76;
  const radius=[0,60,125,165][node.depth];
  return depthSpace(v(Math.sin(angle)*radius,node.depth*62-35+(node.depth===3?Math.sin(angle*3)*9:0),Math.cos(angle)*radius*.8));
}
export function classicCurve(node:TimeNode,nodes:TimeNode[]):THREE.CubicBezierCurve3 {
  if(node.sharedEnding)return new THREE.CubicBezierCurve3(v(0,7,-240),v(-3,8,-260),v(3,7,-282),tip(node,nodes));
  if(!node.parent)return new THREE.CubicBezierCurve3(depthSpace(v(0,-94,0)),depthSpace(v(-12,-80,12)),depthSpace(v(7,-54,0)),depthSpace(v(0,-35,0)));
  const parent=nodes.find(n=>n.id===node.parent)!;
  const start=tip(parent,nodes),end=tip(node,nodes),parentCurve=classicCurve(parent,nodes);
  const incoming=start.clone().add(parentCurve.v3.clone().sub(parentCurve.v2));
  return new THREE.CubicBezierCurve3(start,incoming,end.clone().add(v(-Math.sign(end.x-start.x)*5.5,-1.6,24)),end);
}
