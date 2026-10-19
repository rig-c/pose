import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { clean } from '../src/clean.ts';
import { readPoseSequence, writePoseSequence } from '../src/pose.ts';
import { readMap } from '../src/map.ts';
import { enrichReport, reportFrameTimes, reportRenderDomain, writeReport, type ReportClock, type ReportInputs } from '../src/report.ts';
import { assertReportInputs, readReportInput } from '../src/run.ts';
import { isObject } from '../src/problems.ts';

const declaredInputs:ReportInputs=Object.fromEntries(['rig','map','pose'].map(key=>[key,{path:key+'.json',sha256:createHash('sha256').update('synthetic '+key+' bytes').digest('hex')}])) as unknown as ReportInputs;
const map=readMap(JSON.stringify({spec:'rig-pose-map/1',chains:[{name:'arm',bones:['upper','lower'],joints:['r_shoulder','r_elbow','r_wrist']}]}),'synthetic report map');
function source(){return {spec:'rig-pose-report/1',frames:4,duration:1.1,holds:[{point:'r_wrist',from:0,to:1,source:0,why:'missing'}],cleaned:{holds:[{joint:'r_wrist',frames:[1,2],seconds:.8}],seams:[{joint:'r_elbow',frame:2,gap:0}]},raised:[{chain:'arm',frames:[0,2],seconds:1}],short:[{bone:'upper',frames:[1,2],joints:['r_shoulder','r_elbow']}],endOn:[],flips:[],turns:[],range:[],artRange:[],switches:[{set:'pose',frames:[1,2],from:.2,to:1.1,slots:{coat:'fold'}}],feet:{jumps:[[1,2]],supports:[{side:'r',frames:[0,3]}],changes:[{frame:2,from:'r',to:'l'}]},landings:[{bone:'upper',frame:2}],shear:[{bone:'upper',frame:3}],uncovered:[{slot:'coat',times:[0,.25,1]}],folds:[{slot:'coat',times:[0,.25,1]}]};}
function projectLike(original:unknown,current:unknown):unknown {if(Array.isArray(original)){expect(Array.isArray(current)).toBe(true);return original.map((value,i)=>projectLike(value,(current as unknown[])[i]));}if(isObject(original)){expect(isObject(current)).toBe(true);return Object.fromEntries(Object.entries(original).map(([key,value])=>[key,projectLike(value,(current as Record<string,unknown>)[key])]));}return current;}

