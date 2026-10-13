# Changelog

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
