# Stage 3 — Per-phone DOF accounting (session 1)

For each phone, count available constraints against unknowns. If constraints < unknowns, the pose cannot be recovered from that frame alone by landmark methods.

## Unknowns per phone (7 total)

With the usual simplifications — `fx = fy`, `(cx, cy)` fixed at image center, distortion `k1 = k2 = 0` for the initial solve:

| Parameter | DOF |
|-----------|-----|
| `fx` | 1 |
| `R` (rotation) | 3 |
| `t` (translation) | 3 |
| **Total** | **7** |

## Constraint accounting rules

| Evidence | Equations contributed | Notes |
|----------|-----------------------|-------|
| Vanishing point of a known 3D direction | 2 (rotation column for that direction) | Requires ≥2 parallel image lines in that direction |
| Pair of orthogonal VPs | +1 on `fx` | Image-of-absolute-conic orthogonality constraint |
| 3D↔2D point correspondence | 2 | Needs measurable 3D coordinate |
| 3D↔2D line correspondence | 2 | Needs known 3D line parameters |

## What each reference frame actually shows

Frames reviewed: [calib/reference_frames/{anna,sophia,valentine,kinect_color}.jpg](../calib/reference_frames/). Javier has no reference frame — gap.

### anna
Pure sediment, edge to edge. No rim, no rails, no structural feature in the frame. Consistent with the session-2 inventory's finding that "no rim visible anywhere in frame" at t=2, 15, 60 s. Anna's framing in S1 is the sediment bed between the two walls, with rim above the top edge and below the bottom edge of the camera view.

### sophia
Dominant sediment fill. The very top ~5 % of frame contains a dark structural band — plausibly the far rim and/or one overhead rail — but at the resolution shown I cannot clearly resolve two parallel rail lines or a rim corner. Rim side-edges (left/right) are cropped out of frame. No rim corners visible as point features.

### valentine
Richest frame of the four. Top-left shows the near rim edge running horizontally across the top of frame with two bright rectangular fixtures (rim clamps/brackets) sitting on it. Right side shows a vertical structural line consistent with a rim side edge. No overhead rails in view.

### kinect (color)
Pure sediment bed. Overhead framing is tight to the flume interior; rim is out of frame on all sides. Kinect doesn't need image-landmark calibration — factory intrinsics exist in [calib/kinect_intrinsics.json](../calib/kinect_intrinsics.json) and extrinsics can be solved from depth-plane geometry.

### javier
Reference frame extracted at t = 30 s into [calib/reference_frames/javier.jpg](../calib/reference_frames/javier.jpg). This is the **richest view of the four**. Visible content:

- **Both long rims** of the flume run the full length of the frame, clearly resolvable, each with multiple IRWIN Quick-Grip clamps mounted along it → parallel-line pair converging at a flume-length VP
- **Two overhead rails** (aluminum extrusions) visible across the frame with mounting brackets → second parallel-line pair (rail VP)
- **Outlet-end structure**: PVC fittings, outlet port visible → near-end rim width edge
- **≥6 clamp heads** on the rims with known/measurable geometry along the rim → ≥6 candidate 3D point correspondences at known rim coordinates
- **Bright orange rim bumper** at near end → further localizable feature
- **Room structure** (wall edges, ceiling, monitors) behind the flume — independent orthogonal-direction VPs if needed as extra constraints

Three orthogonal directions resolvable: flume-length (rim pair), flume-width (rim width at outlet + clamp spacing across), rail axis (overhead). Plus many point features.

## Budget table

Entries are **eqs contributed** per constraint category. "VP" = vanishing point. Corners = rim corners with known 3D.

