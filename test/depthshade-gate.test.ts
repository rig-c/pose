/** #446 installed CLI success path and actual rig-c reader/gate; synthetic art only. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Plate } from '@rig-c/core/plate';
import { poseRawAnimation } from '@rig-c/core/core';
import { depthCycle, depthDoc } from '../examples/walk/make-depth.ts';
import { clean } from '../src/clean.ts';
import { readPoseSequence, writePoseSequence } from '../src/pose.ts';
import { gate, readBuild } from '../src/rigc.ts';

type Track = { bone?:string; slot?:string; property:string; keys:Array<{t:number;v:unknown}> };
type Motion = {animations:Record<string,{duration:number;tracks:Track[]}>};
const root=join(import.meta.dir,'..');
test('#446 actual gated RGB, alpha, loop, reduce, k1, collision and deterministic bytes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'depth446-gate-'));
  let green=false;
  try {
    cpSync(join(root,'examples/wave/rig'),join(dir,'rig'),{recursive:true});
    const rigPath=join(dir,'rig/rig.json');
    const rig=JSON.parse(readFileSync(rigPath,'utf8')) as {slots:unknown[];skins:Record<string,unknown>};
    const bones=['leg_r0','leg_r1','leg_l0','leg_l1','sleeve_r0','sleeve_r1','sleeve_l0','sleeve_l1','chest','head'];
    rig.slots=bones.map(bone=>({name:bone,bone,attachment:'art',color:'80402080'}));
    rig.skins={default:Object.fromEntries(bones.map(bone=>[bone,{art:{image:'seg.png',x:1,y:0}}]))};
    const plate=new Plate(4,4);plate.rect(0,0,4,4,[255,255,255,255]);plate.writePng(join(dir,'rig/seg.png'));
    writeFileSync(rigPath,JSON.stringify(rig));
    const idle={spec:'rigc-motion/1',archetype:'wave',cut:'wave',easings:{},animations:{idle:{duration:1,tracks:[{slot:'leg_r0',property:'rgb',keys:[{t:0,v:[.5,.25,.125]},{t:1,v:[.5,.25,.125]}]},{slot:'leg_r0',property:'alpha',keys:[{t:0,v:[.25]},{t:1,v:[.25]}]}]}}};
    idle.animations.idle.tracks.push({slot:'sleeve_r0',property:'rgb',keys:[{t:0,v:[.9,.8,.7]},{t:1,v:[.9,.8,.7]}]});
    writeFileSync(join(dir,'rig/motion.json'),JSON.stringify(idle));
    // A back-view run has genuinely decided negative knee depth. The original
    // frontal walk has all-tie thighs and must stay unread/neutral under V3.
    const raw=readPoseSequence(JSON.stringify(depthDoc(depthCycle('run','back',1),'synthetic depth446')),'synthetic');
    const seq=clean(raw,{loop:true,legs:1,rest:1,hold:'off',depth:'run'},'a','synthetic').seq;
    const pose=join(dir,'pose.json');writeFileSync(pose,writePoseSequence(seq));
    const run=(label:string,extra:string[],poseInput=pose,mapInput=join(root,'examples/walk/map.json'))=>{
      const out=join(dir,`${label}.json`),build=join(dir,`${label}-build`);
      const r=spawnSync(process.execPath,[join(root,'cli.ts'),'retarget','--rig',join(dir,'rig'),'--map',mapInput,'--pose',poseInput,'--out',out,'--name','shade','--build',build,...extra],{encoding:'utf8',cwd:root});
      expect(r.status,(r.stdout??'')+(r.stderr??'')).toBe(0);
      return {out,build,text:readFileSync(out,'utf8'),motion:JSON.parse(readFileSync(out,'utf8')) as Motion,report:JSON.parse(readFileSync(out.replace(/\.json$/,'.report.json'),'utf8'))};
    };
    const off=run('off',[]),shade=run('shade',['--depth-shade','.8']);
    const rgb=(m:Motion)=>m.animations.shade!.tracks.filter(tr=>tr.slot!==undefined&&tr.property==='rgb');
    expect(rgb(off.motion)).toEqual([]);expect(rgb(shade.motion).length).toBeGreaterThan(0);
    expect(rgb(shade.motion).every(tr=>tr.slot!.startsWith('leg_'))).toBe(true);
    expect(shade.report.depthShade.selection).toEqual({mode:'default-legs',requested:null,chains:['leg_r','leg_l']});
    expect(shade.report.options.depthShadeChains).toEqual(['leg_r','leg_l']);
    const selection=shade.report.depthShade.selection;expect(shade.report.depthShade.reconstruction.selection).toEqual(selection);
    expect(rgb(shade.motion).every(tr=>tr.keys.every(k=>Array.isArray(k.v)&&k.v.length===3))).toBe(true);
    const duration=shade.motion.animations.shade!.duration;
    for(const tr of rgb(shade.motion))expect(tr.keys.at(-1)).toEqual({t:duration,v:tr.keys[0]!.v});
    const explicit=run('all-chains',['--depth-shade','.8','--depth-shade-chains',' leg_r , leg_l , arm_r , arm_l , arm_r ']);
    expect(explicit.report.depthShade.selection).toEqual({mode:'explicit',requested:['leg_r','leg_l','arm_r','arm_l'],chains:['leg_r','leg_l','arm_r','arm_l']});
    expect(rgb(explicit.motion).some(tr=>tr.slot!.startsWith('sleeve_'))).toBe(true);
    const arm=run('arm-only',['--depth-shade','.8','--depth-shade-chains','arm_r']);
    expect(rgb(arm.motion).length).toBeGreaterThan(0);expect(rgb(arm.motion).every(tr=>['sleeve_r0','sleeve_r1'].includes(tr.slot!))).toBe(true);
    const legsSeq=JSON.parse(writePoseSequence(seq));
    for(const f of legsSeq.frames)for(const segment of ['r_upper_arm','r_forearm','l_upper_arm','l_forearm'])delete f.depth[segment];
    const legsPose=join(dir,'leg-depth-only.pose.json');writeFileSync(legsPose,JSON.stringify(legsSeq));
    const missingArms=run('leg-depth-only',['--depth-shade','.8'],legsPose);expect(rgb(missingArms.motion)).toEqual(rgb(shade.motion));
    const noLegMap=JSON.parse(readFileSync(join(root,'examples/walk/map.json'),'utf8'));noLegMap.chains=noLegMap.chains.filter((c:{joints:string[]})=>!c.joints.some(j=>j.endsWith('_knee')||j.endsWith('_ankle')));
    const noLegPath=join(dir,'no-legs.map.json');writeFileSync(noLegPath,JSON.stringify(noLegMap));
    const emptyOff=run('no-leg-off',[],legsPose,noLegPath),empty=run('no-leg-shade',['--depth-shade','.8'],legsPose,noLegPath);
    expect(empty.text).toBe(emptyOff.text);expect(rgb(empty.motion)).toEqual([]);expect(empty.report.depthShade.selection).toEqual({mode:'default-legs',requested:null,chains:[]});expect(empty.report.depthShade.limbs).toEqual([]);
    const reduction=run('reduce',['--depth-shade','.8','--reduce','1']);
    expect(rgb(reduction.motion)).toEqual(rgb(shade.motion));
    const identity=run('identity',['--depth-shade','1']);expect(identity.text).toBe(off.text);
    const repeat=run('repeat',['--depth-shade','.8']);expect(repeat.text).toBe(shade.text);expect(repeat.report.depthShade.selection).toEqual(selection);expect(repeat.report.depthShade.reconstruction).toEqual(shade.report.depthShade.reconstruction);
    const carried=run('carried',['--depth-shade','.8','--carry-idle']);
    expect(carried.report.idleKeptOut.some((r:{property:string;target:{name:string}})=>r.property==='rgb'&&r.target.name==='leg_r0')).toBe(true);
    expect(carried.report.idleKeptOut.some((r:{property:string;target:{name:string}})=>r.property==='rgb'&&r.target.name==='sleeve_r0')).toBe(false);
    expect(carried.motion.animations.shade!.tracks.some(tr=>tr.slot==='sleeve_r0'&&tr.property==='rgb')).toBe(true);
    const armFragment=join(dir,'arm-fragment.json');writeFileSync(armFragment,JSON.stringify({spec:'rig-pose-tracks/1',tracks:[{slot:'sleeve_r0',property:'rgb',keys:[{t:0,v:[.9,.8,.7]}]}]}));
    const armMerged=run('unselected-arm-merge',['--depth-shade','.8','--merge',armFragment]);expect(armMerged.motion.animations.shade!.tracks.some(tr=>tr.slot==='sleeve_r0'&&tr.property==='rgb')).toBe(true);
    expect(carried.motion.animations.shade!.tracks.some(tr=>tr.slot==='leg_r0'&&tr.property==='alpha')).toBe(true);
    expect(shade.report.depthShade.reconstruction.method).toBe('held-segment-depth-sg/1');
    const provenance=JSON.parse(readFileSync(join(shade.build,'retarget.json'),'utf8'));
    // The report writer owns added time aliases on frame-span events.
    const withoutTimes=(value:unknown):unknown=>Array.isArray(value)?value.map(withoutTimes):value!==null&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='times').map(([key,v])=>[key,withoutTimes(v)])):value;
    expect(provenance.depthShade).toEqual(withoutTimes(shade.report.depthShade.reconstruction));
    expect(provenance.depthShade.selection).toEqual(selection);expect(provenance.flags.depthShadeChains).toEqual(selection.chains);
    for(const limb of shade.report.depthShade.reconstruction.limbs)for(const segment of limb.segments)for(const span of segment.held)expect(span.times).toEqual(span.frames.map((i:number)=>Number(seq.frames[i]!.t.toFixed(6))));
    expect(shade.report.cleaned).toBeDefined();
    const rawShade=poseRawAnimation(readBuild(shade.build),'shade',seq.frames.slice(1).map((f,i)=>f.t-seq.frames[i]!.t));
    const rawOff=poseRawAnimation(readBuild(off.build),'shade',seq.frames.slice(1).map((f,i)=>f.t-seq.frames[i]!.t));
    // RawDrawn.colour is attachment-only. The renderer multiplies it by
    // slot row[2..5] (rig-c render_core.ts tintOf), not by another attachment.
    const tint=(p:typeof rawShade[number],slot:string)=>{
      expect(p.drawn.length).toBe(bones.length);
      const drawn=p.drawn.find(d=>d.slot===slot)!;
      expect(drawn).toBeDefined();expect(drawn.attachment).toBe('art');
      expect(drawn.vertices.length).toBeGreaterThan(0);
      const row=p.slots.find(r=>r[0]===slot)!;
      expect(row).toBeDefined();expect(row[1]).toBe(drawn.attachment);
      return [row[2],row[3],row[4],row[5]].map((value,i)=>value! * drawn.colour[i]!);
    };
    rawShade.forEach((p,i)=>bones.forEach(slot=>expect(tint(p,slot)[3]).toBe(tint(rawOff[i]!,slot)[3])));
    // Pick a known far frame from the actual retarget report, not an early timestamp.
    const far=shade.report.depthShade.limbs.find((r:{farthest:number})=>r.farthest>0) as {slots:string[];farness:Array<number|null>};
    expect(far).toBeDefined();
    const frame=far.farness.indexOf(Math.max(...far.farness.filter((v):v is number=>v!==null))),slot=far.slots[0]!;
    expect(far.farness[frame]).toBe(1);
    expect(rawShade[frame]!.animationTime).toBeCloseTo(seq.frames[frame]!.t,5);
    expect(tint(rawShade[frame]!,slot)[0]).toBeLessThan(tint(rawOff[frame]!,slot)[0]!-.01);
    const g=gate(rigPath,shade.motion as unknown as Record<string,unknown>,join(dir,'a18'),'spine');
    expect(g.green,g.run.out).toBe(true);
    const gateReport=JSON.parse(readFileSync(join(dir,'a18/build-report.json'),'utf8'));
    // BuildReportDocument.gates[].passed is the actual report contract.
    const a18=gateReport.gates.map((r:{passed:string[];skipped:Array<{code:string}>;failures:Array<{code:string}>})=>({passed:r.passed.includes('A18_DETERMINISTIC_EMIT'),skipped:r.skipped.filter(x=>x.code==='A18_DETERMINISTIC_EMIT'),failures:r.failures}));
    expect(a18.length).toBeGreaterThan(0);
    expect(a18.every((r:{passed:boolean;skipped:unknown[];failures:unknown[]})=>r.passed&&r.skipped.length===0&&r.failures.length===0)).toBe(true);
    console.log('DEPTH446_A18',JSON.stringify(a18));
    const conflict=join(dir,'conflict.json');writeFileSync(conflict,JSON.stringify({spec:'rig-pose-tracks/1',tracks:[{slot:rgb(shade.motion)[0]!.slot,property:'rgba',keys:[{t:0,v:[1,1,1,1]}]}]}));
    const rejected=join(dir,'rejected.json');const bad=spawnSync(process.execPath,[join(root,'cli.ts'),'retarget','--rig',join(dir,'rig'),'--map',join(root,'examples/walk/map.json'),'--pose',pose,'--out',rejected,'--name','shade','--depth-shade','.8','--merge',conflict],{encoding:'utf8'});
    expect(bad.status).toBe(1);expect((bad.stdout??'')+(bad.stderr??'')).toContain('MERGE_CONFLICT');expect(existsSync(rejected)).toBe(false);
    green=true;
  }finally{if(green)rmSync(dir,{recursive:true,force:true});else console.log('DEPTH446_FAILED_FIXTURE_RETAINED',dir);}
},120_000);

test('#451 gated --carry-idle merges idle rgba and rgba2 channel-wise with --depth-shade RGB',()=>{
  const dir=mkdtempSync(join(tmpdir(),'depth451-gate-'));
  try {
    cpSync(join(root,'examples/wave/rig'),join(dir,'rig'),{recursive:true});
    const rigPath=join(dir,'rig/rig.json');
    const rig=JSON.parse(readFileSync(rigPath,'utf8')) as {slots:unknown[];skins:Record<string,unknown>};
    const bones=['leg_r0','leg_r1','leg_l0','leg_l1','sleeve_r0','sleeve_r1','sleeve_l0','sleeve_l1','chest','head'];
    rig.slots=bones.map(bone=>({name:bone,bone,attachment:'art',color:'80402080',...(bone==='leg_l0'?{dark:'102030'}:{})}));
    rig.skins={default:Object.fromEntries(bones.map(bone=>[bone,{art:{image:'seg.png',x:1,y:0}}]))};
    const plate=new Plate(4,4);plate.rect(0,0,4,4,[255,255,255,255]);plate.writePng(join(dir,'rig/seg.png'));
    writeFileSync(rigPath,JSON.stringify(rig));
    const raw=readPoseSequence(JSON.stringify(depthDoc(depthCycle('run','back',1),'synthetic depth451')),'synthetic');
    const seq=clean(raw,{loop:true,legs:1,rest:1,hold:'off',depth:'run'},'a','synthetic').seq;
    const pose=join(dir,'pose.json');writeFileSync(pose,writePoseSequence(seq));
    const alphaKeys=[{t:0,v:[.25]},{t:.35,v:[.75],ease:'soft'},{t:1,v:[.25]}];
    const rgbaKeys=[{t:0,v:[.9,.8,.7,.25]},{t:.35,v:[.8,.7,.6,.75],ease:'soft'},{t:1,v:[.9,.8,.7,.25]}];
    const rgba2Keys=[{t:0,v:[.9,.8,.7,.25,.1,.2,.3]},{t:.35,v:[.8,.7,.6,.75,.4,.5,.6],ease:'soft'},{t:1,v:[.9,.8,.7,.25,.1,.2,.3]}];
    const runWithIdle=(label:string,tracks:unknown[],shadeArgs:string[]=['--depth-shade','.8'])=>{
      writeFileSync(join(dir,'rig/motion.json'),JSON.stringify({spec:'rigc-motion/1',archetype:'wave',cut:'wave',easings:{soft:[.25,.1,.25,1]},animations:{idle:{duration:1,tracks}}}));
      const out=join(dir,`${label}.json`),build=join(dir,`${label}-build`);
      const r=spawnSync(process.execPath,[join(root,'cli.ts'),'retarget','--rig',join(dir,'rig'),'--map',join(root,'examples/walk/map.json'),'--pose',pose,'--out',out,'--name','shade','--build',build,...shadeArgs,'--carry-idle'],{encoding:'utf8',cwd:root});
      expect(r.status,(r.stdout??'')+(r.stderr??'')).toBe(0);
      return {motion:JSON.parse(readFileSync(out,'utf8')) as Motion,build};
    };
    const alphaRef=runWithIdle('alpha-ref',[{slot:'leg_r0',property:'alpha',keys:alphaKeys}]);
    const unshadedRgba2Ref=runWithIdle('unshaded-rgba2-ref',[{slot:'leg_l0',property:'rgba2',keys:rgba2Keys}],[]);
    const merged=runWithIdle('merged',[{slot:'leg_r0',property:'rgba',keys:rgbaKeys},{slot:'leg_l0',property:'rgba2',keys:rgba2Keys}]);
    const refAlphaTrack=alphaRef.motion.animations.shade!.tracks.find(tr=>tr.slot==='leg_r0'&&tr.property==='alpha')!;
    const mergedAlphaTrack=merged.motion.animations.shade!.tracks.find(tr=>tr.slot==='leg_r0'&&tr.property==='alpha')!;
    const refRgbTrack=alphaRef.motion.animations.shade!.tracks.find(tr=>tr.slot==='leg_r0'&&tr.property==='rgb')!;
    const mergedRgbTrack=merged.motion.animations.shade!.tracks.find(tr=>tr.slot==='leg_r0'&&tr.property==='rgb')!;
    expect(JSON.stringify(mergedAlphaTrack)).toBe(JSON.stringify(refAlphaTrack));
    expect(JSON.stringify(mergedRgbTrack)).toBe(JSON.stringify(refRgbTrack));
    const mergedRgba2Track=merged.motion.animations.shade!.tracks.find(tr=>tr.slot==='leg_l0'&&tr.property==='rgba2')!;
    expect(mergedRgba2Track).toBeDefined();
    expect(merged.motion.animations.shade!.tracks.some(tr=>tr.slot==='leg_l0'&&tr.property==='rgb')).toBe(false);
    const refL0Rgb=alphaRef.motion.animations.shade!.tracks.find(tr=>tr.slot==='leg_l0'&&tr.property==='rgb')!;
    const refL0Rgba2=unshadedRgba2Ref.motion.animations.shade!.tracks.find(tr=>tr.slot==='leg_l0'&&tr.property==='rgba2')!;
    expect(refL0Rgb.keys).toHaveLength(21);
    expect(refL0Rgba2.keys).toHaveLength(3);
    expect(mergedRgba2Track.keys).toHaveLength(22);
    const mergedByT=new Map(mergedRgba2Track.keys.map(k=>[k.t,k.v as number[]]));
    expect(JSON.stringify(refL0Rgb.keys.map(k=>({t:k.t,v:mergedByT.get(k.t)!.slice(0,3)})))).toBe(JSON.stringify(refL0Rgb.keys));
    expect(JSON.stringify(refL0Rgba2.keys.map(k=>({t:k.t,v:mergedByT.get(k.t)!.slice(3,7)})))).toBe(JSON.stringify(refL0Rgba2.keys.map(k=>({t:k.t,v:(k.v as number[]).slice(3,7)}))));
  }finally{rmSync(dir,{recursive:true,force:true});}
},120_000);

