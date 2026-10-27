/** #446 analytic signed-depth, hold/SG controls and planted wrong readings. */
import { describe, expect, test } from 'bun:test';
import { depthShadeTracks, heldShadeSigns, readDepthShade, shadeLimit, shadeReconstruction, shadeSlots, selectShadeChains, type ShadeCleanParams } from '../src/depthshade.ts';
import { clean, savitzkyGolay } from '../src/clean.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMap } from '../src/map.ts';
import { mergeProblems, readIdle, type RigcTrack } from '../src/idle.ts';
import { readPoseSequence, type FrameDepth, type Joint } from '../src/pose.ts';
import type { Limb } from '../src/depth.ts';
const point=(y:number):Joint=>({state:'observed',at:[0,y]});
const joints={r_hip:point(0),r_knee:point(6),r_ankle:point(14),r_shoulder:point(0),r_elbow:point(6),r_wrist:point(14)};
const depth=(sign:-1|0|1):FrameDepth=>Object.fromEntries(['r_thigh','r_upper_arm','r_shin','r_forearm'].map(s=>[s,{ratio:s==='r_thigh'||s==='r_upper_arm'?.6:.8,sign,source:'derived'}]));
const slots=new Map<Limb,readonly string[]>([['r_leg',['thigh','shin']]]);
const params=(gait:'walk'|'run'='run',loop=false,legs=1,rest=1):ShadeCleanParams=>({loop,legs,rest,depth:{gait}});
const read=(sign:-1|0|1,gait:'walk'|'run'='run')=>readDepthShade([joints],[depth(sign)],params(gait),.8,slots);
describe('#446 continuous held-sign depth with actual clean windows',()=>{
 test('known6/10 geometry gives8px, true magnitude and source immutability; sign mutant stays unshaded',()=>{
  const source=[joints,depth(-1)],before=JSON.stringify(source),row=read(-1)[0]!;
  expect(row.depth).toEqual([-8]);expect(row.smoothedDepth).toEqual([-8]);expect(row.farthest).toBe(8);expect(row.farness).toEqual([1]);
  expect(depthShadeTracks([row],.8,[0],1,false)[0]).toEqual({slot:'thigh',property:'rgb',keys:[{t:0,v:[.8,.8,.8]}]});
  expect(depthShadeTracks(read(1),.8,[0],1,false)).toEqual([]);expect(JSON.stringify(source)).toBe(before);
  const rows=readDepthShade([joints,{...joints,r_knee:point(3)}],[depth(-1),depth(-1)],params(),.8,slots);
  expect(rows[0]!.depth).toEqual([-8,-4]);expect(rows[0]!.farness).toEqual([1,.5]);
 });
 test('every recorded0 holds: flat, above-band and source0 outside-band; no invented facing',()=>{
  const values=[{ratio:.6,sign:-1 as const},{ratio:.98,sign:0 as const},{ratio:1.2,sign:0 as const},{ratio:.5,sign:0 as const}];
  const row=heldShadeSigns('r_thigh',values,false);expect(row.signs).toEqual([-1,-1,-1,-1]);
  expect(row.held.map(s=>s.reason)).toEqual(['flat-band','above-band','side-on-or-unread']);expect(row.held.map(s=>s.seedFrame)).toEqual([0,0,0]);
  const flat=depth(0);flat.r_thigh!.ratio=.98;
  const track=[joints,{...joints,r_knee:point(9.8)},joints];
  const zs=readDepthShade(track,[depth(-1),flat,depth(1)],params(),.8,slots)[0]!.depth;
  expect(zs[0]).toBe(-8);expect(zs[1]).toBeCloseTo(-10*Math.sqrt(1-.98**2),12);expect(zs[2]).toBe(8);
  // The old zero-sign step would incorrectly erase the readable flat-band magnitude.
  expect(zs[1]).not.toBe(0);
 });
 test('nonloop leading/all-tie stay unread; loop seeds last decision, SG never future-fills null centres',()=>{
  const values=[{ratio:.98,sign:0 as const},{ratio:.6,sign:-1 as const},{ratio:1.2,sign:0 as const}];
  expect(heldShadeSigns('r_thigh',values,false).signs).toEqual([null,-1,-1]);
  expect(heldShadeSigns('r_thigh',values,true).signs).toEqual([-1,-1,-1]);
  const row=read(0)[0]!;expect(row.status).toBe('unread');expect(row.unreadSpans[0]!.reason).toBe('sign-unread');expect(row.segments[0]!.unreadSpans[0]!.reason).toBe('all-undecided');expect(row.unreadFrames).toEqual([0]);expect(row.smoothedDepth).toEqual([null]);expect(row.farness).toEqual([null]);
  expect(depthShadeTracks([row],.8,[0],1,false)[0]!.keys[0]!.v).toEqual([1,1,1]);
  const ds=Array.from({length:7},(_,i)=>depth(i===0?0:-1));
  const partial=readDepthShade(Array(7).fill(joints),ds,params('run',false,5,7),.8,slots)[0]!;
  expect(partial.status).toBe('partly-unread');expect(partial.segments[0]!.unreadSpans[0]!.reason).toBe('leading-undecided');expect(partial.smoothedDepth[0]).toBeNull();expect(partial.farness[0]).toBeNull();
  expect(depthShadeTracks([partial],.8,Array.from({length:7},(_,i)=>i),7,false)[0]!.keys[0]!.v).toEqual([1,1,1]);
 });
 test('standalone SG wraps a two-frame signal, while actual clean caller refuses the short loop',()=>{
  const result=savitzkyGolay([[0,0],[1,0]],5,true);
  expect(result[0]![0]).toBeCloseTo(24/35,12);expect(result[1]![0]).toBeCloseTo(11/35,12);
  const source=readPoseSequence(readFileSync(join(import.meta.dir,'../examples/wave/pose.json'),'utf8'),'control');
  const {cleaned:_record,...raw}=source;
  expect(()=>clean({...raw,frames:source.frames.slice(0,2)},{loop:true,legs:5,rest:5,hold:'off'},undefined,'two-frame-control')).toThrow('CLEAN_LOOP');
  expect(savitzkyGolay([null,[1,0]],5,true)[0]).toBeNull();
 });
 test('existing quadratic SG5/7, polynomial edges, cyclic rotation and window1 controls',()=>{
  expect(savitzkyGolay([0,0,1,0,0].map(z=>[z,0]),5,false)[2]![0]).toBeCloseTo(17/35,12);
  expect(savitzkyGolay([0,0,0,1,0,0,0].map(z=>[z,0]),7,false)[3]![0]).toBeCloseTo(7/21,12);
  const polynomial=Array.from({length:7},(_,i):[number,number]=>[i*i,2*i+1]);
  savitzkyGolay(polynomial,5,false).forEach((p,i)=>expect(p![0]).toBeCloseTo(i*i,10));
  const x=[-8,-4,0,4,8,2,-2],rotate=(x:number[])=>[...x.slice(1),x[0]!];
  const sm=(x:number[])=>savitzkyGolay(x.map(z=>[z,0]),5,true).map(p=>p![0]);
  sm(rotate(x)).forEach((v,i)=>expect(v).toBeCloseTo(rotate(sm(x))[i]!,12));
  expect(savitzkyGolay([[2,0],null,[-2,0]],1,false)).toEqual([[2,0],null,[-2,0]]);
  const rows=readDepthShade(Array(7).fill(joints),Array.from({length:7},()=>depth(-1)),params('walk',true,5,7),.8,new Map([['r_leg',['leg']],['r_arm',['arm']]]));
  expect(rows.map(r=>r.window)).toEqual([5,7]);expect(rows.map(r=>r.joints)).toEqual([['r_hip','r_knee','r_ankle'],['r_shoulder','r_elbow','r_wrist']]);
  const rec=shadeReconstruction(rows,params('walk',true,5,7));expect(rec.method).toBe('held-segment-depth-sg/1');expect(rec.source.cleaned).toEqual({loop:true,legs:5,rest:7});expect(rec.tie.unreadMultiplier).toBe(1);
 });
 test('the limb pipeline really applies the selected SG window to signed depth',()=>{
  const positions=Array.from({length:7},(_,i)=>({...joints,r_knee:point(i===2?3:6)}));
  const depths=positions.map((_,i)=>{const d=depth(-1);d.r_thigh!.ratio=i===2?.3:.6;return d;});
  const row=readDepthShade(positions,depths,params('run',false,5,7),.8,slots)[0]!;
  expect(row.depth[2]).toBeCloseTo(-Math.sqrt(91),12);
  expect(row.smoothedDepth[2]).toBeCloseTo(-8-(Math.sqrt(91)-8)*17/35,12);
  expect(row.smoothedDepth[2]).not.toBe(row.depth[2]);
 });
 test('walk uses existing ankle composition, run knee only, arm mean; no picture-y sign rewrite',()=>{
  expect(read(-1,'walk')[0]!.depth[0]).toBeCloseTo(-14,12);expect(read(1,'walk')[0]!.depth[0]).toBeCloseTo(14,12);
  expect(readDepthShade([joints],[depth(-1)],params('walk'),.8,new Map([['r_arm',['arm']]]))[0]!.depth[0]).toBeCloseTo(-11,12);
  const noShin=depth(-1);delete noShin.r_shin;
  expect(readDepthShade([joints],[noShin],params(),.8,slots)[0]!.depth).toEqual([-8]);
  const flat=depth(-1);flat.r_thigh!.ratio=1.1;expect(readDepthShade([joints],[flat],params(),.8,slots)[0]!.depth[0]).toBeCloseTo(0,12);
 });
 test('range/provenance/window/zero-rest refusals precede gate; missing geometry is explicitly neutral unread',()=>{
  for(const k of [-.01,1.01,NaN,Infinity])expect(()=>shadeLimit(k)).toThrow('DEPTH_SHADE_RANGE');for(const k of [0,1])expect(()=>shadeLimit(k)).not.toThrow();
  expect(()=>readDepthShade([joints],[depth(-1)],undefined,.8,slots)).toThrow('DEPTH_SHADE_SOURCE');
  expect(()=>readDepthShade([joints],[depth(-1)],{...params(),depth:undefined},.8,slots)).toThrow('DEPTH_SHADE_SOURCE');
  for(const legs of [0,2,3,NaN])expect(()=>readDepthShade([joints],[depth(-1)],params('run',false,legs),.8,slots)).toThrow('DEPTH_SHADE_WINDOW');
  expect(()=>readDepthShade([joints],[depth(-1)],params('run',true,5),.8,slots)).toThrow('exceeds loop length');
  const zero=depth(-1);zero.r_thigh!.ratio=0;expect(()=>readDepthShade([joints],[zero],params(),.8,slots)).toThrow('legal ratio 0');
  const bad=depth(-1);bad.r_thigh!.source='measured';expect(()=>readDepthShade([joints],[bad],params(),.8,slots)).toThrow('frame 0 segment "r_thigh"');
  const unread=readDepthShade([{...joints,r_knee:{state:'missing'}}],[depth(-1)],params(),.8,slots)[0]!;expect(unread.status).toBe('unread');expect(unread.farness).toEqual([null]);
 });
 test('anatomical mapping excludes head/trunk/unmapped slots; mixed chains refused by name',()=>{
  const map=readMap(JSON.stringify({spec:'rig-pose-map/1',chains:[{name:'arbitrary',bones:['a','b'],joints:['r_hip','r_knee','r_ankle']},{name:'trunk',bones:['c'],joints:['mid_hip','neck']}]}),'map');
  expect([...shadeSlots(map,[{name:'thigh',bone:'a'},{name:'shin',bone:'b'},{name:'torso',bone:'c'},{name:'shoe',bone:'unmapped'}])]).toEqual([['r_leg',['thigh','shin']]]);
  map.chains[0]!.joints=['neck','r_elbow','r_wrist'];expect([...shadeSlots(map,[])]).toEqual([]);expect(()=>selectShadeChains(map,['arbitrary'])).toThrow('chain "arbitrary"');
  map.chains[0]!.joints=['l_knee','r_elbow','r_wrist'];expect([...shadeSlots(map,[])]).toEqual([]);expect(()=>selectShadeChains(map,['arbitrary'])).toThrow('same-side');
  expect(readDepthShade([joints],[{}],params(),.8,new Map())).toEqual([]);
 });
 test('RGB owns channels while alpha carries/merges; identity, rounding and loop remain intact',()=>{
  const own=depthShadeTracks(read(-1),.8,[0],1,true) as unknown as RigcTrack[];
  const tr=(property:string,v:number[]):RigcTrack=>({slot:'thigh',property,keys:[{t:0,v},{t:1,v}]});
  expect(mergeProblems([tr('alpha',[.5])],'fragment','dance',own,1,{})).toEqual([]);
  for(const property of ['rgb','rgba','rgb2','rgba2'])expect(mergeProblems([tr(property,[1,1,1])],'fragment','dance',own,1,{}).some(p=>p.code==='MERGE_CONFLICT')).toBe(true);
  const idle=readIdle('idle','dance',{duration:1,tracks:[tr('rgb',[1,1,1]),tr('alpha',[.5])]},own,1,{groups:{},easings:{}},()=>undefined,true);
  expect(idle.keptOut.map(x=>x.property)).toEqual(['rgb']);expect(idle.carriedTracks.map(x=>x.property)).toEqual(['alpha']);
  expect(depthShadeTracks(read(-1),1,[0],1,true)).toEqual([]);expect(depthShadeTracks(read(1),.8,[0],1,true)).toEqual([]);
  const track=depthShadeTracks(read(-1),.812345678,[0],1,true,new Map([['thigh','80402080']]))[0]!;
  expect(track.keys[0]!.v).toEqual([.407766,.203883,.101941]);expect(track.keys.at(-1)!.v).toEqual(track.keys[0]!.v);expect(track.property).toBe('rgb');
 });
 test('#451 idle rgba/rgba2/rgb2 on a shaded slot merges channel-wise; same-channel collision names slot and channel',()=>{
  const own=depthShadeTracks(read(-1),.8,[0,.25,.75,1],1,true) as unknown as RigcTrack[];
  const rgba:RigcTrack={slot:'thigh',property:'rgba',keys:[{t:0,v:[.9,.8,.7,.25],curve:[.2,.9,.3,.8,.2,.8,.3,.7,.2,.7,.3,.6,.2,.25,.3,.75]},{t:.5,v:[.8,.7,.6,.75],ease:'soft'},{t:1,v:[.9,.8,.7,.25]}]};
  const alphaOnly:RigcTrack={slot:'thigh',property:'alpha',keys:[{t:0,v:[.25],curve:[.2,.25,.3,.75]},{t:.5,v:[.75],ease:'soft'},{t:1,v:[.25]}]};
  const easings={soft:[.25,.1,.25,1]};
  const expectedAlpha=readIdle('idle','dance',{duration:1,tracks:[alphaOnly]},[],1.5,{groups:{},easings},()=>undefined,true).carriedTracks[0]!;
  const idleRgba=readIdle('idle','dance',{duration:1,tracks:[rgba]},own,1.5,{groups:{},easings},()=>undefined,true);
  expect(idleRgba.keptOut).toEqual([{target:{kind:'slot',name:'thigh'},property:'rgb',reason:'"dance"\'s own slot "thigh" rgb keys it'}]);
  expect(idleRgba.dropped.map(d=>[d.target,d.property,d.carried?.keys])).toEqual([[{kind:'slot',name:'thigh'},'alpha',expectedAlpha.keys.length]]);
  expect(JSON.stringify(idleRgba.carriedTracks)).toBe(JSON.stringify([expectedAlpha]));
  expect(JSON.stringify(idleRgba.ownTracks)).toBe(JSON.stringify(own));
  const rgba2:RigcTrack={slot:'thigh',property:'rgba2',keys:[{t:0,v:[.9,.8,.7,.25,.1,.2,.3],curve:[.2,.9,.3,.8,.2,.8,.3,.7,.2,.7,.3,.6,.2,.25,.3,.75,.2,.1,.3,.4,.2,.2,.3,.5,.2,.3,.3,.6]},{t:.5,v:[.8,.7,.6,.75,.4,.5,.6],ease:'soft'},{t:1,v:[.9,.8,.7,.25,.1,.2,.3]}]};
  const expectedLoopRgba2=readIdle('idle','dance',{duration:1,tracks:[rgba2]},[],1.5,{groups:{},easings},()=>undefined,true).carriedTracks[0]!;
  const idleRgba2=readIdle('idle','dance',{duration:1,tracks:[rgba2]},own,1.5,{groups:{},easings},()=>undefined,true);
  expect(idleRgba2.keptOut).toEqual([{target:{kind:'slot',name:'thigh'},property:'rgb',reason:'"dance"\'s own slot "thigh" rgb keys it'}]);
  expect(idleRgba2.carriedTracks.map(t=>t.property)).toEqual(['rgba2']);
  expect(idleRgba2.ownTracks.map(t=>t.slot)).toEqual(['shin']);
  const folded=idleRgba2.carriedTracks[0]!;
  const shadeKeys=own[0]!.keys;
  expect(shadeKeys).toHaveLength(4);
  expect(expectedLoopRgba2.keys).toHaveLength(4);
  expect(folded.keys.map(k=>k.t)).toEqual([0,.25,.5,.75,1,1.5]);
  const foldedByT=new Map(folded.keys.map(k=>[k.t,k.v as number[]]));
  expect(JSON.stringify(shadeKeys.map(k=>({t:k.t,v:foldedByT.get(k.t)!.slice(0,3)})))).toBe(JSON.stringify(shadeKeys.map(k=>({t:k.t,v:k.v}))));
  expect(JSON.stringify(expectedLoopRgba2.keys.map(k=>({t:k.t,v:foldedByT.get(k.t)!.slice(3,7)})))).toBe(JSON.stringify(expectedLoopRgba2.keys.map(k=>({t:k.t,v:(k.v as number[]).slice(3,7)}))));
  const rgb2:RigcTrack={slot:'thigh',property:'rgb2',keys:[{t:0,v:[.9,.8,.7,.1,.2,.3]},{t:.5,v:[.8,.7,.6,.4,.5,.6]},{t:1,v:[.9,.8,.7,.1,.2,.3]}]};
  const expectedLoopRgb2=readIdle('idle','dance',{duration:1,tracks:[rgb2]},[],1.5,{groups:{},easings},()=>undefined,true).carriedTracks[0]!;
  const idleRgb2=readIdle('idle','dance',{duration:1,tracks:[rgb2]},own,1.5,{groups:{},easings},()=>undefined,true);
  const foldedRgb2ByT=new Map(idleRgb2.carriedTracks[0]!.keys.map(k=>[k.t,k.v as number[]]));
  expect(JSON.stringify(shadeKeys.map(k=>({t:k.t,v:foldedRgb2ByT.get(k.t)!.slice(0,3)})))).toBe(JSON.stringify(shadeKeys.map(k=>({t:k.t,v:k.v}))));
  expect(JSON.stringify(expectedLoopRgb2.keys.map(k=>({t:k.t,v:foldedRgb2ByT.get(k.t)!.slice(3,6)})))).toBe(JSON.stringify(expectedLoopRgb2.keys.map(k=>({t:k.t,v:(k.v as number[]).slice(3,6)}))));
  for(const prop of ['rgb','rgba','rgb2','rgba2']){
   const probs=mergeProblems([{slot:'thigh',property:prop,keys:[{t:0,v:[1,1,1]}]}],'fragment','dance',own,1,{});
   expect(probs).toHaveLength(1);
   expect(probs[0]!.code).toBe('MERGE_CONFLICT');
   expect(probs[0]!.text).toContain('slot "thigh"');
   expect(probs[0]!.text).toContain('channel "rgb"');
   expect(probs[0]!.text).toContain('slot "thigh" rgb');
  }
 });
});


