# Changelog

## [0.32.0](https://github.com/rig-c/pose/compare/v0.31.1...v0.32.0) (2026-10-19)


### Features

* **legs:** name --stance's and --leg-scale's units, and print what a clamp did to a free ankle ([#246](https://github.com/rig-c/pose/issues/246)) ([2349bf5](https://github.com/rig-c/pose/commit/2349bf5bacd65b11486b8eb02170277c16463ace))
* **readings:** SCALE, SHEAR, --reduce and MAP_CHAIN_JOINTS name their remedy ([#252](https://github.com/rig-c/pose/issues/252)) ([b9d6411](https://github.com/rig-c/pose/commit/b9d6411555d17799ab3c0b5881d86cbe64566551))
* **retarget:** a NOD line, a "nod" switch on the eye-line chain, the nod window wrapped on a loop ([#241](https://github.com/rig-c/pose/issues/241)) ([#254](https://github.com/rig-c/pose/issues/254)) ([ce62630](https://github.com/rig-c/pose/commit/ce6263091a58d0a208d953b708f98887ac49d501))
* **retarget:** accept --sequence and --animation as aliases of --pose and --name ([#253](https://github.com/rig-c/pose/issues/253)) ([1ceddc4](https://github.com/rig-c/pose/commit/1ceddc48e28c6e764e011a99eea88cafc33bade5))
* **retarget:** name what reach costs — JITTER per keyed bone, REACH departure ([#244](https://github.com/rig-c/pose/issues/244)) ([303e3fd](https://github.com/rig-c/pose/commit/303e3fd19705edb47ae7498c6993661241c997d7))
* **retarget:** output a person can read: CLEAN counts the hold, a hinge's wrong-way frames are one line, --summary and --verbose ([#248](https://github.com/rig-c/pose/issues/248)) ([67f4066](https://github.com/rig-c/pose/commit/67f40664e12be6c8e15fe49c96f63af1d81dca65))
* **retarget:** path refusals name the fix ([#239](https://github.com/rig-c/pose/issues/239)) ([#249](https://github.com/rig-c/pose/issues/249)) ([bdcfe8a](https://github.com/rig-c/pose/commit/bdcfe8adcc0be64129d96c6547f1778b4e44108a))


### Bug Fixes

* **retarget:** read travel "in-place" as the sequence's property, not --plant-feet's ([#242](https://github.com/rig-c/pose/issues/242)) ([#247](https://github.com/rig-c/pose/issues/247)) ([c403f53](https://github.com/rig-c/pose/commit/c403f531348f1622d986bd5e7d196916d36ffa42))

## [0.31.1](https://github.com/rig-c/pose/compare/v0.31.0...v0.31.1) (2026-10-18)


### Bug Fixes

* **retarget:** ramp figure scale across airborne gaps and gate mesh folds ([#231](https://github.com/rig-c/pose/issues/231)) ([#232](https://github.com/rig-c/pose/issues/232)) ([a8d5e11](https://github.com/rig-c/pose/commit/a8d5e1186ac4caa7b562be9a3587bcc178199666))

## [0.31.0](https://github.com/rig-c/pose/compare/v0.30.1...v0.31.0) (2026-10-18)


### Bug Fixes

* **legs:** remove per-cycle drift in closeLoop and wrap first-cycle plant blend ([#224](https://github.com/rig-c/pose/issues/224)) ([#227](https://github.com/rig-c/pose/issues/227)) ([1021072](https://github.com/rig-c/pose/commit/102107239a8484a980165018ba7e64b588ba0c52))
* **legs:** weight straight length by per-leg setup bone share and report clamped asked values ([#225](https://github.com/rig-c/pose/issues/225)) ([#229](https://github.com/rig-c/pose/issues/229)) ([2afc34f](https://github.com/rig-c/pose/commit/2afc34fd031d32768f6c5d46b5719759857a84f2))
* **retarget:** hold crouch-invariant segment height per support span ([#226](https://github.com/rig-c/pose/issues/226)) ([#230](https://github.com/rig-c/pose/issues/230)) ([70f0cfc](https://github.com/rig-c/pose/commit/70f0cfc439612911f48a8fa816149b40f6149de2))

## [0.30.1](https://github.com/rig-c/pose/compare/v0.30.0...v0.30.1) (2026-10-18)


### Bug Fixes

* **readme:** use neutral fixture names and remove exam canonical flags ([#219](https://github.com/rig-c/pose/issues/219)) ([#221](https://github.com/rig-c/pose/issues/221)) ([b4127ca](https://github.com/rig-c/pose/commit/b4127cab362742702dff878272313b36aec9fcd4))
* **retarget,legs:** bridge adjacent gesture sets in joint space and arch-blend short stances ([#218](https://github.com/rig-c/pose/issues/218)) ([#220](https://github.com/rig-c/pose/issues/220)) ([8da4a8c](https://github.com/rig-c/pose/commit/8da4a8cbd98fcebdf6fd84f34e8611cfe78ae726))

## [0.30.0](https://github.com/rig-c/pose/compare/v0.29.1...v0.30.0) (2026-10-18)


### Features

* **report:** bind review events to exact clocks and input hashes ([#214](https://github.com/rig-c/pose/issues/214)) ([58a6eeb](https://github.com/rig-c/pose/commit/58a6eebfb249d35c00117d186867288c43d6f954)), closes [#209](https://github.com/rig-c/pose/issues/209)


### Bug Fixes

* **retarget:** solve symmetric gesture set diamond in chest-local frame ([#207](https://github.com/rig-c/pose/issues/207)) ([#212](https://github.com/rig-c/pose/issues/212)) ([b420bae](https://github.com/rig-c/pose/commit/b420baee6e0d213e293a407084973493af8d8942))

## [0.29.1](https://github.com/rig-c/pose/compare/v0.29.0...v0.29.1) (2026-10-18)


### Bug Fixes

* **retarget:** drive nod coupling from clamped head.translate.y and bridge gesture sets in parent-local joint space ([#205](https://github.com/rig-c/pose/issues/205), [#206](https://github.com/rig-c/pose/issues/206)) ([#210](https://github.com/rig-c/pose/issues/210)) ([07df3ca](https://github.com/rig-c/pose/commit/07df3ca53aa40b2f0b7a962c1ea1aad9553d84aa))

## [0.29.0](https://github.com/rig-c/pose/compare/v0.28.0...v0.29.0) (2026-10-17)


### Features

* **retarget:** anchor hand-by-the-head alternate sets to head-local offset ([#191](https://github.com/rig-c/pose/issues/191)) ([#202](https://github.com/rig-c/pose/issues/202)) ([431730a](https://github.com/rig-c/pose/commit/431730aa111823028368414a9969e08961bb7f33))

## [0.28.0](https://github.com/rig-c/pose/compare/v0.27.0...v0.28.0) (2026-10-17)


### Features

* **retarget:** couple neck-length clamp vertical residual into pitch_dial and head.rotate ([#190](https://github.com/rig-c/pose/issues/190)) ([#199](https://github.com/rig-c/pose/issues/199)) ([886bebb](https://github.com/rig-c/pose/commit/886bebbe62ba211caf7c40d07087f3d05b364c43))

## [0.27.0](https://github.com/rig-c/pose/compare/v0.26.0...v0.27.0) (2026-10-17)


### Features

* **face:** read yaw from ear chord on foreshortened side gaze ([#189](https://github.com/rig-c/pose/issues/189)) ([#196](https://github.com/rig-c/pose/issues/196)) ([b5b4cf9](https://github.com/rig-c/pose/commit/b5b4cf9b0b07a0efc191fde9dd609b84781b0188))

## [0.26.0](https://github.com/rig-c/pose/compare/v0.25.0...v0.26.0) (2026-10-17)


### Features

* **retarget:** normalise symmetric gesture sets and anchor declared support arms ([#188](https://github.com/rig-c/pose/issues/188)) ([#194](https://github.com/rig-c/pose/issues/194)) ([c82149d](https://github.com/rig-c/pose/commit/c82149deae1f3f7478a53e084a45ec70a8e59236))

## [0.25.0](https://github.com/rig-c/pose/compare/v0.24.1...v0.25.0) (2026-10-17)


### Features

* **switch:** switch adjacent gesture sets on one frame and keep measured path ([#187](https://github.com/rig-c/pose/issues/187)) ([#192](https://github.com/rig-c/pose/issues/192)) ([9245396](https://github.com/rig-c/pose/commit/92453966859d1e5543985afd9ff3d738c4887131))

## [0.24.1](https://github.com/rig-c/pose/compare/v0.24.0...v0.24.1) (2026-10-17)


### Bug Fixes

* **retarget:** hold horizontal chains across short or reversed 2D spans ([#184](https://github.com/rig-c/pose/issues/184)) ([#185](https://github.com/rig-c/pose/issues/185)) ([b82ea5e](https://github.com/rig-c/pose/commit/b82ea5e562ba3b898d377a822fa95ab9c0f50304))

## [0.24.0](https://github.com/rig-c/pose/compare/v0.23.0...v0.24.0) (2026-10-17)


### Features

* **retarget,switch:** head-wrist raised placement, switch leave hysteresis, and detrended head-nod baseline ([#179](https://github.com/rig-c/pose/issues/179), [#180](https://github.com/rig-c/pose/issues/180), [#181](https://github.com/rig-c/pose/issues/181)) ([#182](https://github.com/rig-c/pose/issues/182)) ([02c0bce](https://github.com/rig-c/pose/commit/02c0bcec5412b4601483f2c330aff80c01df4019))

## [0.23.0](https://github.com/rig-c/pose/compare/v0.22.2...v0.23.0) (2026-10-17)


### Features

* **face:** switch alternate sets on body and face yaw ([#173](https://github.com/rig-c/pose/issues/173)) ([#178](https://github.com/rig-c/pose/issues/178)) ([fa52622](https://github.com/rig-c/pose/commit/fa526220d59c2a3b0928f5b9d5951a4ee1e288ee))
* **retarget:** read body yaw from camera-normalised shoulder and hip width ([#173](https://github.com/rig-c/pose/issues/173)) ([#176](https://github.com/rig-c/pose/issues/176)) ([551d7bc](https://github.com/rig-c/pose/commit/551d7bc959196bf4ea8bc7b4d689b16fea160d6b))

## [0.22.2](https://github.com/rig-c/pose/compare/v0.22.1...v0.22.2) (2026-10-16)


### Bug Fixes

* **retarget:** derive figure scale from posture-invariant measures and key trunk foreshortening on chest:scaley ([#172](https://github.com/rig-c/pose/issues/172)) ([#174](https://github.com/rig-c/pose/issues/174)) ([9153184](https://github.com/rig-c/pose/commit/9153184dc19f541950e5275878f67efbade320fd))

## [0.22.1](https://github.com/rig-c/pose/compare/v0.22.0...v0.22.1) (2026-10-16)


### Bug Fixes

* **reduce:** smooth trunk knots and curve handles within tolerance ([#116](https://github.com/rig-c/pose/issues/116)) ([#168](https://github.com/rig-c/pose/issues/168)) ([e7384f4](https://github.com/rig-c/pose/commit/e7384f4bc3696df4291dd6a0b91d2c756e163ff9))

## [0.22.0](https://github.com/rig-c/pose/compare/v0.21.0...v0.22.0) (2026-10-15)


### Features

* **retarget:** add continuous figure scale, --camera sidecar track, and 1:1 face knee ([#161](https://github.com/rig-c/pose/issues/161), [#163](https://github.com/rig-c/pose/issues/163), [#164](https://github.com/rig-c/pose/issues/164)) ([#167](https://github.com/rig-c/pose/issues/167)) ([41d14f7](https://github.com/rig-c/pose/commit/41d14f7152b9b4cb695c7a43f204d1c946ec2245))


### Bug Fixes

* **switch:** keep behind-to-behind gap frames on the nearer behind set ([#162](https://github.com/rig-c/pose/issues/162)) ([#165](https://github.com/rig-c/pose/issues/165)) ([ca2915f](https://github.com/rig-c/pose/commit/ca2915f9967237cb7e4601c1ebc872f15b3b1a9e))

## [0.21.0](https://github.com/rig-c/pose/compare/v0.20.5...v0.21.0) (2026-10-15)


### Features

* **retarget:** read face yaw/pitch and map into declared range ([#138](https://github.com/rig-c/pose/issues/138)) ([#156](https://github.com/rig-c/pose/issues/156)) ([728345b](https://github.com/rig-c/pose/commit/728345bc59514a546a6517f93e75622939a65116))


### Bug Fixes

* **retarget:** normalise leg-scale and head-nod against residual camera zoom ([#159](https://github.com/rig-c/pose/issues/159)) ([#160](https://github.com/rig-c/pose/issues/160)) ([975ef92](https://github.com/rig-c/pose/commit/975ef92419012ed3254657add191262c01348ad1))
* **retarget:** preserve planted ankle horizontal anchor during blend stretch ([#47](https://github.com/rig-c/pose/issues/47)) ([#158](https://github.com/rig-c/pose/issues/158)) ([71303ac](https://github.com/rig-c/pose/commit/71303ac6b73b0744ffa228be1db7135025bdbe5c))

## [0.20.5](https://github.com/rig-c/pose/compare/v0.20.4...v0.20.5) (2026-10-15)


### Bug Fixes

* **leg-scale:** share the larger 95th-percentile straight length across both legs ([#148](https://github.com/rig-c/pose/issues/148)) ([#151](https://github.com/rig-c/pose/issues/151)) ([fa54db7](https://github.com/rig-c/pose/commit/fa54db7d736afe94b4c29152fea4f40b9c9b59b0))
* **legs:** start jump at ankle push-off when mid_hip is rising ([#142](https://github.com/rig-c/pose/issues/142)) ([#152](https://github.com/rig-c/pose/issues/152)) ([901c5e1](https://github.com/rig-c/pose/commit/901c5e1accaa06bcce56c99d1adf7c5974855e64))
* **plant-feet:** fade flight carry over the landing blend instead of dropping at land+1 ([#147](https://github.com/rig-c/pose/issues/147)) ([#149](https://github.com/rig-c/pose/issues/149)) ([e91864c](https://github.com/rig-c/pose/commit/e91864c507b2631ad529fbf3e5d6aee7d0d3aeba))
* **retarget:** respect noScale inheritance when solving leg scale ([#154](https://github.com/rig-c/pose/issues/154)) ([c933d37](https://github.com/rig-c/pose/commit/c933d37ea5ae5e1d7c3c5803ce0c6722e8a2c169)), closes [#153](https://github.com/rig-c/pose/issues/153)

## [0.20.4](https://github.com/rig-c/pose/compare/v0.20.3...v0.20.4) (2026-10-15)


### Bug Fixes

* **plant-feet:** revert [#143](https://github.com/rig-c/pose/issues/143) (runShift changed dance's 3-jump grounded frames) ([#145](https://github.com/rig-c/pose/issues/145)) ([92fe1ab](https://github.com/rig-c/pose/commit/92fe1abcfd28cadffa1699f2864da25aaeb45941))

## [0.20.3](https://github.com/rig-c/pose/compare/v0.20.2...v0.20.3) (2026-10-15)


### Bug Fixes

* **plant-feet:** keep support spans' floor shift across flights on runs ([#142](https://github.com/rig-c/pose/issues/142)) ([#143](https://github.com/rig-c/pose/issues/143)) ([47ce675](https://github.com/rig-c/pose/commit/47ce675d455f4b8a79161cf312e8f6e8576d2fab))

## [0.20.2](https://github.com/rig-c/pose/compare/v0.20.1...v0.20.2) (2026-10-15)


### Bug Fixes

* **retarget:** restore shortened shin on straight stance leg before floor stretch ([#137](https://github.com/rig-c/pose/issues/137)) ([#141](https://github.com/rig-c/pose/issues/141)) ([95eb351](https://github.com/rig-c/pose/commit/95eb351196aec0f00b5ad97737c5275ac98543ee))
* **switch:** keep behind-torso arm slots across prep gaps ([#136](https://github.com/rig-c/pose/issues/136)) ([#139](https://github.com/rig-c/pose/issues/139)) ([6e62154](https://github.com/rig-c/pose/commit/6e62154482ef23b683b254271fe6d5539a5f1fed))

## [0.20.1](https://github.com/rig-c/pose/compare/v0.20.0...v0.20.1) (2026-10-14)


### Bug Fixes

* **plant-feet:** scale supporting leg under --leg-scale floor to its own range ([#133](https://github.com/rig-c/pose/issues/133)) ([#134](https://github.com/rig-c/pose/issues/134)) ([43681e7](https://github.com/rig-c/pose/commit/43681e73fc87a4f8d38962021a5de8cebe488e61))

## [0.20.0](https://github.com/rig-c/pose/compare/v0.19.0...v0.20.0) (2026-10-14)


### Features

* **retarget:** key head chain nod from eyes' vertical travel against neck ([#111](https://github.com/rig-c/pose/issues/111)) ([#129](https://github.com/rig-c/pose/issues/129)) ([1a241c6](https://github.com/rig-c/pose/commit/1a241c67aa3e18ee9aa27c25446bb9a0ef8fbfce))
* **retarget:** track the lower foot on the floor when only the higher foot is free ([#119](https://github.com/rig-c/pose/issues/119)) ([#130](https://github.com/rig-c/pose/issues/130)) ([b70b47e](https://github.com/rig-c/pose/commit/b70b47e258afca6873ea4dcbdcd621136812cb19))


### Bug Fixes

* **clean:** hold the face joints as one group ([#109](https://github.com/rig-c/pose/issues/109)) ([#126](https://github.com/rig-c/pose/issues/126)) ([f3820bb](https://github.com/rig-c/pose/commit/f3820bb93337d26f3ead94b6a052dde013cff7a4))
* **clean:** keep a held joint held around a short excursion ([#108](https://github.com/rig-c/pose/issues/108)) ([#124](https://github.com/rig-c/pose/issues/124)) ([9a768c7](https://github.com/rig-c/pose/commit/9a768c71e0904177e7f102d8c5f5dd2bfa26c3f8))
* **legs:** carry jump travel to land on the floor and keep flight frames above it ([#103](https://github.com/rig-c/pose/issues/103)) ([57970fd](https://github.com/rig-c/pose/commit/57970fdfcf357629f76baf37d230118f0494de80))
* **legs:** distinguish a raised heel at a hand-over from a jump by the front foot's landing ([#101](https://github.com/rig-c/pose/issues/101)) ([74c70e5](https://github.com/rig-c/pose/commit/74c70e5e268b020027ad2d3dc6f7cfef8c1bbd81))
* **retarget:** ease clampArt at set edges and cap foreshortened steps ([#110](https://github.com/rig-c/pose/issues/110)) ([#127](https://github.com/rig-c/pose/issues/127)) ([b2fcb52](https://github.com/rig-c/pose/commit/b2fcb5280b07aba86bcb3fa912ffc34505708124))
* **retarget:** place hip from unclamped leg reach and land leg scales ([#128](https://github.com/rig-c/pose/issues/128)) ([470cdcc](https://github.com/rig-c/pose/commit/470cdcc533240b97e1ed83e9517188e5190cab4b)), closes [#107](https://github.com/rig-c/pose/issues/107)

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