| Phone | VP length | VP width | VP rails | Rail lines | Rim edges | Rim corners | Σ eqs | Unknowns | Verdict |
|-------|-----------|----------|----------|------------|-----------|-------------|-------|----------|---------|
| **anna** | 0 | 0 | 0 | 0 | 0 | 0 | **0** | 7 | **Unsolvable from S1 landmarks.** No structural content anywhere in frame, per reference frame and inventory §2 sweep. |
| **sophia** | ≤2 | 0 | ≤2 | ≤2 | 0 | 0 | **≤6** (if both VPs resolvable) | 7 | **Underdetermined** as reference frame stands. Need to confirm that left/right rim edges and rail pair really are resolvable in the full-resolution video. |
| **valentine** | 2 | 2 | 0 | 0 | 4 (top + right rim edges, 2 eqs each) | 2 (top-left corner) | **≥10** (with VP ⊥ bonus → 11 on `fx`) | 7 | **Overdetermined, solvable.** Best candidate for the worked example. |
| **javier** | 2 | 2 | 2 | 4 (2 rails × 2 eqs) | 4 (2 rim-length edges × 2 eqs) | ≥12 (6+ clamps × 2 eqs) | **≥26** (+3 orthogonality bonuses → 29 on `fx`) | 7 | **Massively overdetermined.** Three orthogonal VPs + many point correspondences + rail+rim line constraints. Best candidate for worked example. |
| kinect | N/A | N/A | N/A | N/A | N/A | N/A | — | — | Calibrated via depth-plane + factory intrinsics, not landmarks. |

## Honest reads

1. **Anna is not rescuable** by a landmark solve off her S1 video. Two real options: (a) accept that anna S1 has no extrinsic solve and is useable only for sediment-texture work, or (b) transfer her pose from S2 where both rims are visible — but that requires accepting S2 tripod extrinsics ≠ S1 (tripod moved back), so it would be a *refined-by-BA-on-S1* solve using S2 as the initial guess, and S1 supplies essentially nothing to the BA. In practice, (a) and (b) converge to "anna S1 pose is whatever S2 tells us, with no S1 refinement possible."

2. **Sophia is marginal at best from the reference frame.** The inventory described rails as "visible across top" — the reference frame shows a dark band consistent with that claim, but not at a resolution where I can see two distinct rail lines. Before declaring her solvable, pull 2–3 additional frames at full native resolution and look explicitly for the two-rail parallel pair + left/right rim edges converging to a length-axis vanishing point. If those are visible, she jumps to overdetermined like valentine.

3. **Valentine is the clean case.** One rim corner + two orthogonal rim edges meeting at that corner is enough by itself: two VPs give rotation + `fx`, the corner gives translation. Reference frame confirms both edges plus at least one rim bracket. This is the phone to run as the worked example.

4. **Javier is now the strongest phone in the rig.** Frame extracted at t = 30 s shows full flume length with both rims + both overhead rails + clamps + outlet-end structure. Three orthogonal vanishing directions + multiple point correspondences. Constraint count dwarfs unknowns by ~4×. He should be the worked-example target over valentine.

## What to do next

1. **Solve javier as the worked example** (step 2 of the academic exercise). Click the two rim-length edges + the two overhead rails + the outlet-end rim edge + ≥4 clamp-head points in `annotate.html`, derive rotation and `fx` from three orthogonal VPs, PnP the translation, nonlinear-refine. Compare recovered `fx` against the EXIF prior once javier is added to [calib/intrinsics.json](../calib/intrinsics.json) (currently missing — gap to fix).
2. **Also solve valentine** — smaller constraint budget but still overdetermined, good cross-check. Two phones solved cleanly gives a way to sanity-check inter-phone consistency via the shared kinect + any co-observed rim points.
3. **Sample 2–3 more sophia frames** at different timestamps and inspect the top band at native 1080×1920 to decide whether her rails and length-axis VP are actually resolvable. If yes, promote her verdict. If no, she collapses into the anna category.
4. **Accept that anna S1 cannot be landmark-calibrated.** Document this in the calibration output as a known gap; her pose will come from S2 + BA-init, or nothing.

Revised landmark-method ceiling: **2 phones cleanly solvable (javier + valentine), 1 marginal (sophia, pending frame recheck), 1 unsolvable (anna).** Better than the earlier "at most 2" read now that javier's frame is in hand.
