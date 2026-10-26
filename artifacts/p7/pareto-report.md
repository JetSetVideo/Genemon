# Pareto report [P7-D1]

Command: `deno task pareto` - 4000 wild Genemon (seeds 1000000..), calibration keys: 143.

| | BEFORE (remap bypassed) | AFTER (shipped) |
|---|---|---|
| pareto parameters | 0 | 79 |
| off parameters | 85 | 4 |
| gated-pareto parameters | 0 | 13 |
| gated-off parameters | 16 | 5 |
| discrete parameters | 21 | 21 |
| constant parameters | 0 | 0 |
| continuous params in the 0.70-0.90 band | 0/101 | 92/101 |
| continuous params passing overall OR inside every design class | - | 101/101 (still failing: none) |
| median share20 of continuous params | 0.415 | 0.804 |
| distinct silhouettes WITHOUT pass-7 features (the pass-6 game) | 1307 | 1307 |
| distinct silhouettes WITH pass-7 features (uniform vs Pareto genes) | 3330 | 2756 |
| signature traits per creature (mean) | 0.00 | 2.43 |
| creatures with no signature trait | 100.0 % | 10.0 % |
| helixOf cost | 0.317 ms | 0.143 ms |

## Heredity (1200 families of wild parents, mid-parent vs child)

- 123 parameters; median Pearson r = 0.401; 96 % of parameters with r > 0.2.
- A child lands in the SAME extreme decile as an extreme mid-parent 57.7 % of the time (either extreme decile when the mid-parent is not extreme: 23.8 %).

## Generations (random mating, 240 per generation)

| gen | mean share20 | share of continuous params in the 0.70-0.90 band | distinct looks |
|---|---|---|---|
| 0 | 0.765 | 0.89 | 215 |
| 1 | 0.772 | 0.879 | 213 |
| 2 | 0.771 | 0.878 | 216 |
| 3 | 0.764 | 0.878 | 211 |
| 4 | 0.765 | 0.878 | 215 |
| 5 | 0.769 | 0.889 | 214 |
| 6 | 0.774 | 0.9 | 212 |

## Every numeric parameter (AFTER; BEFORE share20 in brackets; gated: share20 among creatures with the feature)

