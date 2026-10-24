/** Real pose-reader preflight for the visible-retarget development recipe. */
import { readFileSync } from 'node:fs';
import { personTrack, readPoseSequence } from '../src/pose.ts';
const path = process.argv[2];
if (path === undefined) throw new Error('POSE_PATH: name the pose file to validate');
const seq = readPoseSequence(readFileSync(path, 'utf8'), path);
const track = personTrack(seq, undefined, path);
console.log(JSON.stringify({ frames: seq.frames.length, times: seq.frames.map((f) => f.t), cameraDeclared: seq.camera !== undefined, width: seq.width, height: seq.height, jointFrames: track.length }));
