export type StoryNode = {id:string; chapter:number; choice:number; chapterTitle:string; title:string;
  duration:number; status:'ready'|'preparing'; clip:string|null; stream:string|null; frame:string|null; atlas:string|null;foregroundAtlas?:string|null};
export type StoryManifest = {title:string; subtitle:string; duration:number; shotDuration:number;
  decisionDuration:number; total:number; ready:number; foregroundReady?:number; nodes:StoryNode[];
  chapters:{index:number;title:string}[]; codec:string; join:string};