| parameter | class | min | max | median | mean | share20 | p10 | p90 |
|---|---|---|---|---|---|---|---|---|
| angularity | pareto | 0.006 | 0.981 | 0.500 | 0.457 | 0.844 (0.390) | 0.201 | 0.523 |
| anim.breath.hi | pareto | 0.019 | 0.120 | 0.057 | 0.057 | 0.789 (0.426) | 0.054 | 0.060 |
| anim.breath.lo | gated-pareto | 0.010 | 0.120 | 0.020 | 0.022 | 0.745 (0.439) | 0.020 | 0.025 |
| anim.breath.value | pareto | 0.014 | 0.120 | 0.039 | 0.040 | 0.771 (0.434) | 0.037 | 0.042 |
| anim.gait.hi | pareto | 0.209 | 0.999 | 0.510 | 0.515 | 0.813 (0.425) | 0.494 | 0.535 |
| anim.gait.lo | pareto | 0.152 | 0.999 | 0.228 | 0.245 | 0.870 (0.443) | 0.224 | 0.266 |
| anim.gait.value | pareto | 0.209 | 0.999 | 0.370 | 0.380 | 0.785 (0.436) | 0.358 | 0.403 |
| anim.headBob.hi | pareto | 0.039 | 0.400 | 0.181 | 0.182 | 0.816 (0.431) | 0.173 | 0.190 |
| anim.headBob.lo | pareto | 0.021 | 0.393 | 0.055 | 0.061 | 0.865 (0.447) | 0.053 | 0.071 |
| anim.headBob.value | pareto | 0.039 | 0.393 | 0.119 | 0.122 | 0.761 (0.432) | 0.113 | 0.132 |
| anim.recoil.hi | pareto | 0.089 | 0.790 | 0.367 | 0.370 | 0.807 (0.423) | 0.352 | 0.387 |
| anim.recoil.lo | pareto | 0.055 | 0.790 | 0.118 | 0.132 | 0.866 (0.441) | 0.115 | 0.152 |
| anim.recoil.value | pareto | 0.089 | 0.790 | 0.244 | 0.251 | 0.777 (0.432) | 0.232 | 0.271 |
| anim.squash.hi | pareto | 0.025 | 0.348 | 0.147 | 0.149 | 0.816 (0.481) | 0.140 | 0.157 |
| anim.squash.lo | pareto | 0.001 | 0.348 | 0.032 | 0.039 | 0.871 (0.455) | 0.030 | 0.047 |
| anim.squash.value | pareto | 0.024 | 0.348 | 0.090 | 0.094 | 0.788 (0.471) | 0.085 | 0.103 |
| anim.strike.hi | pareto | 0.269 | 1.600 | 0.794 | 0.799 | 0.814 (0.431) | 0.765 | 0.830 |
| anim.strike.lo | pareto | 0.206 | 1.553 | 0.328 | 0.354 | 0.861 (0.438) | 0.322 | 0.382 |
| anim.strike.value | pareto | 0.269 | 1.553 | 0.562 | 0.577 | 0.777 (0.436) | 0.542 | 0.612 |
| anim.tail.hi | pareto | 0.108 | 0.885 | 0.331 | 0.338 | 0.809 (0.439) | 0.316 | 0.355 |
| anim.tail.lo | pareto | 0.108 | 0.820 | 0.125 | 0.139 | 0.846 (0.436) | 0.121 | 0.156 |
| anim.tail.value | pareto | 0.108 | 0.820 | 0.229 | 0.238 | 0.786 (0.447) | 0.219 | 0.259 |
| anim.windup.hi | pareto | 0.170 | 1.200 | 0.567 | 0.571 | 0.804 (0.426) | 0.544 | 0.595 |
| anim.windup.lo | pareto | 0.101 | 1.200 | 0.202 | 0.221 | 0.860 (0.443) | 0.197 | 0.248 |
| anim.windup.value | pareto | 0.165 | 1.200 | 0.385 | 0.396 | 0.775 (0.433) | 0.370 | 0.423 |
| anim.wingFlap.hi | off | 0.323 | 1.581 | 0.848 | 0.758 | 0.401 (0.346) | 0.425 | 1.166 |
| anim.wingFlap.lo | off | 0.302 | 1.581 | 0.419 | 0.449 | 0.621 (0.594) | 0.326 | 0.722 |
| anim.wingFlap.value | off | 0.323 | 1.581 | 0.633 | 0.604 | 0.412 (0.398) | 0.376 | 0.944 |
| asymmetry | gated-pareto | 0.000 | 0.382 | 0.000 | 0.010 | 0.849 (0.418) | 0.000 | 0.000 |
| clawLength | gated-pareto | 0.000 | 0.992 | 0.496 | 0.336 | 0.793 (0.420) | 0.000 | 0.515 |
| digits | discrete | 0.000 | 7.000 | 4.000 | 2.612 | 0.528 (0.528) | 0.000 | 4.000 |
| eyes.count | discrete | 1.000 | 8.000 | 2.000 | 2.192 | 0.881 (0.881) | 1.000 | 3.000 |
| eyes.glow | pareto | 0.000 | 1.000 | 0.425 | 0.429 | 0.806 (0.387) | 0.405 | 0.452 |
| eyes.lidAngle | pareto | -0.449 | 0.439 | -0.083 | -0.066 | 0.813 (0.387) | -0.123 | 0.046 |
| eyes.size | pareto | 0.120 | 0.447 | 0.282 | 0.274 | 0.811 (0.424) | 0.226 | 0.288 |
| fractalDepth | discrete | 0.000 | 3.000 | 2.000 | 1.647 | 0.443 (0.443) | 1.000 | 2.000 |
| fusion | pareto | 0.012 | 0.971 | 0.470 | 0.472 | 0.796 (0.395) | 0.449 | 0.497 |
| mouth.teethCount | discrete | 0.000 | 12.000 | 4.000 | 4.264 | 0.368 (0.368) | 0.000 | 9.000 |
| mouth.tongue | discrete | 0.000 | 1.000 | 0.000 | 0.226 | 0.884 (0.727) | 0.000 | 1.000 |
| mouth.toothLength | gated-off | 0.000 | 0.600 | 0.186 | 0.195 | 0.502 (0.385) | 0.000 | 0.353 |
| mouth.width | pareto | 0.306 | 0.994 | 0.649 | 0.649 | 0.812 (0.425) | 0.631 | 0.667 |
| p5.body.armFractal.branch | discrete | 2.000 | 4.000 | 2.000 | 2.526 | 0.518 (0.515) | 2.000 | 3.000 |
| p5.body.armFractal.depth | discrete | 0.000 | 4.000 | 1.000 | 1.194 | 0.377 (0.376) | 0.000 | 3.000 |
| p5.body.armFractal.ratio | pareto | 0.459 | 0.749 | 0.605 | 0.604 | 0.808 (0.416) | 0.598 | 0.611 |
| p5.body.armFractal.twist | gated-off | 0.000 | 1.301 | 0.179 | 0.177 | 0.959 (0.665) | 0.000 | 0.604 |
| p5.body.curvature | off | -1.000 | 0.990 | 0.179 | 0.153 | 0.563 (0.497) | -0.346 | 0.578 |
| p5.body.limbVariation | gated-pareto | 0.000 | 0.233 | 0.000 | 0.003 | 0.795 (0.396) | 0.000 | 0.000 |
| p5.body.ops.count | discrete | 0.000 | 4.000 | 0.000 | 0.826 | 0.619 (0.619) | 0.000 | 2.000 |
| p5.body.serpentLegs | discrete | 0.000 | 2.000 | 0.000 | 0.020 | 1.000 (1.000) | 0.000 | 0.000 |
| p5.body.shoulder.height | pareto | 0.870 | 1.190 | 1.036 | 1.036 | 0.797 (0.415) | 1.027 | 1.044 |
| p5.body.shoulder.hump | gated-pareto | 0.000 | 0.780 | 0.000 | 0.016 | 0.784 (0.404) | 0.000 | 0.000 |
| p5.body.shoulder.width | pareto | 0.804 | 1.345 | 1.062 | 1.061 | 0.794 (0.427) | 1.050 | 1.074 |
| p5.body.tail.curl | pareto | 0.005 | 0.985 | 0.511 | 0.512 | 0.804 (0.404) | 0.487 | 0.536 |
| p5.body.tail.length | pareto | 0.411 | 1.788 | 1.078 | 1.077 | 0.793 (0.419) | 1.040 | 1.113 |
| p5.body.tail.tipSize | pareto | 0.507 | 1.987 | 1.184 | 1.187 | 0.805 (0.375) | 1.151 | 1.224 |
| p5.eyes.brow | pareto | 0.031 | 0.973 | 0.504 | 0.504 | 0.791 (0.408) | 0.480 | 0.529 |
| p5.eyes.count | discrete | 1.000 | 8.000 | 2.000 | 2.192 | 0.881 (0.881) | 1.000 | 3.000 |
| p5.eyes.height | pareto | -0.479 | 0.879 | 0.167 | 0.168 | 0.803 (0.410) | 0.137 | 0.202 |
| p5.eyes.scale[0] | pareto | 0.804 | 1.294 | 1.062 | 1.061 | 0.808 (0.413) | 1.049 | 1.073 |
| p5.eyes.scale[1] | pareto | 0.752 | 1.248 | 0.992 | 0.992 | 0.800 (0.413) | 0.979 | 1.005 |
| p5.eyes.scale[2] | pareto | 0.756 | 1.345 | 1.095 | 1.093 | 0.811 (0.411) | 1.078 | 1.109 |
| p5.eyes.socketDepth | pareto | 0.018 | 0.992 | 0.526 | 0.526 | 0.800 (0.410) | 0.503 | 0.549 |
| p5.eyes.spread | pareto | 0.004 | 0.953 | 0.508 | 0.507 | 0.790 (0.402) | 0.484 | 0.531 |
| p5.eyes.tilt | pareto | -0.494 | 0.489 | -0.038 | -0.036 | 0.802 (0.410) | -0.058 | -0.012 |
| p5.eyes.yaw | pareto | 0.075 | 1.292 | 0.682 | 0.683 | 0.797 (0.393) | 0.651 | 0.711 |
| p5.growth.angle.hi | pareto | 0.007 | 0.473 | 0.187 | 0.189 | 0.800 (0.430) | 0.177 | 0.201 |
| p5.growth.angle.lo | pareto | -0.452 | -0.013 | -0.135 | -0.139 | 0.807 (0.455) | -0.151 | -0.128 |
| p5.growth.length.hi | pareto | 0.753 | 1.338 | 1.234 | 1.225 | 0.839 (0.424) | 1.209 | 1.240 |
| p5.growth.length.lo | pareto | 0.712 | 1.338 | 0.814 | 0.824 | 0.841 (0.426) | 0.809 | 0.842 |
| p5.growth.neoteny | pareto | 0.013 | 1.000 | 0.482 | 0.481 | 0.806 (0.405) | 0.457 | 0.506 |
| p5.growth.spiral | pareto | 0.620 | 1.600 | 1.010 | 1.015 | 0.808 (0.398) | 0.990 | 1.037 |
| p5.growth.strength.hi | pareto | 0.762 | 1.339 | 1.244 | 1.234 | 0.851 (0.425) | 1.219 | 1.249 |
| p5.growth.strength.lo | pareto | 0.707 | 1.334 | 0.855 | 0.863 | 0.822 (0.416) | 0.848 | 0.881 |
| p5.mouth.beakLength | gated-off | 0.000 | 0.900 | 0.000 | 0.048 | 0.666 (0.520) | 0.000 | 0.299 |
| p5.mouth.beakRound | gated-off | 0.000 | 0.891 | 0.500 | 0.512 | 0.641 (0.530) | 0.500 | 0.500 |
| p5.mouth.height | pareto | -0.600 | 0.596 | -0.026 | -0.025 | 0.805 (0.421) | -0.051 | 0.002 |
| p5.mouth.lipCurve | pareto | -1.000 | 0.989 | -0.154 | -0.146 | 0.800 (0.401) | -0.194 | -0.106 |
| p5.mouth.scale[0] | pareto | 0.755 | 1.345 | 1.065 | 1.063 | 0.804 (0.423) | 1.049 | 1.079 |
| p5.mouth.scale[1] | pareto | 0.707 | 1.397 | 1.051 | 1.051 | 0.796 (0.403) | 1.033 | 1.068 |
| p5.mouth.scale[2] | pareto | 0.751 | 1.273 | 1.025 | 1.025 | 0.803 (0.396) | 1.013 | 1.038 |
| p5.mouth.tongueFork | discrete | 0.000 | 1.000 | 0.000 | 0.170 | 1.000 (1.000) | 0.000 | 1.000 |
| p5.mouth.tongueLength | gated-pareto | 0.000 | 1.186 | 0.000 | 0.182 | 0.815 (0.379) | 0.000 | 0.808 |
| p5.skin.bellyContrast | pareto | 0.312 | 0.936 | 0.652 | 0.652 | 0.801 (0.407) | 0.637 | 0.669 |
| p5.skin.celBands | discrete | 2.000 | 5.000 | 3.000 | 3.493 | 0.429 (0.429) | 3.000 | 4.000 |
| p5.skin.frills | gated-pareto | 0.000 | 0.853 | 0.000 | 0.063 | 0.808 (0.428) | 0.000 | 0.215 |
| p5.skin.outline | pareto | 0.109 | 0.792 | 0.534 | 0.530 | 0.807 (0.420) | 0.514 | 0.547 |
| p5.skin.overlays | discrete | 0.000 | 3.000 | 2.000 | 1.673 | 0.473 (0.438) | 1.000 | 3.000 |
| p5.skin.stripes | gated-off | 0.000 | 0.938 | 0.000 | 0.182 | 0.335 (0.412) | 0.000 | 0.810 |
| p7.fx.hueShift | pareto | -0.080 | 0.079 | 0.000 | -0.000 | 0.820 (0.425) | -0.004 | 0.004 |
| p7.fx.intensity | pareto | 0.619 | 1.580 | 1.041 | 1.043 | 0.796 (0.385) | 1.019 | 1.066 |
| p7.fx.pulse | pareto | 0.000 | 0.975 | 0.011 | 0.048 | 0.837 (0.399) | 0.001 | 0.121 |
| p7.fx.sparkle | pareto | 0.000 | 0.993 | 0.011 | 0.046 | 0.827 (0.381) | 0.001 | 0.109 |
| p7.fx.trail | pareto | 0.000 | 0.975 | 0.011 | 0.047 | 0.825 (0.399) | 0.001 | 0.117 |
| p7.horns.branch | discrete | 0.000 | 3.000 | 0.000 | 0.068 | 1.000 (0.381) | 0.000 | 0.000 |
| p7.horns.curl | gated-pareto | 0.000 | 1.474 | 0.011 | 0.061 | 0.825 (0.369) | 0.000 | 0.149 |
| p7.horns.pairs | discrete | 0.000 | 3.000 | 1.000 | 0.854 | 0.933 (0.654) | 0.000 | 1.000 |
| p7.motion.anticipation | pareto | 0.024 | 0.996 | 0.499 | 0.498 | 0.803 (0.413) | 0.474 | 0.521 |
| p7.motion.bounce | pareto | 0.011 | 0.990 | 0.406 | 0.411 | 0.801 (0.392) | 0.386 | 0.436 |
| p7.motion.followThrough | pareto | 0.012 | 0.988 | 0.459 | 0.463 | 0.813 (0.412) | 0.437 | 0.489 |
| p7.motion.jitter | pareto | 0.000 | 0.988 | 0.468 | 0.469 | 0.786 (0.400) | 0.446 | 0.492 |
| p7.motion.stiffness | pareto | 0.600 | 1.586 | 1.109 | 1.109 | 0.807 (0.407) | 1.083 | 1.133 |
| p7.motion.sway | pareto | 0.000 | 0.969 | 0.452 | 0.454 | 0.797 (0.408) | 0.431 | 0.479 |
| p7.ops.count | discrete | 0.000 | 6.000 | 0.000 | 0.214 | 1.000 (0.398) | 0.000 | 1.000 |
| p7.relief.facets | pareto | 0.000 | 0.973 | 0.011 | 0.045 | 0.819 (0.399) | 0.001 | 0.106 |
| p7.relief.flutes | discrete | 0.000 | 8.000 | 0.000 | 0.305 | 1.000 (0.424) | 0.000 | 1.000 |
| p7.relief.knobs | pareto | 0.000 | 0.989 | 0.011 | 0.045 | 0.824 (0.407) | 0.001 | 0.106 |
| p7.relief.ridges | discrete | 0.000 | 5.000 | 0.000 | 0.189 | 1.000 (0.453) | 0.000 | 1.000 |
| p7.relief.scallop | pareto | 0.000 | 1.000 | 0.010 | 0.046 | 0.838 (0.408) | 0.001 | 0.111 |
| p7.relief.segmentDepth | pareto | 0.008 | 0.979 | 0.456 | 0.459 | 0.803 (0.403) | 0.435 | 0.483 |
| p7.relief.segments | discrete | 0.000 | 12.000 | 0.000 | 0.462 | 0.976 (0.406) | 0.000 | 1.000 |
| p7.spikes.density | gated-pareto | 0.504 | 2.000 | 1.000 | 1.099 | 0.804 (0.402) | 1.000 | 1.276 |
| p7.spikes.length | gated-pareto | 0.587 | 1.939 | 1.000 | 1.117 | 0.798 (0.404) | 1.000 | 1.334 |
| p7.spikes.rows | discrete | 0.000 | 3.000 | 0.000 | 0.383 | 0.565 (0.615) | 0.000 | 1.000 |
| surface.bump | pareto | 0.006 | 0.983 | 0.508 | 0.507 | 0.793 (0.401) | 0.482 | 0.533 |
| surface.fur | pareto | 0.000 | 0.996 | 0.486 | 0.397 | 0.865 (0.378) | 0.000 | 0.507 |
| surface.patternContrast | pareto | 0.026 | 0.982 | 0.503 | 0.453 | 0.867 (0.380) | 0.152 | 0.524 |
| surface.patternScale | pareto | 0.500 | 1.991 | 1.246 | 1.248 | 0.803 (0.402) | 1.209 | 1.283 |
| surface.plates | gated-pareto | 0.000 | 0.992 | 0.529 | 0.415 | 0.787 (0.424) | 0.000 | 0.546 |
| surface.sheen | pareto | 0.016 | 0.985 | 0.502 | 0.503 | 0.801 (0.405) | 0.478 | 0.528 |
| wings.detail | gated-pareto | 0.000 | 0.993 | 0.552 | 0.362 | 0.818 (0.426) | 0.000 | 0.569 |
| wings.fingers | discrete | 0.000 | 5.000 | 3.000 | 2.253 | 0.350 (0.350) | 0.000 | 4.000 |
| wings.span | gated-pareto | 0.000 | 3.200 | 1.549 | 1.199 | 0.722 (0.639) | 0.000 | 2.627 |

