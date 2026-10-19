/**
 * The seam reading's projection (rig-c/pose#216): which neighbour pairs a rig
 * declares, and what `rigc render --seam` found between them, as report rows.
 * Pure — the render itself is `src/rigc.ts`'s.
 *
 * **Where the pairs come from.** A rig spec does not carry them: `rig.json`
 * holds bones, slots and skins, and @rig-c/parts records a limb's segments in
 * `parts.json` beside the rig directory (each part's `limb`: `name`,
 * `segment`, and below a joint `joint`). So the pairs are read from the
 * `parts.json` the run is given (`--parts`), the way @rig-c/parts' own
 * `check` reads them (rig-c/parts#503): each limb's consecutive segments, the
 * upper and the one below, a pair named twice counting once in either order.
 * Each part is drawn by the slot of its name.
 *
 * **The floor** is @rig-c/parts' (#503), so the two tools agree on what a seam
 * opening is: a frame's gap or ghost counts when it holds more cells than its
 * box is long (its longer side, in cells) — thicker than one cell. rigc counts
 * a cell drawn when its centre is painted at half opacity, so an outline that
 * moves by less than a cell flips the cells along it: a line one cell deep
 * holds at most as many cells as its box is long, and a hole of any area more.
 * The rule types no number; it reads rigc's own `px`, `cell` and `box`.
 *
 * A reading, never a gate: nothing here refuses a run for what it finds.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isObject, parseJson, Refusal } from './problems.ts';

export type SeamKind = 'gap' | 'ghost';
export const SEAM_KINDS: readonly SeamKind[] = ['gap', 'ghost'];

/** One declared neighbour pair: two part names, each drawn by the slot of its name. */
export interface SeamPair {
  /** `"<a>|<b>"`, the form rigc and @rig-c/parts name a pair by. */
  pair: string;
  a: string;
  b: string;
  /** Where it was declared: `config.limbs.<limb> segment <n>, joint "<joint>"`, once per declaration. */
  declared: string[];
}

/** One `report.json` `seams` row: one consecutive span of one kind over the floor (#216). */
export interface SeamSpan {
  pair: string;
  kind: SeamKind;
  /** Inclusive render frame indices, rigc's `f<index>.png`. */
  frames: [number, number];
  /** Those frames' times in seconds, rigc's. */
  times: [number, number];
  /** The most cells of this kind on any frame of the span. */
  maxPx: number;
}

/** One `report.json` `seamPairs` row: what the reading said of one declared pair. */
export interface SeamPairReading {
  pair: string;
  declared: string[];
  /** `read`: rigc read a band; `skip`: rigc read none (the two drawings share no cell at rest); `unread`: not rendered, `reason` says why. */
  status: 'read' | 'skip' | 'unread';
  /** Frames over the floor, of either kind, ascending. */
  opens: number[];
  /** The most cells over the floor on any frame; 0 when none opens. */
  maxPx: number;
  /** Frames rigc named open whose every opening is one cell thick — under the floor, not in `seams`. */
  underFloor: number[];
  reason?: string;
}

const PARTS_SPEC = 'PARTS_JSON';

/** `--parts`: a `parts.json`, or a directory holding one. */
export function partsPath(path: string): string {
  if (!existsSync(path)) throw new Refusal([{ code: 'ARG_PATH', text: `--parts ${path} does not exist` }]);
  if (statSync(path).isDirectory()) {
    const file = join(path, 'parts.json');
    if (!existsSync(file)) throw new Refusal([{ code: 'ARG_PATH', text: `--parts ${path} is a directory with no parts.json (@rig-c/parts writes it to <out>/, beside rig/)` }]);
    return file;
  }
  return path;
}

/**
 * The neighbour pairs `parts.json` declares, in its limbs' order: each limb's
 * consecutive segments by `segment`. A record that is not one is refused by
 * name; a part with no `limb` declares nothing.
 */
