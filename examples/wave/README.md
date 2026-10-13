# The wave

A runnable example with no art and no video:

- `rig/rig.json`: a stick figure's bones (trunk, head, two-link arms and legs), no slots;
- `pose.json`: a 3-second wave at 24 fps, written by `make-pose.ts` from joint angles and passed through `rig-pose clean` at its defaults, so it carries the `cleaned` record `retarget` requires (`bun examples/wave/make-pose.ts` writes it again);
- `map.json`: which bones carry which joints. The hinges are `"bend": "free"`.

```sh
rig-pose retarget --rig examples/wave/rig --map examples/wave/map.json --pose examples/wave/pose.json --out wave.motion.json --build wave-build
```