## Discrete parameters (integer counts): share of creatures on the most common 20 % of values

| parameter | values | top-20 % share | median | mean | min | max |
|---|---|---|---|---|---|---|
| digits | 5 | 0.467 | 4.000 | 2.612 | 0.000 | 7.000 |
| eyes.count | 8 | 0.867 | 2.000 | 2.192 | 1.000 | 8.000 |
| fractalDepth | 4 | 0.508 | 2.000 | 1.647 | 0.000 | 3.000 |
| mouth.teethCount | 13 | 0.492 | 4.000 | 4.264 | 0.000 | 12.000 |
| mouth.tongue | 2 | 0.774 | 0.000 | 0.226 | 0.000 | 1.000 |
| p5.body.armFractal.branch | 3 | 0.547 | 2.000 | 2.526 | 2.000 | 4.000 |
| p5.body.armFractal.depth | 5 | 0.478 | 1.000 | 1.194 | 0.000 | 4.000 |
| p5.body.ops.count | 5 | 0.513 | 0.000 | 0.826 | 0.000 | 4.000 |
| p5.body.serpentLegs | 3 | 0.986 | 0.000 | 0.020 | 0.000 | 2.000 |
| p5.eyes.count | 8 | 0.867 | 2.000 | 2.192 | 1.000 | 8.000 |
| p5.mouth.tongueFork | 2 | 0.830 | 0.000 | 0.170 | 0.000 | 1.000 |
| p5.skin.celBands | 4 | 0.435 | 3.000 | 3.493 | 2.000 | 5.000 |
| p5.skin.overlays | 4 | 0.502 | 2.000 | 1.673 | 0.000 | 3.000 |
| p7.horns.branch | 4 | 0.944 | 0.000 | 0.068 | 0.000 | 3.000 |
| p7.horns.pairs | 4 | 0.785 | 1.000 | 0.854 | 0.000 | 3.000 |
| p7.ops.count | 7 | 0.872 | 0.000 | 0.214 | 0.000 | 6.000 |
| p7.relief.flutes | 9 | 0.940 | 0.000 | 0.305 | 0.000 | 8.000 |
| p7.relief.ridges | 6 | 0.887 | 0.000 | 0.189 | 0.000 | 5.000 |
| p7.relief.segments | 13 | 0.947 | 0.000 | 0.462 | 0.000 | 12.000 |
| p7.spikes.rows | 4 | 0.633 | 0.000 | 0.383 | 0.000 | 3.000 |
| wings.fingers | 6 | 0.362 | 3.000 | 2.253 | 0.000 | 5.000 |