export function readSeamPairs(text: string, path: string): SeamPair[] {
  const doc = parseJson(text, path, PARTS_SPEC);
  if (!isObject(doc) || !Array.isArray(doc.parts)) throw new Refusal([{ code: PARTS_SPEC, text: `${path} is not @rig-c/parts' parts.json: it has no "parts" array` }]);
  const problems: Array<{ code: string; text: string }> = [];
  const limbs = new Map<string, Array<{ part: string; segment: number; joint: string | undefined }>>();
  doc.parts.forEach((p: unknown, i: number) => {
    if (!isObject(p) || typeof p.name !== 'string' || p.name === '') {
      problems.push({ code: PARTS_SPEC, text: `${path} parts[${i}]: expected a record with a "name" string` });
      return;
    }
    if (p.limb === undefined) return;
    const l = p.limb;
    if (!isObject(l) || typeof l.name !== 'string' || !Number.isSafeInteger(l.segment) || (l.segment as number) < 0 || (l.joint !== undefined && typeof l.joint !== 'string')) {
      problems.push({ code: PARTS_SPEC, text: `${path} parts[${i}] ("${p.name}") limb: expected { name: string, segment: integer ≥ 0, joint?: string }, found ${JSON.stringify(l)}` });
      return;
    }
    const segs = limbs.get(l.name) ?? [];
    if (segs.some((s) => s.segment === l.segment)) problems.push({ code: PARTS_SPEC, text: `${path} parts[${i}] ("${p.name}"): limb "${l.name}" segment ${String(l.segment)} is already part "${segs.find((s) => s.segment === l.segment)!.part}"` });
    segs.push({ part: p.name, segment: l.segment as number, joint: l.joint as string | undefined });
    limbs.set(l.name, segs);
  });
  if (problems.length > 0) throw new Refusal(problems);
  const out: SeamPair[] = [];
  for (const [limb, segs] of limbs) {
    segs.sort((x, y) => x.segment - y.segment);
    for (let i = 1; i < segs.length; i++) {
      const [up, low] = [segs[i - 1]!, segs[i]!];
      const declared = `config.limbs.${limb} segment ${low.segment}${low.joint === undefined ? '' : `, joint "${low.joint}"`}`;
      const hit = out.find((x) => (x.a === up.part && x.b === low.part) || (x.a === low.part && x.b === up.part));
      if (hit !== undefined) hit.declared.push(declared);
      else out.push({ pair: `${up.part}|${low.part}`, a: up.part, b: low.part, declared: [declared] });
    }
  }
  return out;
}

/** A frame's opening of one kind is over the floor when it holds more cells than its box, in cells, is long. */
export function overFloor(hit: { px: number; cell: number; box: readonly number[] }): boolean {
  const long = Math.round(Math.max(hit.box[2]! - hit.box[0]!, hit.box[3]! - hit.box[1]!) / hit.cell);
  return hit.px > long;
}

interface SeamHit {
  index: number;
  time: number;
  px: number;
  cell: number;
  box: number[];
}
interface SeamDocPair {
  a: string;
  b: string;
  status: 'read' | 'skip';
  opens: number[];
  gap: { frames: SeamHit[] };
  ghost: { frames: SeamHit[] };
}

/** `seam.json` (`rigc-seam/1`): the fields this projection reads, checked; anything else is rigc's. */
export function readSeamDoc(text: string, path: string): SeamDocPair[] {
  const doc = parseJson(text, path, 'SEAM_JSON');
  const bad = (what: string): never => {
    throw new Refusal([{ code: 'SEAM_JSON', text: `${path}: ${what}; rig-c's rigc-seam/1 (its AUTHORING §8.8) is the contract this reads` }]);
  };
  if (!isObject(doc) || doc.spec !== 'rigc-seam/1' || !Array.isArray(doc.pairs)) return bad('expected spec "rigc-seam/1" with a "pairs" array');
  return doc.pairs.map((p: unknown, i: number) => {
    if (!isObject(p) || typeof p.a !== 'string' || typeof p.b !== 'string' || (p.status !== 'read' && p.status !== 'skip') || !Array.isArray(p.opens)) return bad(`pairs[${i}]: expected a, b, status read|skip, opens`);
    const kind = (k: SeamKind) => {
      const o = p[k];
      if (!isObject(o) || !Array.isArray(o.frames)) return bad(`pairs[${i}].${k}: expected { frames }`);
      const frames = o.frames.map((h: unknown, j: number) => {
        if (!isObject(h) || !Number.isSafeInteger(h.index) || typeof h.time !== 'number' || !Number.isSafeInteger(h.px) || typeof h.cell !== 'number' || !(h.cell > 0) || !Array.isArray(h.box) || h.box.length !== 4 || !h.box.every((v) => typeof v === 'number')) {
          return bad(`pairs[${i}].${k}.frames[${j}]: expected index, time, px, cell > 0, box [minX, minY, maxX, maxY]`);
        }
        return { index: h.index as number, time: h.time, px: h.px as number, cell: h.cell, box: h.box as number[] };
      });
      return { frames };
    };
    return { a: p.a, b: p.b, status: p.status, opens: p.opens.filter((n): n is number => typeof n === 'number'), gap: kind('gap'), ghost: kind('ghost') };
  });
}