describe('#446 exact chain selection and RGB ownership',()=>{
 const raw={spec:'rig-pose-map/1',chains:[
  {name:'crown',bones:['q','v'],joints:['r_hip','r_knee','r_ankle']},
  {name:'leg_l',bones:['u','f'],joints:['r_shoulder','r_elbow','r_wrist']},
  {name:'leg_r',bones:['torso'],joints:['mid_hip','neck']},
  {name:'mixed',bones:['m0','m1'],joints:['l_knee','r_elbow','r_wrist']},
 ]};
 const map=()=>readMap(JSON.stringify(raw),'anatomical selection control');
 const rigSlots=[{name:'thigh',bone:'q'},{name:'shin',bone:'v'},{name:'upper',bone:'u'},{name:'forearm',bone:'f'},{name:'trunk',bone:'torso'},{name:'descendant',bone:'hand'}];
 test('default is anatomical legs despite misleading names; unselected mixed chains and arm depth are untouched',()=>{
  const m=map(),selection=selectShadeChains(m);
  expect(selection).toEqual({mode:'default-legs',requested:null,chains:['crown']});
  const legDepth=depth(-1);delete legDepth.r_upper_arm;delete legDepth.r_forearm;
  const rows=readDepthShade([joints],[legDepth],params(),.8,shadeSlots(m,rigSlots,selection));
  expect(depthShadeTracks(rows,.8,[0],1,false).map(t=>t.slot)).toEqual(['thigh','shin']);
  expect(shadeReconstruction(rows,params(),selection).selection).toEqual(selection);
  expect(()=>readDepthShade([joints],[legDepth],params(),.8,shadeSlots(m,rigSlots,selectShadeChains(m,['leg_l'])))).toThrow('limb "r_arm"');
 });
 test('explicit arm/all chains opt in, stable duplicate handling and exact names rather than substring aliases',()=>{
  const m=map(),arm=selectShadeChains(m,['leg_l']),all=selectShadeChains(m,['leg_l','crown','leg_l']);
  expect(all).toEqual({mode:'explicit',requested:['leg_l','crown'],chains:['leg_l','crown']});
  const emit=(selection:typeof arm)=>depthShadeTracks(readDepthShade([joints],[depth(-1)],params(),.8,shadeSlots(m,rigSlots,selection)),.8,[0],1,false).map(t=>t.slot);
  expect(emit(arm)).toEqual(['upper','forearm']);expect(emit(all)).toEqual(['thigh','shin','upper','forearm']);
  for(const name of ['CROWN','missing','leg_r','mixed'])expect(()=>selectShadeChains(m,[name])).toThrow('DEPTH_SHADE_CHAINS');
  expect(()=>selectShadeChains(m,['mixed'])).toThrow('l_knee -> r_elbow -> r_wrist');expect(()=>selectShadeChains(m,[])).toThrow('nonempty');
 });
 test('no leg map has an explicit empty default record and no RGB; selected slot ownership leaves arm RGB free',()=>{
  const m=map();m.chains=m.chains.filter(c=>c.name!=='crown');const selection=selectShadeChains(m);
  const rows=readDepthShade([joints],[{}],params(),.8,shadeSlots(m,rigSlots,selection));
  expect(selection).toEqual({mode:'default-legs',requested:null,chains:[]});expect(rows).toEqual([]);expect(depthShadeTracks(rows,.8,[0],1,false)).toEqual([]);
  expect(shadeReconstruction(rows,params(),selection).selection).toEqual(selection);
  const own=depthShadeTracks(read(-1),.8,[0],1,true) as unknown as RigcTrack[];
  const tr=(slot:string):RigcTrack=>({slot,property:'rgb',keys:[{t:0,v:[1,1,1]},{t:1,v:[1,1,1]}]});
  expect(mergeProblems([tr('upper')],'arm fragment','dance',own,1,{})).toEqual([]);
  expect(mergeProblems([tr('thigh')],'leg fragment','dance',own,1,{}).some(p=>p.code==='MERGE_CONFLICT')).toBe(true);
  const idle=readIdle('idle','dance',{duration:1,tracks:[tr('thigh'),tr('upper')]},own,1,{groups:{},easings:{}},()=>undefined,true);
  expect(idle.keptOut.map(t=>t.target.name)).toEqual(['thigh']);expect(idle.carriedTracks.some(t=>t.slot==='upper'&&t.property==='rgb')).toBe(true);
 });
});