describe('additive report coordinates',()=>{
 test('every original value stays exact while explicit irregular pose times and targets are added',()=>{
  const before=source(),snapshot=JSON.stringify(before),times=[0,.2,.9,1.1],out=enrichReport(before,map,{frameTimes:times},{fps:4,frames:5});
  expect(JSON.stringify(before)).toBe(snapshot);expect(projectLike(before,out)).toEqual(before);expect(out.frameTimes).toEqual(times);expect(out).not.toHaveProperty('fps');
  const cleaned=out.cleaned as {holds:Record<string,unknown>[];seams:Record<string,unknown>[]};expect(cleaned.holds[0]).toMatchObject({joint:'r_wrist',bone:'lower',times:[.2,.9],seconds:.8,spanSeconds:.8});expect(cleaned.seams[0]).toMatchObject({joint:'r_elbow',bones:['upper','lower'],frame:2,t:.9});
  expect((out.holds as Record<string,unknown>[])[0]).toMatchObject({point:'r_wrist',joint:'r_wrist',bone:'lower',frames:[0,1],times:[0,.2]});expect((out.raised as Record<string,unknown>[])[0]).toMatchObject({chain:'arm',bones:['upper','lower'],times:[0,.9],seconds:1,spanSeconds:1});
  expect((out.landings as Record<string,unknown>[])[0]).toMatchObject({frame:2,t:.9,bone:'upper'});expect((out.shear as Record<string,unknown>[])[0]).toMatchObject({frame:3,t:1.1});expect(out.endOn).toEqual([]);
 });
 test('tuple jumps stay unchanged and render samples preserve off-grid discrete gaps',()=>{
  const before=source(),out=enrichReport(before,map,{frameTimes:[0,.2,.9,1.1]},{fps:4,frames:5});const feet=out.feet as Record<string,unknown>;
  expect(feet.jumps).toEqual([[1,2]]);expect(feet.jumpEvents).toEqual([{frames:[1,2],times:[.2,.9]}]);expect(out.uncovered).toEqual([{slot:'coat',times:[0,.25,1],domain:'render'}]);expect((out.uncovered as Record<string,unknown>[])[0]).not.toHaveProperty('frame');expect((out.uncovered as Record<string,unknown>[])[0]).not.toHaveProperty('frames');expect(out.render).toEqual({fps:4,frames:5});
  expect(()=>enrichReport(before,map,{frameTimes:[0,.2,.9,1.1]})).toThrow('render-domain');
 });
 test('uniform is explicit, paired, offset in seconds, and missing fps mutant refuses by name',()=>{
  const clock={fps:24,frame0:2,frames:4};expect(reportFrameTimes(clock)).toEqual([2,2+1/24,2+2/24,2+3/24]);
  expect(()=>reportFrameTimes({frame0:2,frames:4} as ReportClock)).toThrow('fps');expect(()=>reportFrameTimes({fps:24,frames:4} as ReportClock)).toThrow('frame0');
  const out=enrichReport({frames:4,landings:[{bone:'upper',frame:3}]},map,clock);expect(out.fps).toBe(24);expect(out.frame0).toBe(2);expect(out).not.toHaveProperty('frameTimes');expect((out.landings as {t:number}[])[0]!.t).toBe(2+3/24);
 });
 test('missing, unordered, nonfinite and out-of-range coordinates are named refusals',()=>{
  for(const clock of [{frameTimes:[]},{frameTimes:[0,0]},{frameTimes:[0,NaN]},{fps:0,frame0:0,frames:2},{fps:2,frame0:0,frames:0}])expect(()=>reportFrameTimes(clock as ReportClock)).toThrow('REPORT_TIMEBASE');
  for(const row of [{frames:[1,0]},{frames:[0,1,1]},{frame:'1'}])expect(()=>enrichReport({frames:2,landings:[row]},map,{frameTimes:[0,1]})).toThrow('REPORT_TIMEBASE');expect(()=>enrichReport({frames:2,feet:{jumps:[[1,0]]}},map,{frameTimes:[0,1]})).toThrow('inclusive last');expect(()=>enrichReport({frames:2,holds:[{from:1,to:0}]},map,{frameTimes:[0,1]})).toThrow('inclusive last');
  expect(()=>enrichReport({frames:2,landings:[{frame:2}]},map,{frameTimes:[0,1]})).toThrow('frame 2 outside');expect(()=>enrichReport({frames:3},map,{frameTimes:[0,1]})).toThrow('clock has 2');expect(()=>enrichReport({frames:2,landings:[{frame:1,t:0}]},map,{frameTimes:[0,1]})).toThrow('REPORT_COORDINATE');
  expect(reportRenderDomain({sets:[{animation:'wave',fps:24,sampled:25}]},'wave')).toEqual({fps:24,frames:25});expect(()=>reportRenderDomain({sets:[]},'wave')).toThrow('render.animation');
  expect(()=>enrichReport({frames:2,frameTimes:[0,9]},map,{frameTimes:[0,1]})).toThrow('REPORT_COORDINATE');expect(()=>enrichReport({frames:2,landings:[{frame:1,seconds:1,spanSeconds:2}]},map,{frameTimes:[0,1]})).toThrow('spanSeconds');
 });
 test('absent and empty tuple jumps remain distinct',()=>{const absent=enrichReport({frames:2,feet:{supports:[]}},map,{frameTimes:[0,1]});expect(absent.feet).not.toHaveProperty('jumps');expect(absent.feet).not.toHaveProperty('jumpEvents');const empty=enrichReport({frames:2,feet:{jumps:[]}},map,{frameTimes:[0,1]});expect(empty.feet).toEqual({jumps:[],jumpEvents:[]});expect(()=>enrichReport({frames:2,feet:{jumps:[[0,1]],jumpEvents:[]}},map,{frameTimes:[0,1]})).toThrow('jumpEvents');const records=enrichReport({frames:2,reading:{frames:[{scale:1},{scale:2}]}},map,{frameTimes:[0,1]});expect(records.reading).toEqual({frames:[{scale:1},{scale:2}]});const moved={frame:[1,0],frames:-1,seconds:-1,window:[0,1]};expect(enrichReport({frames:2,switches:[{frames:[0,1],moved:{on:moved,off:null}}]},map,{frameTimes:[0,1]}).switches).toEqual([{frames:[0,1],times:[0,1],moved:{on:moved,off:null}}]);});
 test('unknown joints receive no fabricated bone and output is deterministic',()=>{
  const input={frames:2,cleaned:{holds:[{joint:'nose',frames:[0,1]}]}};const a=writeReport(input,map,{frameTimes:[0,1]},null,declaredInputs),b=writeReport(input,map,{frameTimes:[0,1]},null,declaredInputs);expect(a).toBe(b);const out=JSON.parse(a) as {cleaned:{holds:Record<string,unknown>[]}};expect(out.cleaned.holds[0]).not.toHaveProperty('bone');expect(out.cleaned.holds[0]).not.toHaveProperty('bones');
 });
 test('input identities require consumed files and changed buffers are refused',()=>{const dir=mkdtempSync(join(tmpdir(),'pose-input-'));try{const file=join(dir,'map.json'),bytes=' {\"value\":\"β\"}\n';writeFileSync(file,bytes);const read=readReportInput(file);expect(read.bytes.toString('utf8')).toBe(bytes);expect(read.identity.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));assertReportInputs([read]);writeFileSync(file,bytes+' ');expect(()=>assertReportInputs([read])).toThrow('REPORT_INPUTS_CHANGED');expect(()=>writeReport({frames:2},map,{frameTimes:[0,1]},null,undefined as unknown as ReportInputs)).toThrow('REPORT_INPUTS');expect(()=>enrichReport({frames:2,inputs:{}},map,{frameTimes:[0,1]},null,declaredInputs)).toThrow('REPORT_COORDINATE');for(const path of ['/private/absolute.json','C:\\private\\rig.json','\\\\server\\rig.json'])expect(()=>writeReport({frames:2},map,{frameTimes:[0,1]},null,{...declaredInputs,rig:{...declaredInputs.rig,path}})).toThrow('REPORT_INPUTS');expect(JSON.parse(writeReport({frames:2},map,{frameTimes:[0,1]},null,{...declaredInputs,rig:{...declaredInputs.rig,path:'../rig/rig.json'}})).inputs.rig.path).toBe('../rig/rig.json');}finally{rmSync(dir,{recursive:true,force:true});}});
 test('input identity allows timestamp-only changes to the same bytes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pose-input-touch-'));
  try {
   const file=join(dir,'pose.json'),bytes='{"frames":[]}\n';writeFileSync(file,bytes);
   const before=readReportInput(file);utimesSync(file,0,0);
   expect(readReportInput(file).mtimeMs).not.toBe(before.mtimeMs);
   expect(readFileSync(file,'utf8')).toBe(bytes);
   expect(()=>assertReportInputs([before])).not.toThrow();
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
 test('actual CLI report adds only metadata and does not change motion bytes on offset pose times',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pose-report-'));try{
   mkdirSync(join(dir,'images'));writeFileSync(join(dir,'rig.json'),JSON.stringify({spec:'rigc-rig/1',name:'report_probe',images:'images',skeleton:{width:100,height:100},bones:[{name:'root'},{name:'probe',parent:'root',length:12,x:3,y:7}],slots:[],skins:{default:{}}}));
   writeFileSync(join(dir,'map.json'),JSON.stringify({spec:'rig-pose-map/1',chains:[{name:'head',bones:['probe'],joints:['neck','nose']}]}));
   const seq=readPoseSequence(JSON.stringify({spec:'rig-pose-sequence/1',space:{units:'picture-px',origin:'top-left',y:'down'},width:100,height:100,source:'original synthetic report control',frames:[5,5.5,6].map((t,i)=>({t,people:[{id:'a',joints:{neck:{state:'observed',at:[50,60]},nose:{state:'observed',at:[50+i*3,40]},r_hip:{state:'observed',at:[40,90]},l_hip:{state:'observed',at:[60,90]}}}]}))}),'report control');
   const cleaned=clean(seq,{loop:false,legs:1,rest:1},undefined,'report control');writeFileSync(join(dir,'pose.json'),writePoseSequence(cleaned.seq));
   const cli=join(import.meta.dir,'../cli.ts');const args=['retarget','--rig',join(dir,'rig.json'),'--map',join(dir,'map.json'),'--pose',join(dir,'pose.json'),'--name','inspect','--short','off','--flip','off'];
   const baseline=spawnSync(process.execPath,[cli,...args,'--out',join(dir,'baseline.json')],{encoding:'utf8'});expect(baseline.status,baseline.stdout+baseline.stderr).toBe(0);
   const withReport=spawnSync(process.execPath,[cli,...args,'--out',join(dir,'with-report.json'),'--report',join(dir,'report.json')],{encoding:'utf8'});expect(withReport.status,withReport.stdout+withReport.stderr).toBe(0);expect(readFileSync(join(dir,'with-report.json'),'utf8')).toBe(readFileSync(join(dir,'baseline.json'),'utf8'));
   const mutant=join(import.meta.dir,'../node_modules/.cache/pose-report-clock-mutant');rmSync(mutant,{recursive:true,force:true});mkdirSync(mutant,{recursive:true});try{
    cpSync(join(import.meta.dir,'../src'),join(mutant,'src'),{recursive:true});cpSync(cli,join(mutant,'cli.ts'));cpSync(join(import.meta.dir,'../package.json'),join(mutant,'package.json'));const file=join(mutant,'src/run.ts'),original=readFileSync(file,'utf8');expect(original.split('{ frameTimes: r.times }')).toHaveLength(2);writeFileSync(file,original.replace('{ frameTimes: r.times }','{ fps: undefined as unknown as number, frame0: 0, frames: seq.frames.length }'));
    const motion=readFileSync(join(dir,'with-report.json'),'utf8'),previous=readFileSync(join(dir,'report.json'),'utf8');const refused=spawnSync(process.execPath,[join(mutant,'cli.ts'),...args,'--out',join(dir,'with-report.json'),'--report',join(dir,'report.json')],{encoding:'utf8'});expect(refused.status).toBe(1);expect(refused.stdout+refused.stderr).toContain('REPORT_TIMEBASE: fps');expect(readFileSync(join(dir,'with-report.json'),'utf8')).toBe(motion);expect(readFileSync(join(dir,'report.json'),'utf8')).toBe(previous);
    writeFileSync(file,original.replace('assertReportInputs([rigSnapshot,mapSnapshot,poseSnapshot]);',"writeFileSync(a.map, readFileSync(a.map, 'utf8') + ' '); assertReportInputs([rigSnapshot,mapSnapshot,poseSnapshot]);"));const beforeMap=readFileSync(join(dir,'map.json'));try{const changed=spawnSync(process.execPath,[join(mutant,'cli.ts'),...args,'--out',join(dir,'with-report.json'),'--report',join(dir,'report.json')],{encoding:'utf8'});expect(changed.status).toBe(1);expect(changed.stdout+changed.stderr).toContain('REPORT_INPUTS_CHANGED');expect(readFileSync(join(dir,'with-report.json'),'utf8')).toBe(motion);expect(readFileSync(join(dir,'report.json'),'utf8')).toBe(previous);}finally{writeFileSync(join(dir,'map.json'),beforeMap);}
    const check='assertReportInputs([rigSnapshot,mapSnapshot,poseSnapshot]);';
    writeFileSync(file,"import { utimesSync as touchReportInput } from 'node:fs';\n"+original.replace(check,'touchReportInput(a.map,0,0); '+check));
    const touched=spawnSync(process.execPath,[join(mutant,'cli.ts'),...args,'--out',join(dir,'with-report.json'),'--report',join(dir,'report.json')],{encoding:'utf8'});
    expect(touched.status,touched.stdout+touched.stderr).toBe(0);
    expect(readFileSync(join(dir,'with-report.json'),'utf8')).toBe(motion);
    expect(readFileSync(join(dir,'report.json'),'utf8')).toBe(previous);

    const consumption='const kept = buildInto(input.rig,';expect(original.split(consumption)).toHaveLength(2);
    writeFileSync(file,original.replace(consumption,"writeFileSync(input.rig, readFileSync(input.rig, 'utf8') + ' '); "+consumption));
    const rig=join(dir,'rig.json'),beforeRig=readFileSync(rig),build=join(dir,'late-build');
    try {
     const late=spawnSync(process.execPath,[join(mutant,'cli.ts'),...args,'--build',build,'--out',join(dir,'with-report.json'),'--report',join(dir,'report.json')],{encoding:'utf8'});
     expect(late.status,late.stdout+late.stderr).toBe(1);
     expect(late.stdout+late.stderr).toContain('REPORT_INPUTS_CHANGED');
     // The compatible edited rig reached the real final build; report/motion
     // keep their previous bytes rather than certifying its older rig hash.
     expect(readFileSync(join(build,'skeleton.model.json'),'utf8')).toContain('report_probe');
     expect(readFileSync(join(dir,'with-report.json'),'utf8')).toBe(motion);
     expect(readFileSync(join(dir,'report.json'),'utf8')).toBe(previous);
    } finally {writeFileSync(rig,beforeRig);}
   }finally{rmSync(mutant,{recursive:true,force:true});}
   const report=JSON.parse(readFileSync(join(dir,'report.json'),'utf8')) as {frameTimes:number[];landings:{frame:number;t:number}[];inputs:ReportInputs};for(const key of ['rig','map','pose'] as const){const path=join(dir,key+'.json');expect(report.inputs[key]).toEqual({path:relative(process.cwd(),realpathSync(path)).split('\\').join('/'),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});}expect(report.frameTimes).toEqual([0,.5,1]);for(const event of report.landings)expect(event.t).toBe(report.frameTimes[event.frame]!);
  }finally{rmSync(dir,{recursive:true,force:true});}
 },60_000);
});
