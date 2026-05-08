# Session notes — pose pipeline buildout (2026-05-06)

This session built out the missing infrastructure around the
`pose_<cam>_flume.json` keystone, but did **not** produce any new keystone
files. The keystone itself is still gated on more landmark annotations
(see "What's still blocked" below).

## What changed

### New files

- **`calib/lib/flume_pose.js`** — pure-math module: DLT homography +
  Faugeras `[R|t]` decomposition + projection / camera-center / optical-axis
  helpers + a `solvePoseFromPlanarLandmarks({worldXY, imageUV, K})`
  high-level entry point. Extracted verbatim from `kinect_align.html` so
  the same arithmetic powers the browser tool, the synthetic test, and any
  future batch tooling.
- **`calib/lib/flume_pose.test.html`** — synthetic round-trip: project six
  coplanar world points through a known camera, recover the pose, verify
  the recovered camera center is within 1 mm of truth. Currently passes
  with `|ΔC| ≈ 1e-10 mm`, axis-angle 0°, reprojection RMS ~1e-11 px.
- **`calib/diagnostic.html`** — one row per (cam × pose-source) showing
  optical center (raw + lifted-into-flume), optical axis, reprojection RMS,
  and an in-bounds flag (rim ± 200 mm). The known-bad `_refined.json`
  km-scale outliers are highlighted red.

### Modified files

- **`calib/kinect_align.html`** — converted to `<script type="module">` and
  imports the math from `./lib/flume_pose.js`. Removed ~125 lines of
  inline duplication. Behavior is identical: cam selector populates with
  all 5 cams, annotations preload, click-to-place still works, commit
  still PUTs `pose_<cam>_flume.json`. Verified headlessly.
- **`calib/multiview.html`** — pose loader now prefers
  `pose_<cam>_flume.json` and falls back to
  `pose_<cam>_kinect_anchored.json` composed with the existing
  `M_scene_from_kinect_cv` mount transform. On fallback, a `console.warn`
  prints the cam's raw kinect-frame center and the scene center the mount
  produces, so the offset is visible at a glance. **`M_scene_from_kinect_cv`
  is preserved as fallback** — the comment block above it now flags it as
  "do not remove until every cam has a flume-frame pose." Added a
  `M_scene_from_flume` constant for the preferred path.

### Bugfix found while building Stage 5

`flume_pose.opticalAxis()` was returning the third *column* of R when it
should return the third *row* (the cam's +Z direction expressed in world
coordinates). The Stage-1 test passed only because both true and recovered
poses ran through the same buggy function and the bug cancelled out. The
test now compares the recovered axis against an independently constructed
direction (`normalize(target - C)`), which would catch this class of bug.

## What's still blocked

### Stage 2 — `_flume.json` keystone for any cam (BLOCKED)

Neither `javier` nor `valentine` has enough usable annotations:

- **javier** clicked `rim_NE` and `rim_SE` (both at world X=838, Z=0 — collinear).
  His other two clicks (`rail_pt_A/B`) are line-constraint pseudo-landmarks
  with no XYZ.
- **valentine** clicked `rib_W_upper` and `rib_E_upper` (both at world Y=343,
  Z=0 — collinear). Same line-constraint issue with the rail clicks. His
  notes file says rim corners at Y=0 are occluded by the inlet tube.

DLT requires four points in general position. Two collinear points contribute
two redundant equations and the homography is undetermined. I refused to
solve and commit anyway because the result would be silently wrong (exactly
the failure mode of the `_refined.json` files).

**To unblock:** open `annotate.html` and click a few more landmarks. Concrete suggestions:

- **javier**: click `rim_NW` (0, 0, 0) and `rim_SW` (0, 1930, 0) — gives 4
  rim corners, all coplanar and in general position.