## Mixture parameters judged inside each design class (AFTER; classes with >= 100 creatures)

| parameter / class | n | share20 | share20 without the modal value | modal share |
|---|---|---|---|---|
| anim.wingFlap.hi | wingClass=avian | 567 | 0.817 | 0.802 | 0.10 |
| anim.wingFlap.hi | wingClass=fly | 195 | 0.815 | 0.809 | 0.06 |
| anim.wingFlap.hi | wingClass=glide | 1839 | 0.817 | 0.802 | 0.07 |
| anim.wingFlap.hi | wingClass=none | 1399 | 0.810 | 0.789 | 0.20 |
| anim.wingFlap.lo | wingClass=avian | 567 | 0.830 | 0.786 | 0.22 |
| anim.wingFlap.lo | wingClass=fly | 195 | 0.896 | 0.878 | 0.15 |
| anim.wingFlap.lo | wingClass=glide | 1839 | 0.865 | 0.838 | 0.14 |
| anim.wingFlap.lo | wingClass=none | 1399 | 0.867 | 0.809 | 0.39 |
| anim.wingFlap.value | wingClass=avian | 567 | 0.743 | 0.717 | 0.10 |
| anim.wingFlap.value | wingClass=fly | 195 | 0.812 | 0.803 | 0.08 |
| anim.wingFlap.value | wingClass=glide | 1839 | 0.784 | 0.772 | 0.06 |
| anim.wingFlap.value | wingClass=none | 1399 | 0.787 | 0.743 | 0.18 |
| mouth.teethCount | mouth.teeth=beak | 471 | 0.000 | - | 1.00 |
| mouth.teethCount | mouth.teeth=fangs | 1451 | 0.444 | 0.406 | 0.29 |
| mouth.teethCount | mouth.teeth=molars | 419 | 0.519 | 0.465 | 0.45 |
| mouth.teethCount | mouth.teeth=needles | 537 | 0.408 | 0.415 | 0.28 |
| mouth.teethCount | mouth.teeth=none | 644 | 0.000 | - | 1.00 |
| mouth.teethCount | mouth.teeth=saw | 239 | 0.460 | 0.375 | 0.34 |
| mouth.teethCount | mouth.teeth=tusks | 239 | 0.457 | 0.000 | 0.56 |
| mouth.toothLength | mouth.teeth=beak | 471 | 0.000 | - | 1.00 |
| mouth.toothLength | mouth.teeth=fangs | 1451 | 0.818 | 0.766 | 0.24 |
| mouth.toothLength | mouth.teeth=molars | 419 | 0.863 | 0.686 | 0.62 |
| mouth.toothLength | mouth.teeth=needles | 537 | 0.805 | 0.784 | 0.28 |
| mouth.toothLength | mouth.teeth=none | 644 | 0.000 | - | 1.00 |
| mouth.toothLength | mouth.teeth=saw | 239 | 0.783 | 0.678 | 0.38 |
| mouth.toothLength | mouth.teeth=tusks | 239 | 0.798 | 0.748 | 0.26 |
| p5.body.armFractal.twist | p5.body.armFractal.mode=branch | 1570 | 0.797 | 0.755 | 0.20 |
| p5.body.armFractal.twist | p5.body.armFractal.mode=mandelbrot | 117 | 0.791 | 0.750 | 0.25 |
| p5.body.armFractal.twist | p5.body.armFractal.mode=none | 1911 | 0.000 | - | 1.00 |
| p5.body.armFractal.twist | p5.body.armFractal.mode=spiral | 402 | 0.834 | 0.820 | 0.09 |
| p5.body.curvature | element=air | 290 | 0.841 | 0.818 | 0.10 |
| p5.body.curvature | element=earth | 218 | 0.844 | 0.817 | 0.14 |
| p5.body.curvature | element=electric | 109 | 0.836 | 0.832 | 0.06 |
| p5.body.curvature | element=fire | 123 | 0.853 | 0.842 | 0.06 |
| p5.body.curvature | element=light | 1071 | 0.788 | 0.778 | 0.04 |
| p5.body.curvature | element=neutral | 122 | 0.798 | 0.788 | 0.07 |
| p5.body.curvature | element=plant | 150 | 0.810 | 0.798 | 0.06 |
| p5.body.curvature | element=poison | 219 | 0.808 | 0.795 | 0.05 |
| p5.body.curvature | element=psychic | 350 | 0.820 | 0.800 | 0.09 |
| p5.body.curvature | element=shadow | 421 | 0.813 | 0.803 | 0.06 |
| p5.body.curvature | element=void | 514 | 0.815 | 0.806 | 0.05 |
| p5.body.curvature | element=water | 277 | 0.870 | 0.830 | 0.20 |
| p5.mouth.beakLength | p5.mouth.beak=none | 3526 | 0.000 | - | 1.00 |
| p5.mouth.beakLength | p5.mouth.beak=round | 256 | 0.818 | 0.790 | 0.21 |
| p5.mouth.beakRound | p5.mouth.beak=none | 3526 | 0.000 | - | 1.00 |
| p5.mouth.beakRound | p5.mouth.beak=round | 256 | 0.754 | 0.702 | 0.20 |
| p5.skin.stripes | stripeClass=gate | 575 | 0.845 | 0.797 | 0.21 |
| p5.skin.stripes | stripeClass=none | 2858 | 0.000 | - | 1.00 |
| p5.skin.stripes | stripeClass=pattern | 567 | 0.835 | 0.810 | 0.16 |
| wings.span | wingClass=avian | 567 | 0.804 | 0.791 | 0.09 |
| wings.span | wingClass=fly | 195 | 0.797 | 0.774 | 0.12 |
| wings.span | wingClass=glide | 1839 | 0.774 | 0.750 | 0.12 |
| wings.span | wingClass=none | 1399 | 0.000 | - | 1.00 |

## Categorical parameters (AFTER): share of creatures in the top 20 % of values

| parameter | values | top-20 % share |
|---|---|---|
| eyes.aura | 6 | 0.704 |
| eyes.pupil | 5 | 0.414 |
| eyes.style | 8 | 0.433 |
| mouth.teeth | 7 | 0.363 |
| p5.body.armFractal.mode | 4 | 0.478 |
| p5.body.limbStyle | 4 | 0.821 |
| p5.body.ops.kind | 8 | 0.300 |
| p5.body.tail.shape | 10 | 0.473 |
| p5.eyes.layout | 6 | 0.749 |
| p5.eyes.shape | 7 | 0.439 |
| p5.mouth.beak | 6 | 0.881 |
| p5.skin.coat | 9 | 0.464 |
| p7.ops.kind | 15 | 0.315 |
| wings.kind | 5 | 0.350 |
