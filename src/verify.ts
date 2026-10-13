/**
 * Whether the rig lands where the pose says, measured on the gated build by
 * rig-c's own poser — not by the arithmetic that wrote the keys.
 *
 * The retarget's key formula holds for a bone that inherits rotation from its
 * parent with unit scale and no shear, and no constraint pulling it. A rig
 * outside that (an IK constraint on an arm, a scaled parent) is not refused by
 * a guess about which rigs are safe; it is posed, and the distance between the
 * aim each bone reached and the aim the pose asked for is the verdict.
 */
import { poseRawAnimation, type CompiledDocument, type RawBone } from 'rig-c/core';
import type { JointMap } from './map.ts';
import type { Retarget } from './retarget.ts';
import { wrap } from './retarget.ts';

const DEG = 180 / Math.PI;

export interface Landing {
  bone: string;
  /** The largest |reached − asked| over the frames, degrees (rotate) or world units (translate). */
  worst: number;
  frame: number;
  kind: 'angle' | 'origin';
}

/**
 * Tolerances, from what the writer does to a value: a rotate key is rounded to
 * 0.001° and a chain accumulates one rounding per link, rig-c stores numbers as
 * float32 (≈ 1e-5° at these magnitudes), and a key time is stored float32
 * rounded down; 0.01° and 0.01 world units sit an order above that sum for
 * chains up to ten links.
 */
export const ANGLE_TOLERANCE = 0.01;
export const ORIGIN_TOLERANCE = 0.01;

export function measureLanding(doc: CompiledDocument, animation: string, map: JointMap, r: Retarget): Landing[] {
  const steps = r.times.slice(1).map((t, i) => t - r.times[i]!);
  // Pose 0 is the animation applied at t = 0 only under reset 'animation' (render's walk); under 'setup' it is the setup pose (rig-c src/core/track.ts).
  const poses = poseRawAnimation(doc, animation, steps, {}, 'animation');
  const out: Landing[] = [];
  const byName = (bones: RawBone[]) => new Map(bones.map((b) => [b.name, b]));
  const posed = poses.map((p) => byName(p.bones));
  for (const c of map.chains) {
    c.bones.forEach((b, k) => {
      const aim = c.aim[k]!;
      const asked = r.targets.get(b)!;
      let worst = -1;
      let frame = 0;
      posed.forEach((bones, i) => {
        const o = bones.get(b)!;
        const reached = aim === 'x' ? Math.atan2(o.c, o.a) * DEG : Math.atan2(bones.get(aim)!.worldY - o.worldY, bones.get(aim)!.worldX - o.worldX) * DEG;
        const e = Math.abs(wrap(reached - asked[i]!));
        if (e > worst) {
          worst = e;
          frame = i;
        }
      });
      out.push({ bone: b, worst, frame, kind: 'angle' });
    });
  }
  if (r.origin !== null) {
    let worst = -1;
    let frame = 0;
    posed.forEach((bones, i) => {
      const o = bones.get(r.origin!.bone)!;
      const [x, y] = r.origin!.at[i]!;
      const e = Math.hypot(o.worldX - x, o.worldY - y);
      if (e > worst) {
        worst = e;
        frame = i;
      }
    });
    out.push({ bone: r.origin.bone, worst, frame, kind: 'origin' });
  }
  return out;
}

export function landed(l: Landing): boolean {
  return l.worst <= (l.kind === 'angle' ? ANGLE_TOLERANCE : ORIGIN_TOLERANCE);
}
