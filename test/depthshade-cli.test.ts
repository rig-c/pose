/** Real installed CLI refusals before the build gate; no mocks or private resolver. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPoseSequence } from '../src/pose.ts';

const root = join(import.meta.dir,'..');
function run(extra: string[], pose=join(root,'examples/walk/pose.json'), out=join(tmpdir(),'depthshade-never-written.json')) {
  const r=spawnSync(process.execPath,[join(root,'cli.ts'),'retarget','--rig',join(root,'examples/wave/rig'),'--map',join(root,'examples/walk/map.json'),'--pose',pose,'--out',out,...extra],{encoding:'utf8',cwd:root});
  return {status:r.status,log:(r.stdout??'')+(r.stderr??'')};
}
test('#446 installed CLI parses exact flag and rejects range before source or build',()=>{
  for(const k of ['-0.1','1.1','NaN','Infinity','']) {
    const r=run(['--depth-shade',k]);
    expect(r.status).toBe(2);expect(r.log).toContain('--depth-shade');expect(r.log).toContain('[0, 1]');
    expect(r.log).not.toContain('RIG_GATE');
  }
  for(const k of ['0','1','.8']) {
    const r=run(['--depth-shade',k]);expect(r.status).toBe(1);expect(r.log).toContain('DEPTH_SHADE_SOURCE');
    expect(r.log).not.toContain('RIG_GATE');
  }
},30_000);
test('#446 legal zero-ratio sequence reads, then named shade geometry refusal before gate and output',()=>{
  const dir=mkdtempSync(join(tmpdir(),'depth446-cli-'));
  try {
    const seq=JSON.parse(readFileSync(join(root,'examples/walk/pose.json'),'utf8'));
    seq.spec='rig-pose-sequence/1.2';seq.cleaned.params.depth={gait:'run'};
    const names=['r_upper_arm','r_forearm','r_thigh','r_shin','l_upper_arm','l_forearm','l_thigh','l_shin'];
    for(const frame of seq.frames)frame.depth=Object.fromEntries(names.map(n=>[n,{ratio:1,sign:0,source:'derived'}]));
    seq.frames[0].depth.r_thigh.ratio=0;
    const path=join(dir,'pose.json'),out=join(dir,'motion.json');writeFileSync(path,JSON.stringify(seq));
    expect(()=>readPoseSequence(readFileSync(path,'utf8'),'zero-ratio')).not.toThrow();
    const r=run(['--depth-shade','.8'],path,out);
    expect(r.status).toBe(1);expect(r.log).toContain('DEPTH_SHADE_GEOMETRY');expect(r.log).toContain('legal ratio 0');
    expect(r.log).not.toContain('RIG_GATE');expect(existsSync(out)).toBe(false);
  }finally{rmSync(dir,{recursive:true,force:true});}
},30_000);

test('#446 selector dependency/empty tokens are usage errors; unknown and unsupported exact names refuse before gate/output',()=>{
 const dir=mkdtempSync(join(tmpdir(),'depth446-selection-cli-')),out=join(dir,'never.json');
 try {
  for(const extra of [['--depth-shade-chains','leg_r'],...['',',','leg_r,',',leg_r','leg_r, ,leg_l'].map(list=>['--depth-shade','.8','--depth-shade-chains',list])]){
   const r=run(extra,undefined,out);expect(r.status).toBe(2);expect(r.log).toContain('--depth-shade-chains');expect(r.log).not.toContain('RIG_GATE');expect(existsSync(out)).toBe(false);
  }
  for(const name of ['unknown','LEG_R','trunk','head']){
   const r=run(['--depth-shade','.8','--depth-shade-chains',name],undefined,out);expect(r.status).toBe(1);expect(r.log).toContain('DEPTH_SHADE_CHAINS');expect(r.log).toContain(name);expect(r.log).not.toContain('DEPTH_SHADE_SOURCE');expect(r.log).not.toContain('RIG_GATE');expect(existsSync(out)).toBe(false);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
},30_000);