/** Runs of consecutive frame indices among `hits` (ascending), each with its first and last time and its most cells. */
function runsOf(hits: readonly SeamHit[]): Array<{ frames: [number, number]; times: [number, number]; maxPx: number }> {
  const out: Array<{ frames: [number, number]; times: [number, number]; maxPx: number }> = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last !== undefined && h.index === last.frames[1] + 1) {
      last.frames[1] = h.index;
      last.times[1] = h.time;
      last.maxPx = Math.max(last.maxPx, h.px);
    } else out.push({ frames: [h.index, h.index], times: [h.time, h.time], maxPx: h.px });
  }
  return out;
}

/**
 * The report's rows from one `seam.json`: per declared pair its reading, and
 * per pair and kind one row per consecutive span of frames over the floor —
 * in the pairs' order, gap before ghost, spans in frame order.
 */
export function projectSeams(pairs: readonly SeamPair[], doc: readonly SeamDocPair[], unread: ReadonlyMap<string, string>): { seams: SeamSpan[]; seamPairs: SeamPairReading[] } {
  const seams: SeamSpan[] = [];
  const seamPairs: SeamPairReading[] = [];
  for (const p of pairs) {
    const why = unread.get(p.pair);
    const d = doc.find((x) => x.a === p.a && x.b === p.b);
    if (why !== undefined || d === undefined) {
      seamPairs.push({ pair: p.pair, declared: p.declared, status: 'unread', opens: [], maxPx: 0, underFloor: [], reason: why ?? 'seam.json holds no row for it' });
      continue;
    }
    const opens = new Set<number>();
    let maxPx = 0;
    for (const k of SEAM_KINDS) {
      const over = d[k].frames.filter(overFloor);
      for (const h of over) {
        opens.add(h.index);
        maxPx = Math.max(maxPx, h.px);
      }
      for (const r of runsOf(over)) seams.push({ pair: p.pair, kind: k, frames: r.frames, times: r.times, maxPx: r.maxPx });
    }
    const sorted = [...opens].sort((x, y) => x - y);
    seamPairs.push({ pair: p.pair, declared: p.declared, status: d.status, opens: sorted, maxPx, underFloor: d.opens.filter((f) => !opens.has(f)) });
  }
  return { seams, seamPairs };
}

/** Frame indices as runs, `[0-6, 8, 13]`, the form rigc prints a frame list in. */
export function frameRuns(frames: readonly number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < frames.length; ) {
    let j = i;
    while (j + 1 < frames.length && frames[j + 1] === frames[j]! + 1) j++;
    runs.push(i === j ? String(frames[i]) : `${frames[i]}-${frames[j]}`);
    i = j + 1;
  }
  return `[${runs.join(', ')}]`;
}

/** The run's `SEAM` lines: one per span, one per pair not read or skipped, and the count. */
export function seamLines(r: { seams: readonly SeamSpan[]; seamPairs: readonly SeamPairReading[] }, fps: number): string[] {
  const out: string[] = [];
  for (const s of r.seams) {
    out.push(`pair "${s.pair}" ${s.kind} on frame(s) ${s.frames[0]}-${s.frames[1]} (t=${s.times[0].toFixed(3)}–${s.times[1].toFixed(3)}s) at ${fps} fps, max ${s.maxPx} px — over the one-cell floor; a reading, not a gate`);
  }
  for (const p of r.seamPairs) {
    if (p.status === 'unread') out.push(`pair "${p.pair}": not read — ${p.reason}`);
    else if (p.status === 'skip') out.push(`pair "${p.pair}": SKIP — rigc read no band (the two drawings share no cell at the setup pose), so nothing was measured`);
    else if (p.underFloor.length > 0) out.push(`pair "${p.pair}": ${p.underFloor.length} frame(s) ${frameRuns(p.underFloor)} open one cell thick, under the floor — not reported`);
  }
  const read = r.seamPairs.filter((p) => p.status === 'read').length;
  const pairsOpen = new Set(r.seams.map((s) => s.pair)).size;
  out.push(`${r.seams.length} span(s) over ${pairsOpen} pair(s) at ${fps} fps — ${read} of ${r.seamPairs.length} declared pair(s) read; a reading, not a gate`);
  return out;
}
