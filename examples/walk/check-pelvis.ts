/**
 * The waistband reader's picture check (rig-c/pose#318): each frame of a
 * `make-pelvis.ts` variant cropped around the hips, with the band's top edge as
 * drawn (green, the truth), the fold's edge where the variant has one (blue),
 * and the line the reader read (red, at the read tilt through the band edge's
 * midpoint) — or a red cross where it declined the frame. A reading that
 * follows a fold shows as a red line on the blue one instead of the green.
 *
 *   bun examples/walk/check-pelvis.ts <out.png> [variant] [silhouette|waistband]
 *
 * Synthetic frames only: the same call writes the same bytes.
 */
import { Plate, type RGBA } from 'rig-c/plate';
import { readPelvis, type PelvisMode } from '../../src/pelvis.ts';
import { readPoseSequence } from '../../src/pose.ts';
import { bandEdgeMid, bandTilt, drawFrame, foldTilt, VARIANTS, variantCycle, type Variant } from './make-pelvis.ts';
import { walkDoc } from './make-walk.ts';

const RAD = Math.PI / 180;
/** The crop around the band edge's midpoint, px, and its scale on the sheet. */
const HALF = 40;
const SCALE = 3;
const COLS = 6;
const GREEN: RGBA = [0, 170, 0, 255];
const BLUE: RGBA = [40, 90, 255, 255];
const RED: RGBA = [230, 0, 0, 255];
const INK: RGBA = [20, 20, 20, 255];

/** The sheet: one tile per frame, its number above it. */
export function checkSheet(variant: Variant, mode: PelvisMode = 'waistband'): Plate {
  const cycle = variantCycle(variant);
  // The joints as the variant's sequence carries them (the same document `writePelvisFixture` writes).
  const seq = readPoseSequence(JSON.stringify(walkDoc(cycle, `check-pelvis (${variant})`)), variant);
  const tile = 2 * HALF * SCALE;
  const rows = Math.ceil(cycle.length / COLS);
  const sheet = new Plate(COLS * (tile + 8) + 8, rows * (tile + 24) + 8);
  sheet.rect(0, 0, sheet.width, sheet.height, [255, 255, 255, 255]);
  cycle.forEach((f, i) => {
    const plate = drawFrame(f, variant);
    const reading = readPelvis(plate, seq.frames[i]!.people[0]!.joints, mode);
    const [mx, my] = bandEdgeMid(f);
    const ox = 8 + (i % COLS) * (tile + 8);
    const oy = 8 + Math.floor(i / COLS) * (tile + 24);
    sheet.text(`f${String(i).padStart(2, '0')}`, ox, oy, 2, INK);
    const ty = oy + 18;
    for (let y = 0; y < 2 * HALF; y++) {
      for (let x = 0; x < 2 * HALF; x++) {
        const px = plate.get(Math.round(mx) - HALF + x, Math.round(my) - HALF + y);
        sheet.rect(ox + x * SCALE, ty + y * SCALE, SCALE, SCALE, px);
      }
    }
    /** A line at the Spine angle `deg` through the band edge's midpoint (the tile's centre), across the tile. */
    const line = (deg: number, colour: RGBA) => {
      const dx = Math.cos(deg * RAD) * HALF * SCALE;
      const dy = -Math.sin(deg * RAD) * HALF * SCALE;
      const cx = ox + HALF * SCALE;
      const cy = ty + HALF * SCALE;
      sheet.line(cx - dx, cy - dy, cx + dx, cy + dy, 2, colour);
    };
    line(bandTilt(f.phi), GREEN);
    const fold = foldTilt(f);
    if (variant === 'dithered-fold' && fold !== null) line(fold, BLUE);
    if ('tilt' in reading) line(reading.tilt, RED);
    else {
      sheet.line(ox + 6, ty + 6, ox + tile - 6, ty + tile - 6, 3, RED);
      sheet.line(ox + tile - 6, ty + 6, ox + 6, ty + tile - 6, 3, RED);
    }
  });
  return sheet;
}

if (import.meta.main) {
  const [out, v = 'dithered-fold', mode = 'waistband'] = process.argv.slice(2);
  if (out === undefined || !(VARIANTS as readonly string[]).includes(v) || (mode !== 'silhouette' && mode !== 'waistband')) {
    process.stderr.write(`usage: bun examples/walk/check-pelvis.ts <out.png> [${VARIANTS.join('|')}] [silhouette|waistband]\n`);
    process.exit(2);
  }
  checkSheet(v as Variant, mode).writePng(out);
  process.stdout.write(`wrote ${out}\n`);
}
