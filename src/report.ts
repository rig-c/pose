/** Add report coordinates without touching the retarget or any source value. */
import type { JointMap } from './map.ts';
import { isObject, Problems, Refusal } from './problems.ts';

export type ReportClock={frameTimes:readonly number[]}|{fps:number;frame0:number;frames:number};
export interface RenderDomain {fps:number;frames:number}
export interface ReportInput {path:string;sha256:string}
export interface ReportInputs {rig:ReportInput;map:ReportInput;pose:ReportInput}
function fail(field:string,text:string):never {throw new Refusal([{code:'REPORT_TIMEBASE',text:`${field}: ${text}`}]);}
function finite(value:unknown,field:string):number {if(typeof value!=='number'||!Number.isFinite(value)||value<0)return fail(field,`found ${String(value)}; expected finite seconds >= 0`);return value;}
function integer(value:unknown,field:string):number {const n=finite(value,field);if(!Number.isSafeInteger(n))fail(field,`found ${n}; expected nonnegative safe integer`);return n;}
export function reportFrameTimes(clock:ReportClock):number[] {
  if('frameTimes' in clock){
    if(!Array.isArray(clock.frameTimes))fail('frameTimes','expected an explicit array');
    const values=clock.frameTimes.map((time,i)=>finite(time,`frameTimes[${i}]`));
    if(!values.length)fail('frameTimes','expected at least one explicit frame');
    for(let i=1;i<values.length;i++)if(values[i]!<=values[i-1]!)fail(`frameTimes[${i}]`,`found ${values[i]}; must follow ${values[i-1]}`);return values;
  }
  const fps=finite(clock.fps,'fps');if(fps===0)fail('fps','expected positive explicit rate');const frame0=finite(clock.frame0,'frame0'),count=integer(clock.frames,'frames');
  if(count===0)fail('frames','expected at least one frame');const times=Array.from({length:count},(_,i)=>frame0+i/fps);
  for(let i=0;i<times.length;i++){finite(times[i],`frame ${i}`);if(i>0&&times[i]!<=times[i-1]!)fail(`frame ${i}`,'uniform clock cannot represent distinct frame samples');}return times;
}
export function reportRenderDomain(input:unknown,animation:string):RenderDomain {
  if(!isObject(input)||!Array.isArray(input.sets))fail('render.sets','expected renderer frame-set metadata');
  const set=input.sets.find((value:unknown)=>isObject(value)&&value.animation===animation);
  if(!isObject(set))fail('render.animation',`missing ${JSON.stringify(animation)} frame-set metadata`);
  const fps=finite(set.fps,'render.fps'),frames=integer(set.sampled,'render.frames');if(fps===0||frames===0)fail('render','expected positive declared fps and sampled frame count');return {fps,frames};
}
function clone(value:unknown):unknown {if(Array.isArray(value))return value.map(clone);if(isObject(value))return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clone(item)]));return value;}