- **valentine**: click `rim_SW` (0, 1930, 0) and `rim_SE` (838, 1930, 0).
  This gives a rectangle but a relatively narrow vertical baseline (Y=343
  vs Y=1930). Adding `standpipe_base` (419, 1900, 0) helps condition the X
  axis better.

After clicks land, the solver in `kinect_align.html` already runs from
existing annotations on cam-select, so the next session can be: load the
cam → click commit → done.

### Stage 3 — Kinect intrinsic CW/CCW rotation validation (DEFERRED)

The plan was to add a `validateRotation()` helper that reports residuals
under both the current proxy intrinsic and its CCW-flipped counterpart. This
needs `kinect_color` annotations to run against. That file is currently
empty (`{}`). When the user finishes those annotations:

```
TODO: add validateRotation(annotations, intrinsics, anchor3D) to flume_pose.js
TODO: run from kinect_align.html and print which orientation has lower residual
TODO: do NOT auto-commit a change to kinect_proxy_intrinsics_fitted.json — just report
```

I left no stub code for this. The math is straightforward: solve pose under
each candidate K, compute reprojection RMS, compare. ~30 LOC.

## Tradeoffs surfaced

### Headless verification + WebGL

Default headless Chrome can't create a WebGL context, which kills
`multiview.html` before its loader runs. Added
`--use-gl=angle --use-angle=swiftshader` to the verification command — the
software renderer is slow but lets the loader complete and the
`console.warn`s fire so we can verify the patch end-to-end. This isn't a
production concern; just noting because it'll come up in any future
headless verification of a Three.js page.

### "In bounds" threshold for the diagnostic

Your spec was rim ± 200 mm. With that exact threshold, sophia's fallback
flume center (1056, 1000, 430) shows as **NO** in bounds — sophia's
kinect-frame X=637 (way to the right of the Kinect at X=0) lifts to scene
X=1056 (past the east wall at 838). I kept your threshold rather than
loosening it, because that "NO" is a useful signal: the assumed Kinect mount
puts sophia's billboard outside the rim in the multiview scene, which is
likely the visible drift you've been seeing.

## What to look at next session

In order of expected payoff:

1. **Two clicks per blocked cam in `annotate.html`** — javier (rim_NW, rim_SW)
   and valentine (rim_SW, rim_SE, optionally standpipe_base). Then commit
   `pose_javier_flume.json` and `pose_valentine_flume.json` from
   `kinect_align.html`. The diagnostic will start showing two `_flume`
   "preferred" rows in green. The multiview will switch to the preferred
   path for those two cams (no more fallback warns for them).
2. **Open `diagnostic.html` in a real browser** — the headless dump confirms
   the data is correct, but the visual layout (sticky header, badge
   colors, red km-outlier cells) is easier to scan in a real browser at
   full width.
3. **Anna's kinect-anchored RMS is 36 px** vs valentine's 22 and sophia's 14
   — anna is the worst-conditioned. Her intrinsic is the most uncertain
   ("EXIF stripped"). When she has annotations, solving her `_flume` pose
   may need either pair_tune's fx refinement or a separately-derived
   focal length.
4. **Once `kinect_color` annotations exist**, do Stage 3 (CW/CCW intrinsic
   check) before committing a Kinect `_flume` pose. The factory intrinsic
   is for 4096×3072 landscape but the proxy is 1080×1920 portrait, and
   PROJECT.md §2 flags that the current scaling code may not be applying
   the rotation correctly.

## Files at a glance

```
calib/
├── lib/
│   ├── flume_pose.js          ← new — pure-math module
│   └── flume_pose.test.html   ← new — synthetic round-trip test
├── diagnostic.html            ← new — pose-source dashboard
├── kinect_align.html          ← modified — now imports the module
├── multiview.html             ← modified — prefers _flume.json, warns on fallback
├── SESSION_NOTES.md           ← this file
├── pose_<cam>_flume.json      ← still missing for every cam (the keystone)
└── (pose_<cam>_kinect_anchored.json, _refined.json, etc — unchanged)
```
