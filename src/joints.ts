/**
 * The joint vocabulary: body-18, as @rig-c/parts spells it in
 * `spine-parts-keypoints/1` (its `src/skeleton.ts`), and nothing else.
 *
 * `r_` and `l_` are the SUBJECT's sides: for a figure facing the viewer,
 * `r_shoulder` is on the left of the picture.
 */
export const BODY18 = [
  'nose', 'neck',
  'r_shoulder', 'r_elbow', 'r_wrist',
  'l_shoulder', 'l_elbow', 'l_wrist',
  'r_hip', 'r_knee', 'r_ankle',
  'l_hip', 'l_knee', 'l_ankle',
  'r_eye', 'l_eye', 'r_ear', 'l_ear',
] as const;
export type Body18 = (typeof BODY18)[number];

/**
 * Points a map may name that body-18 does not have, each the midpoint of two
 * body-18 joints. A virtual point is good on a frame only when both of its
 * joints are, and its score is the lower of the two.
 */
export const VIRTUAL: Readonly<Record<string, readonly [Body18, Body18]>> = {
  mid_hip: ['r_hip', 'l_hip'],
  mid_shoulder: ['r_shoulder', 'l_shoulder'],
};

export const POINT_NAMES: readonly string[] = [...BODY18, ...Object.keys(VIRTUAL)];

export function isBody18(name: string): name is Body18 {
  return (BODY18 as readonly string[]).includes(name);
}

/**
 * COCO-17, the keypoint layout of the COCO dataset and of most pose models'
 * output, in its standard order.
 */
export const COCO17 = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
] as const;

/**
 * COCO-17 → body-18. Sixteen joints are the same joint under another name
 * (COCO's `left_` is the subject's left, as body-18's `l_` is); body-18's
 * `neck`, which COCO does not have, is the midpoint of the two shoulders, as
 * OpenPose defines it, observed only when both shoulders are and scored the
 * lower of the two.
 */
export const COCO17_TO_BODY18: Readonly<Record<(typeof COCO17)[number], Body18>> = {
  nose: 'nose',
  left_eye: 'l_eye',
  right_eye: 'r_eye',
  left_ear: 'l_ear',
  right_ear: 'r_ear',
  left_shoulder: 'l_shoulder',
  right_shoulder: 'r_shoulder',
  left_elbow: 'l_elbow',
  right_elbow: 'r_elbow',
  left_wrist: 'l_wrist',
  right_wrist: 'r_wrist',
  left_hip: 'l_hip',
  right_hip: 'r_hip',
  left_knee: 'l_knee',
  right_knee: 'r_knee',
  left_ankle: 'l_ankle',
  right_ankle: 'r_ankle',
};
