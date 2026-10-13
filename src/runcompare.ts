/**
 * `rig-pose compare`, end to end: read the two sequences, the map and the
 * optional inputs, compare (`compare.ts`), print a summary line per unit and a
 * line per finding, and write the report and the sheet when asked. A finding is
 * not a failure: the run exits 0 whenever it compared.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { compare, findingLine, readCloth, readHands, readSpans, summaryLine, writeComparison, type ClothWindow, type CompareInput, type Comparison } from './compare.ts';
import { readMap } from './map.ts';
import { personTrack, readPoseSequence, type PoseSequence } from './pose.ts';
import { Problems, Refusal } from './problems.ts';
import { drawable, drawSheet } from './sheet.ts';

export interface CompareArgs {
  reference: string;
  render: string;
  map: string;
  retargetReport?: string;
  referenceHands?: string;
  renderHands?: string;
  clothReference?: string;
  clothRender?: string;
  clothWindows?: ClothWindow[];
  report?: string;
  sheet?: string;
}

export function runCompare(a: CompareArgs, log: (line: string) => void): Comparison {
  const p = new Problems();
  const inputs: Array<[string, string | undefined]> = [
    ['--reference', a.reference], ['--render', a.render], ['--map', a.map], ['--retarget-report', a.retargetReport],
    ['--reference-hands', a.referenceHands], ['--render-hands', a.renderHands], ['--cloth-reference', a.clothReference], ['--cloth-render', a.clothRender],
  ];
  for (const [flag, path] of inputs) {
    if (path === undefined) continue;
    if (!existsSync(path)) p.add('ARG_PATH', `${flag} ${path} does not exist`);
    else if (!statSync(path).isFile()) p.add('ARG_PATH', `${flag} ${path} is not a file`);
  }
  for (const [flag, path] of [['--report', a.report], ['--sheet', a.sheet]] as const) {
    if (path === undefined) continue;
    const dir = dirname(path);
    if (!existsSync(dir)) p.add('ARG_PATH', `${flag} ${path} — directory ${dir} does not exist`);
    else if (!statSync(dir).isDirectory()) p.add('ARG_PATH', `${flag} ${path} — ${dir} is not a directory`);
  }
  p.throwIfAny();

  // Every reader runs, and every refusal is reported together.
  const all: Refusal[] = [];
  const read = <T>(f: () => T): T | null => {
    try {
      return f();
    } catch (e) {
      if (e instanceof Refusal) {
        all.push(e);
        return null;
      }
      throw e;
    }
  };
  const seqOf = (path: string) => read(() => {
    const seq = readPoseSequence(readFileSync(path, 'utf8'), path);
    return { seq, frames: personTrack(seq, undefined, path) };
  });
  const ref = seqOf(a.reference);
  const ren = seqOf(a.render);
  const map = read(() => readMap(readFileSync(a.map, 'utf8'), a.map));
  const report = a.retargetReport === undefined ? null : read(() => readSpans(readFileSync(a.retargetReport!, 'utf8'), a.retargetReport!));
  const handsA = a.referenceHands === undefined ? null : read(() => readHands(readFileSync(a.referenceHands!, 'utf8'), a.referenceHands!));
  const handsB = a.renderHands === undefined ? null : read(() => readHands(readFileSync(a.renderHands!, 'utf8'), a.renderHands!));
  const clothA = a.clothReference === undefined ? null : read(() => readCloth(readFileSync(a.clothReference!, 'utf8'), a.clothReference!));
  const clothB = a.clothRender === undefined ? null : read(() => readCloth(readFileSync(a.clothRender!, 'utf8'), a.clothRender!));
  if (all.length > 0) throw new Refusal(all.flatMap((e) => e.problems));
  if (report !== null && report.frames !== ref!.seq.frames.length) {
    throw new Refusal([{ code: 'COMPARE_REPORT', text: `${a.retargetReport} is a retarget over ${report.frames} frame(s); the reference ${a.reference} has ${ref!.seq.frames.length} — it is the report of another run` }]);
  }

  const side = (path: string, s: { seq: PoseSequence; frames: CompareInput['reference']['frames'] }) => ({ where: path, times: s.seq.frames.map((f) => f.t), frames: s.frames });
  const input: CompareInput = {
    reference: side(a.reference, ref!),
    render: side(a.render, ren!),
    map: map!,
    spans: report === null ? null : report.spans,
    retargetScale: report === null ? null : report.scale,
    hands: handsA !== null && handsB !== null ? { reference: handsA, render: handsB } : null,
    cloth: clothA !== null && clothB !== null ? { reference: clothA, render: clothB, windows: a.clothWindows ?? [] } : null,
  };
  const c = compare(input);

  log(`rig-pose compare: ${c.frames} frame(s), ${c.duration.toFixed(3)}s — reference ${a.reference}, render ${a.render}; median hip width ${px(c.hipWidth.reference)} and ${px(c.hipWidth.render)}${a.retargetReport === undefined ? '' : `; spans from ${a.retargetReport}`}`);
  for (const u of c.units) log(`  ${u.unit.toUpperCase().padEnd(6)} ${summaryLine(u, c.times)}`);
  for (const f of c.findings) log(`  FIND   ${findingLine(f, c.times)}`);
  if (c.cloth !== null) {
    for (const w of c.cloth.windows) {
      const fig = (x: { lag: number; swingRatio: number | null; overshoot: number | null; strokes: number }) => `lag ${x.lag.toFixed(3)}, swing ${x.swingRatio === null ? '—' : x.swingRatio.toFixed(3)}, overshoot ${x.overshoot === null ? '—' : x.overshoot.toFixed(3)} (${x.strokes} strokes)`;
      log(`  CLOTH  window ${w.name} ${w.t[0]}–${w.t[1]}s (frames ${w.frames[0]}–${w.frames[1]}): reference ${fig(w.reference)}; render ${fig(w.render)}; strokes from ${c.cloth.stroke.reference} and ${c.cloth.stroke.render.toFixed(4)} hip widths (reference, render)`);
    }
    if (c.cloth.windows.length > 0) log(`  CLOTH  the render's stroke threshold ${c.cloth.stroke.render.toFixed(4)} of its hip widths = ${c.cloth.stroke.carried}`);
  }
  if (a.report !== undefined) {
    writeFileSync(a.report, writeComparison(c, {
      reference: a.reference, render: a.render, map: a.map, retargetReport: a.retargetReport ?? null,
      referenceHands: a.referenceHands ?? null, renderHands: a.renderHands ?? null, clothReference: a.clothReference ?? null, clothRender: a.clothRender ?? null,
    }));
    log(`  wrote ${a.report}`);
  }
  if (a.sheet !== undefined) {
    const plate = drawSheet({ frames: ref!.frames, width: ref!.seq.width, height: ref!.seq.height }, { frames: ren!.frames, width: ren!.seq.width, height: ren!.seq.height }, c.findings);
    if (plate === null) log(`  SHEET  no finding has a frame to draw (${c.findings.length} finding(s), none outside cloth); ${a.sheet} not written`);
    else {
      plate.writePng(a.sheet);
      log(`  SHEET  ${drawable(c.findings).length} finding(s), reference | render at each worst frame: wrote ${a.sheet}`);
    }
  }
  log(`  ${c.findings.length} finding(s)`);
  return c;
}

const px = (v: number | null) => (v === null ? 'none' : `${v.toFixed(1)}px`);
