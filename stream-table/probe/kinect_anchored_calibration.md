# Kinect-anchored multi-camera calibration (final, 2026-04-17)

## Decision

We adopted the **Kinect camera frame** as the reference world frame for multi-camera
calibration. Rationale:

- The Kinect is permanently mounted overhead and doesn't move across the experiment, so
  it's a stable anchor.
- The Kinect's color frame sees only sediment bed, without visible rim/structural
  reference points for aligning to the flume's nominal world frame.
- Cross-camera triangulation in Kinect frame gives consistent 3D points (the thing
  multi-camera rigs exist to enable).

## Method (Path 3)

Implemented in [scripts/kinect_anchor_pnp.py](../scripts/kinect_anchor_pnp.py).

1. **User clicks the same physical feature** in the Kinect color frame and in each phone
   frame (done via [calib/cross_project.html](../calib/cross_project.html) triangulation
   mode).
2. **Convert Kinect click → 3D in Kinect camera frame** by unprojecting with Kinect color
   intrinsics and assuming the clicked feature lies on the bed at depth = 772 mm (the
   Kinect-to-bed standoff measured in the earlier depth sanity check).
3. **Per-phone PnP** (OpenCV `solvePnP`, EPNP or iterative depending on # points) using
   those 3D points + the phone's pixel clicks → phone pose in Kinect camera frame.
4. Results saved to `calib/pose_<label>_kinect_anchored.json`.

## Input data

- 6 features clicked at clack+60s in the flow-frame set
- Clicks per phone: anna 5, valentine 5, sophia 5, kinect 5, javier 0 (excluded)
- Source: [calib/cross_features_merged.json](../calib/cross_features_merged.json)

## Results

| Phone | N pts | fx (px) | Mean reproj (px) | Max reproj (px) | Camera centre in Kinect frame (mm) |
|---|---|---|---|---|---|
| anna | 5 | 480 | **36.2** | 86.7 | (+61, −166, +488) |
| valentine | 5 | 780 | **22.2** | 39.7 | (+390, −13, +188) |
| sophia | 5 | 763 | **14.2** | 19.8 | (+637, −35, +340) |
| javier | 0 | — | — | — | not calibrated this round |

For comparison, the best manual-tune residuals were 100-265 px, and the failed BA runs
were 200-350 px. **Kinect-anchored PnP is ~5-10× better** and produces physically-plausible
camera positions.

## Coordinate frame convention

**Kinect color camera frame**, approximated:
- Origin at the Kinect's color-camera optical centre.
- +Z axis along the Kinect's optical axis (pointing toward the bed).
- +X along the Kinect's image-right direction at capture (before our 90° CW display rotation).
- +Y along the Kinect's image-down direction at capture.
- Bed is at Z ≈ +772 mm; phones sit at Z ≈ +190 to +490 mm (above the bed, below the Kinect).

## What you CAN do with these poses

- **Cross-camera feature triangulation** — click a feature in 2+ phones, get its 3D
  position in Kinect frame. Triangulated points from different phone combinations will
  agree (unlike with the old manual-tune poses).
- **3D sediment feature tracking** across the video — detect rivulets / flow lobes /
  scour holes in multiple phone views at matched timestamps, triangulate each to a 3D
  trajectory in Kinect frame.
- **Overlay physical fixtures** where their Kinect-frame 3D is known (e.g. the cross-bar
  ends, if you measure their depth from the Kinect).

## What you CAN'T yet do

- **Use the schema wireframe overlay** on phone videos — the schema is defined in the
  flume frame (rim_NW at (0,0,0) etc.) not Kinect frame. Legacy
  [scripts/make_overlay_video.py](../scripts/make_overlay_video.py) would project the
  schema incorrectly.
- **Metric coordinates tied to the physical flume** — without a known Kinect↔flume
  transform. See "Future refinement" below.

## Assumption caveats

- **Assumed bed depth = 772 mm for all clicked features.** Correct for features on the
  sediment surface (rivulets, flow patterns). Wrong for features on the rim, clamps, or
  the cross-bar. If residuals are higher for specific features, that's likely why.
- **Kinect color intrinsics are approximate** (fx ≈ 910, cx ≈ 960, cy ≈ 540 for the
  1920×1080 color stream). Values scaled from the factory 4096×3072 calibration, not
  derived from the actual K4A calibration blob. Refining would tighten residuals further.

## Future refinement (optional)

Two ways to reduce residuals and get a flume-frame transform:

1. **Extract actual Kinect depth values** at each clicked feature's pixel (instead of
   assuming 772 mm). Requires pyav or pyk4a to read the DEPTH stream from
   [videos/depth_20260311_105209.mkv](../videos/depth_20260311_105209.mkv) and map
   color-pixel → depth-pixel → depth value. Will reduce residuals for off-bed features.

2. **Kinect→flume transform** via clicking a few known-position landmarks on the Kinect
   frame. E.g., if a setup-time Kinect frame exists that shows the empty flume (before
   sediment), rim corners or bed edges would be visible and directly clickable. Check
   the first ~1-2 seconds of the Kinect recording for such a frame.

## Files

- [scripts/kinect_anchor_pnp.py](../scripts/kinect_anchor_pnp.py) — the solver
- [calib/pose_anna_kinect_anchored.json](../calib/pose_anna_kinect_anchored.json)
- [calib/pose_valentine_kinect_anchored.json](../calib/pose_valentine_kinect_anchored.json)
- [calib/pose_sophia_kinect_anchored.json](../calib/pose_sophia_kinect_anchored.json)
- [calib/cross_features_merged.json](../calib/cross_features_merged.json) — source clicks