export function enrichReport(input:Record<string,unknown>,map:JointMap,clock:ReportClock,render:RenderDomain|null=null,inputs?:ReportInputs):Record<string,unknown> {
  const times=reportFrameTimes(clock),report=clone(input) as Record<string,unknown>;
  if(render!==null){const fps=finite(render.fps,'render.fps'),frames=integer(render.frames,'render.frames');if(fps===0||frames===0)fail('render','expected positive declared fps and sampled frame count');}
  if(report.frames!==times.length)fail('frames',`report has ${String(report.frames)}, clock has ${times.length}`);
  const problems=new Problems();
  const time=(frame:unknown,where:string):number=>{const n=integer(frame,where);if(n>=times.length)fail(where,`frame ${n} outside ${times.length} declared frames`);return times[n]!;};
  const add=(row:Record<string,unknown>,key:string,value:unknown,where:string)=>{
    if(row[key]!==undefined&&JSON.stringify(row[key])!==JSON.stringify(value))problems.add('REPORT_COORDINATE',`${where}.${key}: supplied ${JSON.stringify(row[key])}, expected ${JSON.stringify(value)}`);
    else row[key]=value;
  };
  // A joint can influence several mapped segments. Preserve all actual matches;
  // only a unique match may occupy the singular bone field.
  const bonesFor=(joint:string)=>{const bones=new Set<string>();if(map.translate?.joint===joint)bones.add(map.translate.bone);for(const chain of map.chains)for(let i=0;i<chain.bones.length;i++)if(chain.joints[i]===joint||chain.joints[i+1]===joint)bones.add(chain.bones[i]!);return [...bones];};
  const pair=(value:unknown,where:string):[number,number]=>{if(!Array.isArray(value)||value.length!==2)fail(where,'expected inclusive [first,last] frame pair');const first=integer(value[0],where+'[0]'),last=integer(value[1],where+'[1]');if(last<first)fail(where,`found [${first},${last}]; inclusive last must be >= first`);return [first,last];};
  const poseEvent=(where:string)=>/^report\.(?:holds|short|endOn|bends|flips|turns|range|artRange|raised|byHip|landings|shear|switches|cleaned\.(?:holds|seams|spikes\.found)|feet\.(?:supports|changes|steps|lowered|tracked|shifts)|stance\.(?:runs|over))\[\d+\]$/.test(where);
  const targets=(row:Record<string,unknown>,where:string)=>{
    if(row.bone!==undefined||row.slot!==undefined)return;
    const joints=typeof row.joint==='string'?[row.joint]:typeof row.point==='string'?[row.point]:Array.isArray(row.joints)?row.joints.filter((v):v is string=>typeof v==='string'):[];
    const chain=typeof row.chain==='string'?map.chains.find(c=>c.name===row.chain):undefined;
    const bones=[...new Set(chain?chain.bones:joints.flatMap(bonesFor))];
    if(bones.length===1)add(row,'bone',bones[0],where);else if(bones.length>1)add(row,'bones',bones,where);
    // Multiple affected targets remain explicit lists, never a guessed winner.
    if(typeof row.point==='string')add(row,'joint',row.point,where);
  };
  const visit=(value:unknown,where:string):void=>{
    if(Array.isArray(value)){value.forEach((row,i)=>visit(row,`${where}[${i}]`));return;}
    if(!isObject(value))return;
    // Preserve uncovered's discrete renderer times; they do not index the pose.
    if(where.startsWith('report.uncovered[')||where.startsWith('report.folds[')||where.startsWith('report.seams[')){
      if(!render)fail(where,'render-domain event requires declared renderer metadata');
      add(value,'domain','render',where);return;
    }
    // seamPairs' frame lists are the seam render's indices (#216); they carry no pose coordinate.
    if(where.startsWith('report.seamPairs['))return;
    let coordinates=false;
    if(poseEvent(where)&&value.frame!==undefined&&typeof value.frame!=='number')fail(where+'.frame','expected nonnegative integer pose frame');
    if(typeof value.frame==='number'){add(value,'t',time(value.frame,where+'.frame'),where);coordinates=true;}
    if((poseEvent(where)&&value.frames!==undefined)||(Array.isArray(value.frames)&&value.frames.length===2&&value.frames.every(frame=>typeof frame==='number'))){const frames=pair(value.frames,where+'.frames');add(value,'times',frames.map((frame,i)=>time(frame,`${where}.frames[${i}]`)),where);coordinates=true;}
    if(where.startsWith('report.holds[')&&typeof value.from==='number'&&typeof value.to==='number'){
      pair([value.from,value.to],where+'.from/to');add(value,'frames',[value.from,value.to],where);add(value,'times',[time(value.from,where+'.from'),time(value.to,where+'.to')],where);coordinates=true;
    }
    if(coordinates){if(typeof value.seconds==='number')add(value,'spanSeconds',value.seconds,where);targets(value,where);}
    // Recurse over the original fields only; added time/target arrays are data.
    for(const [key,item] of Object.entries(value))if(!['t','times','bones','spanSeconds'].includes(key))visit(item,where+'.'+key);
  };
  visit(report,'report');
  if(isObject(report.feet)&&Array.isArray(report.feet.jumps)){
    add(report.feet,'jumpEvents',report.feet.jumps.map((frames:unknown,index:number)=>{
      const interval=pair(frames,`feet.jumps[${index}]`);
      return {frames:[...interval],times:interval.map((frame,i)=>time(frame,`feet.jumps[${index}][${i}]`))};
    }),'report.feet');
  }
  // The actual producer uses frameTimes. Uniform clocks exist only when a
  // caller explicitly supplies fps/frame0, never inferred from samples.
  if('frameTimes' in clock)add(report,'frameTimes',[...times],'report');else{add(report,'fps',clock.fps,'report');add(report,'frame0',clock.frame0,'report');}
  add(report,'render',render,'report');
  if(inputs!==undefined){if(!isObject(inputs))throw new Refusal([{code:'REPORT_INPUTS',text:'inputs: expected rig, map and pose file identities'}]);for(const key of ['rig','map','pose'] as const){const entry=inputs[key];if(!isObject(entry)||typeof entry.path!=='string'||!entry.path||entry.path.startsWith('/')||entry.path.charCodeAt(0)===92||/^[A-Za-z]:/.test(entry.path)||typeof entry.sha256!=='string'||! /^[a-f0-9]{64}$/.test(entry.sha256))throw new Refusal([{code:'REPORT_INPUTS',text:`inputs.${key}: expected invocation-relative consumed file path and exact SHA-256`}]);}add(report,'inputs',clone(inputs),'report');}
  problems.throwIfAny();return report;
}
/**
 * rig-c/pose#216: `seams` and `seamPairs` are declared fields, not optional by
 * accident — a report without them is a run whose seam reading never ran, and
 * the writer refuses it by name. Each `seams` row is one span of one kind:
 * `{ pair, kind, frames: [first, last], times: [first, last], maxPx }`.
 */
