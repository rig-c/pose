import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { poseRawAnimation } from 'rig-c/core';
import { walkAnkleDepth } from '../src/draworder.ts';
import { readDepthScale, scaleDepth, depthFeetOf, footScaleTracks, depthScaleLine, type DepthScaleSide } from '../src/depthscale.ts';
import { retarget } from '../src/retarget.ts';
import { readMap } from '../src/map.ts';
import { gate, readBuild, restOf } from '../src/rigc.ts';
import { measureLanding, measureDepthScaleLanding, landed } from '../src/verify.ts';
import { DEPTH_OPTIONS, writeDepthRig, depthInput, leadInput } from './depthscale-fixture.ts';

function phaseFailures(rows: DepthScaleSide[]): string[] {
  const f = leadInput();
  return rows.flatMap((row, side) => {
    const signed = f.track.map((j, i) => Math.abs(walkAnkleDepth(j, f.depths[i]!, `${row.side}_leg`)!) * f.leads[i]! * (side === 0 ? 1 : -1));
    const extreme = { min: Math.min(...signed), max: Math.max(...signed) };
    return signed.flatMap((z, i) => {
      const expected = scaleDepth(z, extreme, [1, 1.48]).value;
      return Math.abs(row.values[i]! - expected) < 1e-12 ? [] : [`DEPTH_SCALE_FOOT_SIGN ${row.side} frame ${i}: expected ${expected}, found ${row.values[i]}`];
    });
  });
}
describe('#437 foot-only derived perspective', () => {
  test('affine extrema includes entirely negative depths, clamps both ends; no zero anchor', () => {
    expect(scaleDepth(-20,{min:-20,max:0},[1,1.48])).toEqual({value:1,clamped:false});
    expect(scaleDepth(0,{min:-20,max:0},[1,1.48]).value).toBe(1.48);
    expect(scaleDepth(-10,{min:-20,max:0},[1,1.48]).value).toBeCloseTo(1.24);
    expect(scaleDepth(10,{min:-20,max:0},[1,1.48])).toEqual({value:1.48,clamped:true});
    expect(scaleDepth(-30,{min:-20,max:0},[1,1.48])).toEqual({value:1,clamped:true});
    expect(scaleDepth(-5,{min:-5,max:-5},[0.8,1.4])).toEqual({value:1,clamped:false});
  });
  test('per-foot analytical control and actual old-sign / inverted-lead mutants red by name', async () => {
    const f=leadInput();
    expect(phaseFailures(readDepthScale(f.track,f.depths,'walk',[1,1.48]))).toEqual([]);
    mkdirSync(join(import.meta.dir,'../node_modules/.cache'),{recursive:true});
    const dir=mkdtempSync(join(import.meta.dir,'../node_modules/.cache/depth437-mutant-'));
    try {
      cpSync(join(import.meta.dir,'../src'),join(dir,'src'),{recursive:true});
      const source=readFileSync(join(dir,'src/depthscale.ts'),'utf8');
      const edits = [
        ['old-sign', 'Math.abs(value) * (side === \'r\' ? sign : -sign)', 'value'],
        ['inverted-lead', 'delta > 0 ? 1 : -1', 'delta > 0 ? -1 : 1'],
        ['inverted-affine', '(z - extreme.min)', '(extreme.max - z)'],
      ];
      for (const [name, before, after] of edits) {
        expect(source.split(before!)).toHaveLength(2);
        const path=join(dir,`src/depthscale-${name}.ts`);
        writeFileSync(path,source.replace(before!,after!));
        const mutant=await import(path) as {readDepthScale:typeof readDepthScale};
        const failures=phaseFailures(mutant.readDepthScale(f.track,f.depths,'walk',[1,1.48]));
        expect(failures.length).toBeGreaterThan(0);
        expect(failures[0]).toStartWith('DEPTH_SCALE_FOOT_SIGN');
        console.log(`DEPTH_SCALE_FOOT_SIGN ${name}: ${failures.length} named failures; control 0`);
      }
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  test('source refusal vs explicit derived unread/zero-span fallback, named lines and exact 1', () => {
    const f=depthInput();
    expect(()=>readDepthScale(f.track,undefined,undefined,[1,1.48])).toThrow('DEPTH_SCALE_SOURCE');
    const measured=f.depths.map(d=>Object.fromEntries(Object.entries(d).map(([k,v])=>[k,{...v,source:'measured' as const}])));
    expect(()=>readDepthScale(f.track,measured,'walk',[1,1.48])).toThrow('DEPTH_SCALE_SOURCE');
    const flat=f.depths.map(d=>Object.fromEntries(Object.entries(d).map(([k,v])=>[k,{...v,sign:0 as const}])));
    for(const row of readDepthScale(f.track,flat,'walk',[1,1.48])) {expect(row.values.every(v=>v===1)).toBe(true);expect(depthScaleLine(row)).toContain('DEPTH_SCALE_ZERO_SPAN');}
    for(const row of readDepthScale(f.track,f.depths.map(()=>({})),'walk',[1,1.48])) {expect(row.values.every(v=>v===1)).toBe(true);expect(depthScaleLine(row)).toContain('DEPTH_SCALE_UNREAD');}
    const partial=[undefined,...f.depths.slice(1)];
    expect(readDepthScale(f.track,partial,'walk',[1,1.48])[0]!.values[0]).toBe(1);
    expect(depthScaleLine(readDepthScale(f.track,partial,'walk',[1,1.48])[0]!)).toContain('unread frames 0');
    for(const limits of [[0,2],[1.1,2],[0.5,0.9],[NaN,2]]) expect(()=>readDepthScale(f.track,f.depths,'walk',limits as [number,number])).toThrow('DEPTH_SCALE_RANGE');
  });
  test('gated shoes: both axes, fixed ankle, moving sole, unchanged leg tracks; failures are reachable', () => {
    const dir=mkdtempSync(join(tmpdir(),'depth437-'));
    try {
      writeDepthRig(dir);
      const base={spec:'rigc-motion/1',archetype:'wave',cut:'wave',easings:{},animations:{}};
      const g0=gate(join(dir,'rig.json'),base,join(dir,'base'),'spine');expect(g0.green,g0.run.out).toBe(true);
      const doc0=readBuild(g0.build),rest=restOf(doc0),map=readMap(readFileSync(join(import.meta.dir,'../examples/walk/map.json'),'utf8'),'map');
      const feet=depthFeetOf(doc0,rest,map),f=depthInput(),rows=readDepthScale(f.track,f.depths,'walk',[1,1.48]);
      for(const legScale of [undefined,[0.6,1.1] as [number,number]]) {
        const r=retarget(rest,map,f.track,f.times,{...DEPTH_OPTIONS,plantFeet:true,...(legScale===undefined?{}:{legScale})});
        const before=JSON.stringify(r.animation.tracks);
        const shoe=footScaleTracks(rows,feet,r.times),tracks=[...r.animation.tracks,...shoe];
        expect(JSON.stringify(tracks.filter(tr=>'bone' in tr&&!Object.values(feet).some(f=>f.bone===tr.bone)))).toBe(before);
        const build=(ts:typeof tracks,label:string)=>{const g=gate(join(dir,'rig.json'),{...base,animations:{dance:{...r.animation,tracks:ts}}},join(dir,label),'spine');expect(g.green,g.run.out).toBe(true);return readBuild(g.build);};
        const doc=build(tracks,legScale===undefined?'control':'combined');
        expect(measureLanding(doc,'dance',map,r).filter(x=>!landed(x))).toEqual([]);
        expect(measureDepthScaleLanding(doc,'dance',r.times,rows,feet).filter(x=>!landed(x))).toEqual([]);
        const neutral=build(r.animation.tracks,legScale===undefined?'neutral':'neutral-combined');
        const raw=poseRawAnimation(doc,'dance',r.times.slice(1).map((t,i)=>t-r.times[i]!),{},'animation');
        const raw0=poseRawAnimation(neutral,'dance',r.times.slice(1).map((t,i)=>t-r.times[i]!),{},'animation');
        const sole=(p:typeof raw[number])=>Math.min(...p.drawn.find(x=>x.slot==='shoe_r')!.vertices.filter((_,i)=>i%2===1));
        expect(raw.some((p,i)=>sole(p)<sole(raw0[i]!)-1)).toBe(true);
        const wrong=tracks.map(tr=>'bone' in tr&&tr.bone==='shoe_r'&&tr.property==='scaley'?{...tr,keys:tr.keys.map(k=>({...k,v:[k.v[0]!*1.05]}))}:tr);
        const red=measureDepthScaleLanding(build(wrong,'bad-y'+(legScale?'combined':'')),'dance',r.times,rows,feet).filter(x=>!landed(x));
        expect(red.some(x=>x.bone==='shoe_r:y')).toBe(true);
        const shifted=[...tracks,{bone:'shoe_r',property:'translate' as const,keys:r.times.map(t=>({t,v:[0,1]}))}];
        expect(measureDepthScaleLanding(build(shifted,'bad-ankle'+(legScale?'combined':'')),'dance',r.times,rows,feet).some(x=>x.bone==='shoe_r:ankle'&&!landed(x))).toBe(true);

      }
      const missing=new Map([...rest].filter(([name])=>name!=='shoe_r'));
      expect(()=>depthFeetOf(doc0,missing,map)).toThrow('DEPTH_SCALE_GEOMETRY');
    } finally {rmSync(dir,{recursive:true,force:true});}
  },120_000);
  test('rigid alternatives, noRotationOrReflection and rounded ankle origins; beyond tolerance and multi-bone geometry refuse', () => {
    const dir=mkdtempSync(join(tmpdir(),'depth437-alternates-'));
    try {
      writeDepthRig(dir);
      const path=join(dir,'rig.json');
      const spec=JSON.parse(readFileSync(path,'utf8')) as {bones:Array<{name:string;x?:number;inherit?:string}>;skins:{default:Record<string,Record<string,unknown>>}};
      const foot=spec.bones.find(b=>b.name==='shoe_r')!;foot.x=70.000273;foot.inherit='noRotationOrReflection';
      spec.skins.default.shoe_r!.wide={image:'shoe_r.png',x:5,y:-5,width:45,height:12};writeFileSync(path,JSON.stringify(spec));
      const base={spec:'rigc-motion/1',archetype:'wave',cut:'wave',easings:{},animations:{}};
      const g0=gate(path,base,join(dir,'base'),'spine');expect(g0.green,g0.run.out).toBe(true);
      const doc=readBuild(g0.build),rest=restOf(doc),map=readMap(readFileSync(join(import.meta.dir,'../examples/walk/map.json'),'utf8'),'map');
      const feet=depthFeetOf(doc,rest,map),f=depthInput(),rows=readDepthScale(f.track,f.depths,'walk',[1,1.48]);
      const r=retarget(rest,map,f.track,f.times,{...DEPTH_OPTIONS,legScale:[0.6,1.1],plantFeet:true});
      const tracks=[...r.animation.tracks,...footScaleTracks(rows,feet,r.times),{slot:'shoe_r',property:'attachment' as const,keys:[{t:0,v:'art'},{t:0.5,v:'wide'}]}];
      const g1=gate(path,{...base,animations:{dance:{...r.animation,tracks}}},join(dir,'with'),'spine');expect(g1.green,g1.run.out).toBe(true);
      const final=readBuild(g1.build);expect(measureDepthScaleLanding(final,'dance',r.times,rows,feet).filter(x=>!landed(x))).toEqual([]);
      const poses=poseRawAnimation(final,'dance',r.times.slice(1).map((t,i)=>t-r.times[i]!),{},'animation');expect(poses.some(p=>p.drawn.some(d=>d.slot==='shoe_r'&&d.attachment==='wide'))).toBe(true);
      const far=new Map(rest);far.set('shoe_r',{...rest.get('shoe_r')!,worldX:rest.get('shoe_r')!.worldX+0.02});expect(()=>depthFeetOf(doc,far,map)).toThrow('DEPTH_SCALE_GEOMETRY');
      // A hidden alternative is still source checked; a second bone is not rigid.
      const weighted=structuredClone(doc);weighted.skins[0]!.attachments.shoe_r!.bad={kind:'mesh',geometry:{kind:'mesh',uvs:[0,0,1,0,0,1],triangles:[0,1,2],hull:3,vertices:{weighted:true,bindings:[[{bone:'shoe_r',x:0,y:0,weight:0.5},{bone:'leg_r1',x:0,y:0,weight:0.5}]]}}};
      expect(()=>depthFeetOf(weighted,rest,map)).toThrow('attachment "bad"');
      weighted.skins[0]!.attachments.shoe_r!.bad={kind:'mesh',geometry:{kind:'mesh',uvs:[0,0,1,0,0,1],triangles:[0,1,2],hull:3,vertices:{weighted:true,bindings:[[{bone:'shoe_r',x:0,y:0,weight:1}]]}}};
      expect(depthFeetOf(weighted,rest,map).r.bone).toBe('shoe_r');
    } finally {rmSync(dir,{recursive:true,force:true});}
  },120_000);
  test('CLI refuses invalid range, absent provenance before writes; supports planted/stance/reduced report', () => {
    const dir=mkdtempSync(join(tmpdir(),'depth437-cli-'));
    try {
      writeDepthRig(dir);
      const f=depthInput();
      const clean=spawnSync(process.execPath,[join(import.meta.dir,'../cli.ts'),'clean','--pose',join(import.meta.dir,'../examples/walk/pose.json'),'--out',join(dir,'depth.pose.json'),'--depth','walk','--legs','1','--rest','1','--hold','off','--loop'],{encoding:'utf8'});expect(clean.status,clean.stderr).toBe(0);
      const args=['retarget','--rig',dir,'--map',join(import.meta.dir,'../examples/walk/map.json'),'--pose',join(dir,'depth.pose.json'),'--out',join(dir,'motion.json'),'--name','dance','--plant-feet','--leg-scale','0.6,1.1','--stance','0.01','--reduce','0.1','--depth-scale','1,1.48'];
      const run=spawnSync(process.execPath,[join(import.meta.dir,'../cli.ts'),...args],{encoding:'utf8'});expect(run.status,run.stdout+'\n'+run.stderr).toBe(0);
      const report=JSON.parse(readFileSync(join(dir,'motion.report.json'),'utf8')) as {depthScale:Array<{bone:string;scale:{min:number;max:number}}>};
      expect(report.depthScale).toHaveLength(2);expect(run.stdout).toContain('DEPTH-SCALE');expect(run.stdout).toContain('SHEAR');
      const invalid=spawnSync(process.execPath,[join(import.meta.dir,'../cli.ts'),...args.map(a=>a==='1,1.48'?'-1,2':a)],{encoding:'utf8'});expect(invalid.status).not.toBe(0);expect(invalid.stderr).toContain('--depth-scale');
      const without=spawnSync(process.execPath,[join(import.meta.dir,'../cli.ts'),...args.map(a=>a==='dance'?'no-depth':a===join(dir,'depth.pose.json')?join(import.meta.dir,'../examples/walk/pose.json'):a)],{encoding:'utf8'});expect(without.status).not.toBe(0);expect(without.stderr).toContain('DEPTH_SCALE_SOURCE');
    } finally {rmSync(dir,{recursive:true,force:true});}
  },120_000);
});
