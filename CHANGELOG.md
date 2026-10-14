# Changelog

## [0.19.0](https://github.com/rig-c/pose/compare/v0.18.0...v0.19.0) (2026-10-14)


### Features

* **pelvis:** scale long covered spans by the clip's detector hip gain ([#106](https://github.com/rig-c/pose/issues/106)) ([#121](https://github.com/rig-c/pose/issues/121)) ([6c2ecd9](https://github.com/rig-c/pose/commit/6c2ecd9ca70e2b609b07d0269c18f707e3d61dbe))


### Bug Fixes

* **legs:** hold planted foot horizontal anchor from landing through blend ([#102](https://github.com/rig-c/pose/issues/102)) ([#122](https://github.com/rig-c/pose/issues/122)) ([c2e0e73](https://github.com/rig-c/pose/commit/c2e0e739f3d847fdf8270cdcb3405d643543ca31))

## [0.18.0](https://github.com/rig-c/pose/compare/v0.17.0...v0.18.0) (2026-10-14)


### Features

* **retarget:** --plant-feet under an in-place gait holds the hip's travel and closes the loop ([#92](https://github.com/rig-c/pose/issues/92)) ([#104](https://github.com/rig-c/pose/issues/104)) ([ed8bff7](https://github.com/rig-c/pose/commit/ed8bff78fadbbe6edea2bbf90aec770942b4d2e9))
* **retarget:** --reduce composes with --leg-scale, --plant-feet and --stance ([#94](https://github.com/rig-c/pose/issues/94)) ([#117](https://github.com/rig-c/pose/issues/117)) ([041cf3e](https://github.com/rig-c/pose/commit/041cf3ef20b930fd888135d641133b7661bf1977))
* **retarget:** --stance's stretch bound is derived from the leg's own range in the sequence ([#95](https://github.com/rig-c/pose/issues/95)) ([#115](https://github.com/rig-c/pose/issues/115)) ([397ff75](https://github.com/rig-c/pose/commit/397ff75e4e57ce64d1c57b2a9c5d28fe07712ff8))
* **retarget:** a hand that meets the body is placed by its offset from the hip (place: "by-hip") ([#93](https://github.com/rig-c/pose/issues/93)) ([#112](https://github.com/rig-c/pose/issues/112)) ([eb40ad8](https://github.com/rig-c/pose/commit/eb40ad8f38b6c0c970ed0e5ab70addf69d1872d5))


### Bug Fixes

* **retarget:** --stance's tolerance is a distance, so a free ankle far below the supporting one is reported, not planted ([#114](https://github.com/rig-c/pose/issues/114)) ([#120](https://github.com/rig-c/pose/issues/120)) ([5959fcf](https://github.com/rig-c/pose/commit/5959fcfff3ecae2f466ebb8bced69fd5af0d465a))
* **retarget:** on a run not declared in place, the supporting foot is the lower ankle in the picture ([#113](https://github.com/rig-c/pose/issues/113)) ([#118](https://github.com/rig-c/pose/issues/118)) ([a7d0e16](https://github.com/rig-c/pose/commit/a7d0e1696091bfc5c7bfff075b7367a28bcfd121))

## [0.17.0](https://github.com/rig-c/pose/compare/v0.16.0...v0.17.0) (2026-10-14)


### Features

* **clean:** a stillness hold writes a still joint as one position, per joint, cross-faded where two holds meet ([#91](https://github.com/rig-c/pose/issues/91)) ([#99](https://github.com/rig-c/pose/issues/99)) ([0218bf1](https://github.com/rig-c/pose/commit/0218bf149bdda8680d4b77da329bad159117c04e))
* **pose:** hips measured off the skirt's waistband (tools/pelvis.py), hipsInferred by "measured", and POSTURE reads the measured tilt ([#86](https://github.com/rig-c/pose/issues/86)) ([#96](https://github.com/rig-c/pose/issues/96)) ([8eee843](https://github.com/rig-c/pose/commit/8eee843da531b2fcb487589fc862a2edf2e54f91))
* **retarget:** --plant-feet puts every support span on one floor, the supporting leg carrying the blend ([#85](https://github.com/rig-c/pose/issues/85)) ([#100](https://github.com/rig-c/pose/issues/100)) ([4af5cd0](https://github.com/rig-c/pose/commit/4af5cd00a456329f75265c998f07a0afdbadfbe4))
* **scan:** the camera snapped on the floor at hand-labelled zoom windows (--camera-windows) ([#82](https://github.com/rig-c/pose/issues/82)) ([#90](https://github.com/rig-c/pose/issues/90)) ([0b3e9ff](https://github.com/rig-c/pose/commit/0b3e9fff3e383be2d2535f21825ba8109817b0da))


### Bug Fixes

* **pose:** the pelvis misread guard reads both neighbours, and a long declined run holds the earlier read ([#86](https://github.com/rig-c/pose/issues/86)) ([#97](https://github.com/rig-c/pose/issues/97)) ([29e6289](https://github.com/rig-c/pose/commit/29e62899651945e2e8ab3341224cbdf3458c5849))
* **readme:** the --report paragraph lists feet and gate as written ([#83](https://github.com/rig-c/pose/issues/83)) ([#84](https://github.com/rig-c/pose/issues/84)) ([d67bdd0](https://github.com/rig-c/pose/commit/d67bdd021bdaa18c9b4199c38332c1c8c381b2ab))
* **retarget:** --stance reads its tolerance with hysteresis, and a crossing shorter than 0.1 s is absorbed ([#87](https://github.com/rig-c/pose/issues/87)) ([#89](https://github.com/rig-c/pose/issues/89)) ([81de6d1](https://github.com/rig-c/pose/commit/81de6d192e073eb6f8cf09ab86978f843b471261))
* **scan:** a cleaned input is refused by name; the order is scan → clean → retarget ([#80](https://github.com/rig-c/pose/issues/80)) ([#81](https://github.com/rig-c/pose/issues/81)) ([a3099dd](https://github.com/rig-c/pose/commit/a3099ddfa1953f4023b1d6b41a627ffcc043c622))

## [0.16.0](https://github.com/rig-c/pose/compare/v0.15.0...v0.16.0) (2026-10-14)


### Features

* **retarget:** a raised arm placed by the hand's offset from the head, reach-limited (--raised-by-head) ([#78](https://github.com/rig-c/pose/issues/78)) ([7a200ee](https://github.com/rig-c/pose/commit/7a200eee29cd41a1ae681f4d77ec6a7dc7ee074f))

## [0.15.0](https://github.com/rig-c/pose/compare/v0.14.0...v0.15.0) (2026-10-14)


### Features

* **pose:** an `inferred` joint state, declared at clean (--hips-inferred), and POSTURE leaves out a tilt read from inferred hips ([#63](https://github.com/rig-c/pose/issues/63)) ([#77](https://github.com/rig-c/pose/issues/77)) ([610a06c](https://github.com/rig-c/pose/commit/610a06ca0bfbb050540feaf36b64ff278e9874a2))


### Bug Fixes

* **readme:** the idle and alternates examples in generic names ([#74](https://github.com/rig-c/pose/issues/74)) ([376f524](https://github.com/rig-c/pose/commit/376f524fb9aeecb3da5af2a70efff921b7706d3c))

## [0.14.0](https://github.com/rig-c/pose/compare/v0.13.0...v0.14.0) (2026-10-13)


### Features

* **clean:** rig-pose clean, and retarget requires a cleaned sequence ([#69](https://github.com/rig-c/pose/issues/69)) ([7bbd921](https://github.com/rig-c/pose/commit/7bbd921f25569cb61ff4451bb0863d0468f0a010))

## [0.13.0](https://github.com/rig-c/pose/compare/v0.12.0...v0.13.0) (2026-10-13)


### Features

* **pose:** the picture's camera, tracked or hand-labelled, carried in the sequence and normalised out ([#63](https://github.com/rig-c/pose/issues/63) phase 1) ([#66](https://github.com/rig-c/pose/issues/66)) ([fa27b7e](https://github.com/rig-c/pose/commit/fa27b7e096672bdf9a7ca4caf6b3520c0b45301f))

## [0.12.0](https://github.com/rig-c/pose/compare/v0.11.1...v0.12.0) (2026-10-13)


### Features

* **retarget:** plant both feet when the free ankle is within a tolerance of the floor (--stance) ([#64](https://github.com/rig-c/pose/issues/64)) ([b8f359e](https://github.com/rig-c/pose/commit/b8f359ea6e67f17648c04e6c1b331ddff9ad5380))

## [0.11.1](https://github.com/rig-c/pose/compare/v0.11.0...v0.11.1) (2026-10-13)


### Bug Fixes

* **readme:** the five places a first-time agent trips ([#58](https://github.com/rig-c/pose/issues/58)) ([25d89fe](https://github.com/rig-c/pose/commit/25d89fee2a458227bb346f8ccc0abb7c8db23a6c))

## [0.11.0](https://github.com/rig-c/pose/compare/v0.10.0...v0.11.0) (2026-10-13)


### Features

* **retarget:** thin the dense keys to few keys with curves within a stated tolerance (--reduce, --reduce-hip) ([#55](https://github.com/rig-c/pose/issues/55)) ([7628814](https://github.com/rig-c/pose/commit/762881441c6db7739e8a4fee4c81f2b17390fd8f))

## [0.10.0](https://github.com/rig-c/pose/compare/v0.9.0...v0.10.0) (2026-10-13)


### Features

* **retarget:** report the idle tracks the motion drops, carry them looped (--carry-idle), and merge a timed track fragment (--merge) ([#53](https://github.com/rig-c/pose/issues/53)) ([391ac62](https://github.com/rig-c/pose/commit/391ac623c49fa009e006c2e43254e2803fb98c74))

## [0.9.0](https://github.com/rig-c/pose/compare/v0.8.1...v0.9.0) (2026-10-13)


### Features

* **retarget:** legs foreshortened along their axis and feet planted, so the hip carries the pose's bounce (opt-in) ([#50](https://github.com/rig-c/pose/issues/50)) ([9a11c97](https://github.com/rig-c/pose/commit/9a11c9771a0fcc3df0ce50cd0ad77afaca6d539e))

## [0.8.1](https://github.com/rig-c/pose/compare/v0.8.0...v0.8.1) (2026-10-13)


### Bug Fixes

* **retarget:** read the older pose name, --images, the rigc version, and why a frames window did not switch ([#48](https://github.com/rig-c/pose/issues/48)) ([72d455b](https://github.com/rig-c/pose/commit/72d455bce1395caaca16e9bf3d9c6e7e07b19de1))

## [0.8.0](https://github.com/rig-c/pose/compare/v0.7.0...v0.8.0) (2026-10-13)


### Features

* **compare:** the reference and the rig's render, measured by the same detector, differences per body unit ([#41](https://github.com/rig-c/pose/issues/41)) ([d94dc58](https://github.com/rig-c/pose/commit/d94dc58fdb9ec275229477b6e4265a7c8e8a1826))

## [0.7.0](https://github.com/rig-c/pose/compare/v0.6.0...v0.7.0) (2026-10-13)


### Features

* **switch:** --switch-at peak keys a set switch at its handoff's speed peak, bounded; first stays the default ([#39](https://github.com/rig-c/pose/issues/39)) ([2598a17](https://github.com/rig-c/pose/commit/2598a1749ebff6ae272ecf67071e2664d2bb58f3))

## [0.6.0](https://github.com/rig-c/pose/compare/v0.5.0...v0.6.0) (2026-10-13)


### Features

* **map:** a set's frames windows, a stopgap for key skeletons the angles cannot tell apart ([#36](https://github.com/rig-c/pose/issues/36)) ([01b10e3](https://github.com/rig-c/pose/commit/01b10e3617774d1ce9d779bae35a67f526fa8304))

## [0.5.0](https://github.com/rig-c/pose/compare/v0.4.0...v0.5.0) (2026-10-13)


### Features

* **retarget:** a set's turn holds its art within a stated turn from the drawn angle ([#30](https://github.com/rig-c/pose/issues/30)) ([9196aa9](https://github.com/rig-c/pose/commit/9196aa9eb45d62a17a59303916a8f998f2e63d98))

## [0.4.0](https://github.com/rig-c/pose/compare/v0.3.0...v0.4.0) (2026-10-13)


### Features

* **retarget:** alternate sets switched by attachment keys, range clamps, and the demand lists ([#28](https://github.com/rig-c/pose/issues/28)) ([c149822](https://github.com/rig-c/pose/commit/c14982266a592617f5cd58abaf1db28bf6db2036))

## [0.3.0](https://github.com/rig-c/pose/compare/v0.2.1...v0.3.0) (2026-10-13)


### Features

* **retarget:** --short holds a limb segment seen end-on, and lists the end-on spans as alternate demand ([#23](https://github.com/rig-c/pose/issues/23)) ([13f6ffb](https://github.com/rig-c/pose/commit/13f6ffbe9fa0cf9a5fc71ecf345719d2b7956071))

## [0.2.1](https://github.com/rig-c/pose/compare/v0.2.0...v0.2.1) (2026-10-13)


### Bug Fixes

* **build:** build --build where it will live, so it carries no path out of it; and a runnable example ([#20](https://github.com/rig-c/pose/issues/20)) ([fb779cd](https://github.com/rig-c/pose/commit/fb779cdd62e53608cd4f269f353ba33dcf40e619))

## [0.2.0](https://github.com/rig-c/pose/compare/v0.1.1...v0.2.0) (2026-10-13)


### Features

* **retarget:** --flip spreads a limb's one-frame step over the frames around it ([#16](https://github.com/rig-c/pose/issues/16)) ([e21952d](https://github.com/rig-c/pose/commit/e21952d5c3b883b33207ab50cecf131466c38eb7))

## [0.1.1](https://github.com/rig-c/pose/compare/v0.1.0...v0.1.1) (2026-10-13)


### Bug Fixes

* **gates:** lint and tests read this tree only, not an agent worktree nested in it ([#12](https://github.com/rig-c/pose/issues/12)) ([df884d6](https://github.com/rig-c/pose/commit/df884d61209d18d678c47251a3d80a1df8d69038))

## 0.1.0 (2026-10-13)


### Features

* **cli:** the rig-pose command, its doctrine and its release machinery ([#2](https://github.com/rig-c/pose/issues/2)) ([3a1bf5f](https://github.com/rig-c/pose/commit/3a1bf5ffffaeb4b8a03d7c7830784e6666d2536a))
* **map:** aim a bone between two of its points, so a head turns by its eye line ([#5](https://github.com/rig-c/pose/issues/5)) ([a7fa4e5](https://github.com/rig-c/pose/commit/a7fa4e523d8afe33128a0f7a8d0d72023b8486e6))
* **retarget:** a body-18 pose sequence onto a rig-c rig as bone keys, gated and measured ([#4](https://github.com/rig-c/pose/issues/4)) ([e4055d1](https://github.com/rig-c/pose/commit/e4055d10b0a8ed08155df4bb8d439173819abb27))
* **retarget:** the pelvis tilts and the trunk reaches; Savitzky–Golay smoothing; a missing --out directory is refused ([#9](https://github.com/rig-c/pose/issues/9)) ([1f0afd6](https://github.com/rig-c/pose/commit/1f0afd6e8649d3f34723b656ef8bb2a924072d8f))


### Bug Fixes

* **gate:** keep a build rigc can draw where --build copies it ([#7](https://github.com/rig-c/pose/issues/7)) ([e405e56](https://github.com/rig-c/pose/commit/e405e56d9d5a7a5850cf4f92d1bcadc081b43b3d))


### Documentation

* **readme:** the measured --smooth setting, and the five moments 0.2 fixes ([#10](https://github.com/rig-c/pose/issues/10)) ([035a1fc](https://github.com/rig-c/pose/commit/035a1fc8a804176bfd1561fe3145294a291bdd4b))