export function checkSeams(input:Record<string,unknown>):void {
  const p=new Problems();
  if(!Array.isArray(input.seams))p.add('REPORT_SEAMS',`seams: found ${input.seams===undefined?'no field':JSON.stringify(input.seams)}; the report declares the seam reading's spans (rig-c/pose#216), [] when none opens or no pair is declared, and seamPairs says which`);
  if(!Array.isArray(input.seamPairs))p.add('REPORT_SEAMS',`seamPairs: found ${input.seamPairs===undefined?'no field':JSON.stringify(input.seamPairs)}; the report declares what the seam reading said of each declared pair (rig-c/pose#216), [] when none is declared`);
  p.throwIfAny();
  const int=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0;
  (input.seams as unknown[]).forEach((row,i)=>{
    const ok=isObject(row)&&typeof row.pair==='string'&&row.pair.includes('|')&&(row.kind==='gap'||row.kind==='ghost')&&Array.isArray(row.frames)&&row.frames.length===2&&row.frames.every(int)&&(row.frames[1] as number)>=(row.frames[0] as number)&&Array.isArray(row.times)&&row.times.length===2&&row.times.every(t=>typeof t==='number'&&Number.isFinite(t)&&t>=0)&&(row.times[1] as number)>=(row.times[0] as number)&&int(row.maxPx)&&(row.maxPx as number)>0;
    if(!ok)p.add('REPORT_SEAMS',`seams[${i}]: found ${JSON.stringify(row)}; expected { pair: "<a>|<b>", kind: "gap"|"ghost", frames: [first, last], times: [first, last], maxPx > 0 }`);
  });
  (input.seamPairs as unknown[]).forEach((row,i)=>{
    const ok=isObject(row)&&typeof row.pair==='string'&&(row.status==='read'||row.status==='skip'||row.status==='unread')&&(row.status!=='unread'||typeof row.reason==='string');
    if(!ok)p.add('REPORT_SEAMS',`seamPairs[${i}]: found ${JSON.stringify(row)}; expected { pair, status: "read"|"skip"|"unread", reason when unread }`);
  });
  p.throwIfAny();
}
export function writeReport(input:Record<string,unknown>,map:JointMap,clock:ReportClock,render:RenderDomain|null,inputs:ReportInputs):string {checkSeams(input);if(inputs===undefined)throw new Refusal([{code:'REPORT_INPUTS',text:'inputs: expected rig, map and pose file identities'}]);return JSON.stringify(enrichReport(input,map,clock,render,inputs),null,2)+'\n';}
