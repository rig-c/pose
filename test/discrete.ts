/**
 * The guard of rig-c/pose#334: no discrete key a retarget writes sits on a frame time.
 *
 * A discrete key (an `attachment` key, a `drawOrder` key, an `events` key, any key of a track with a `stepped` key)
 * applies when its time ≤ the render's track time. That track time is a running sum of 1/fps, and the key is held
 * as float32, so a key exactly on a frame time is a tie the render breaks a frame late on about half the keys
 * (rig-c/pose#325). pose writes every such key half a frame before the frame it shows on (`keyAtFrame` in
 * `src/switch.ts`); a key on frame 0 is at 0, frame 0's own time, where there is no tie.
 */

type Key = { t: number; ease?: unknown };
type Track = { bone?: string; slot?: string; property: string; keys: Key[] };
export interface MotionDoc {
  animations: Record<string, { tracks?: unknown[]; drawOrder?: Key[]; events?: Key[] }>;
}

/** Every discrete key of every animation, named: `dance slot "head" attachment key 2`. */
export function discreteKeys(motion: MotionDoc): Array<{ where: string; t: number }> {
  const out: Array<{ where: string; t: number }> = [];
  for (const [name, a] of Object.entries(motion.animations)) {
    for (const tr of (a.tracks ?? []) as Track[]) {
      if (tr.property !== 'attachment' && !tr.keys.some((k) => k.ease === 'stepped')) continue;
      const who = tr.slot !== undefined ? `slot "${tr.slot}"` : `bone "${tr.bone}"`;
      tr.keys.forEach((k, i) => out.push({ where: `${name} ${who} ${tr.property} key ${i}`, t: k.t }));
    }
    (a.drawOrder ?? []).forEach((k, i) => out.push({ where: `${name} drawOrder key ${i}`, t: k.t }));
    (a.events ?? []).forEach((k, i) => out.push({ where: `${name} events key ${i}`, t: k.t }));
  }
  return out;
}

/**
 * The discrete keys on a frame time other than frame 0's, within the writer's rounding (half a microsecond):
 * `<where> (t=…) is frame f's time`. `frameTimes` is the report's: the motion key time of each pose frame.
 */
export function keysOnFrameTimes(motion: MotionDoc, frameTimes: readonly number[]): string[] {
  return discreteKeys(motion).flatMap((k) => {
    const f = frameTimes.findIndex((ft, i) => i > 0 && Math.abs(ft - k.t) <= 5e-7);
    return f < 0 ? [] : [`${k.where} (t=${k.t}) is frame ${f}'s time`];
  });
}

/**
 * The first frame each key is in force on, read the way the render reads it: frame i's track time is the running
 * sum of i steps of 1/fps, the key's time is held as float32, and a key applies when its time ≤ the track time,
 * with no epsilon. -1 for a key never in force.
 */
export function firstFrames(keys: readonly Key[], frames: number, fps: number): number[] {
  let clock = 0;
  const on = Array.from({ length: frames }, (_, i) => {
    if (i > 0) clock += 1 / fps;
    let k = -1;
    for (let j = 0; j < keys.length; j++) if (Math.fround(keys[j]!.t) <= clock) k = j;
    return k;
  });
  return keys.map((_, j) => on.indexOf(j));
}
