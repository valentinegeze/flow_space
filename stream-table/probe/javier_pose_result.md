# Stage 3 — Javier pose solve, final outcome

## TL;DR

The math of the VP+PnP pipeline closes end-to-end and reproduces **zero pixel error on every observation we have**: two rim corners (clicked) + VP_Y (from rim ∩ rail) + VP_Z (from Hough). A unique closed-form solution exists and `fx` is recovered from VP orthogonality. **But the recovered pose is geometrically wrong** — its predicted positions for off-click landmarks (`rim_NW`, `rib_W_upper`) land on the 80/20 aluminum extrusion and plumbing, not on the actual far rim of the flume.

**Root cause is geometric degeneracy, not missing math**: `rim_NE` and `rim_SE` are on a single world line (X=838, Z=0). Two colinear point correspondences + two VPs can't uniquely determine camera position without one more landmark that lies off that line. This is a well-known PnP limitation ("colinearity singularity"), not something more clicks on Y-parallel or Z-parallel lines can fix.

## What we have

- `calib/reference_frames/javier.jpg` (frame at t=30s)
- `calib/annotations/javier.json` — 4 user clicks + derived VPs
- `scripts/solve_pose_v2.py` — nonlinear LM solver (joint fx, R, t with VP residuals + fx prior + multi-start)
- `scripts/solve_pose_closedform.py` — closed-form solver (orthogonality → fx, VPs → R, points → t, sign enumeration)
- `calib/pose_javier.json` — best-fit pose, residuals, all landmark projections
- `calib/pose_javier_overlay.jpg` — visualisation

## Final numbers

```
fx (from VP orthogonality)  = 716.0 px   (EXIF prior was 780; no lens tag available)
VP_Y (rim ∩ rail)           = (497.9, 1583.2) px
VP_Z (Hough, 421 lines)     = (172.3, 112.4) px    ← unstable to filter width
camera centre (world mm)    = (794, 2027, +6)
standoff from rim_SE        = 107 mm
standoff from rim_NE        = 2028 mm
reprojection residual rim_NE = 0.00 px
reprojection residual rim_SE = 0.00 px
```

`fx = 716` suggests a wider-than-26mm-equiv lens (FOV ~74°), closer to 24 mm equiv or the ultra-wide. Consistent with the very close standoff needed to see so much scene.

## Why the pose is wrong even with zero residual

The reprojection residual is zero because we only have 2 point correspondences and both happen to lie on one world line. **Any camera pose that correctly projects those 2 points gives residual = 0**, regardless of whether it's the true pose. The VP constraints fix rotation (up to sign), but not the camera's **translation along certain axes**.

Visual confirmation in [calib/pose_javier_overlay.jpg](../calib/pose_javier_overlay.jpg):
- `rim_NW` predicted at image (818, 1448) — **lands on the 80/20 aluminum bracket**, not on any flume rim feature
- `rib_W_upper` predicted at (875, 1424) — **lands on the aluminum extrusion**
- `edu_midpoint` predicted at (638, 1451) — **lands on sediment, not at the inlet EDU**

These predictions would have to coincide with real flume features if the pose were correct. They don't.

## What each approach did and didn't buy

| Attempt | Data added | Result |
|---|---|---|
| v1 (2 points, fx prior) | rim_NE, rim_SE | rim_SE residual = 701 px. Pose fully degenerate. |
| v2 (add rail line) | +2 pts on overhead rail → VP_Y | Residuals went to 0 px but pose placed camera at rim level near rim_SE; **4 of 8 multi-starts converged to same degenerate minimum**. fx=602. |
| v2 + window-edge | +2 pts on window edge | Window edge direction was 102° (near vertical, parallel to rail/rim at ~93-147° cluster). No new axis info. Pose unchanged. |
| Closed-form (current) | VP_Y + VP_Z + orthogonality | fx=716 directly. Pose unique given data. Still wrong — predicts landmarks in wrong locations. |

## Why more clicks on Y-parallel or Z-parallel lines can't help

VP_Y is already nailed by rim∩rail at 0 px error. Another Y-parallel line reconfirms but adds nothing. Similarly another Z-parallel line reconfirms VP_Z but doesn't break the camera-translation degeneracy along the line through rim_NE and camera.

**Only two kinds of clicks close the solve:**

1. A 3D landmark whose world coordinates are known and that is **not** on the X=838, Z=0 line. Candidates in the javier frame: `rib_W_upper` (0, 343, 0), `rib_W_lower` (0, 1588, 0), `edu_midpoint` (419, 30, 127), or `standpipe_*`. None were visible (far rim + standpipe cropped; EDU not identifiable; linear outlet this session).
2. Two points on a world-X-parallel line that actually exists in the image (the far cross-rim top edge, or any feature on a wall perpendicular to flume length). The user tried three candidates; all three came back as lines parallel to Y-axis in world (the building's side walls, not its end walls — this lab has the flume's long axis parallel to the nearest room wall). There is no visible world-X-parallel line in this frame to click.

## Honest final state per phone (session 1)

| Phone | In-frame landmarks | Pose solve outcome |
|---|---|---|
| anna | 0 | Unsolvable (confirmed from budget analysis and reference frame). |
| sophia | ≤6 eqs, pending native-res recheck | Not attempted. |
| valentine | 2 rib attachments (colinear) + 2-point rail line | **Attempted. fx recovered at 781 px (matches EXIF prior 780 to 0.1%).** Pose still geometrically ambiguous — same colinearity singularity as javier (2 rib points at Y=343 are colinear; even with non-colinear L-shape including rail, LM converges to a pose that reverses the depth ordering of rim corners vs ribs). See [calib/pose_valentine_overlay.jpg](../calib/pose_valentine_overlay.jpg). |
| **javier** | 2 colinear pts + VP_Y + VP_Z | **Closed-form solve produced a non-unique-looking pose; pose ambiguity cannot be resolved from this frame alone.** |

## Academic takeaways

1. VP orthogonality recovers focal length to ~10% accuracy from as few as two distinct parallel-line families in the image — robust and practical.
2. **Two PnP point correspondences on a single world line is a known singular configuration.** It doesn't matter how many VPs or line constraints you add afterward; the translation component along the line-through-camera remains under-constrained.
3. The filename hint "Linear Outlet" — i.e. the landmark we'd most want (standpipe) is physically absent this session — was a load-bearing data gap that wasn't obvious at the start.
4. **Valentine's frame is the better bet for a clean worked example.** Her frame has rim_NW visible (one corner of the X=0 rim) in addition to rim_NE — two corners on *different* world lines, which eliminates the colinearity singularity. Running the same solver against her clicks should give a clean result.

## Artifacts

- [scripts/solve_pose_v2.py](../scripts/solve_pose_v2.py) — LM solver with VP + line constraints + multi-start
- [scripts/solve_pose_closedform.py](../scripts/solve_pose_closedform.py) — closed-form solver
- [calib/annotations/javier.json](../calib/annotations/javier.json) — user-click landmark JSON
- [calib/annotate.html](../calib/annotate.html) — updated with javier view + line-tag pseudo-landmarks + line_tag serialisation
- [calib/pose_javier.json](../calib/pose_javier.json) — final pose output (honest but inconclusive)
- [calib/pose_javier_overlay.jpg](../calib/pose_javier_overlay.jpg) — diagnostic overlay showing the degeneracy

## Valentine — additional notes (2026-04-16)

Setup: valentine's flume corners are occluded by a water-inlet tube, so true rim_NW / rim_NE / rim_SW / rim_SE are never clickable in her frame. What's visible is a permanent wooden cross-bar clamped at the ribs (Y=343 per the schema) with bright blue clamps at each end, and the two long rims as bright silver edges running down the sides of the image.

User clicked:
- `rib_W_upper` @ (35, 190) px  →  world (0, 343, 0) — west end of upper cross-rib
- `rib_E_upper` @ (797, 107) px  →  world (838, 343, 0) — east end
- `rail_pt_A` @ (844, 123) px and `rail_pt_B` @ (1042, 521) px — 2 points on the X=838 long rim edge

Solve via LM nonlinear optimisation (`scripts/solve_valentine_pose.py`) with fx prior, rib reprojections, rail-line constraint (partial 3D with Y as nuisance params), multi-start over physically-reasonable camera positions.

Output: `fx = 781.1` px (vs. prior 780 — almost exact match), `C = (1068, 1079, 228)` mm (camera ~1 m standoff, ~23 cm above rim, outside the X=838 long wall). Reprojection residuals: rib_W_upper 0.0 px, rib_E_upper 6.1 px, rail_pt_A 26.4 px, rail_pt_B 2.1 px.

**But the overlay shows the pose is wrong.** Predicted rim_NW/rim_NE positions appear *below* the ribs in image space, when they should appear *above* (Y=0 is farther from camera than Y=343, so should project closer to VP_Y = smaller v). The LM settled into the colinearity-driven alternative pose.

So valentine's solve has the **same failure mode as javier** — not because of poor data quality, but because:
- The 2 rib points lie on a single world line (Y=343, Z=0).
- The rail line shares its world-Y-axis direction with the flume length.
- The L-shape formed is non-colinear overall, but PnP on 2 points + 1 line still has a reflective ambiguity the data can't resolve.

The only thing that *would* close it cleanly: a click on a landmark at a **different Y AND different X** than the existing clicks (e.g., the `rib_W_lower` at (0, 1588, 0) on the opposite side of the flume, or any visible standpipe / sensor pin / marker at a known world position off both visible lines).

## Revised session-1 final state

**Two phones attempted, both failed due to the same structural issue** (colinearity or its generalisation to 2 coplanar world lines). One phone (anna) is unsolvable from frame data. The common thread across all three is insufficient visible off-rim-line landmarks. The landmark-budget table in `probe/landmark_budget.md` counts *equations* but not their *independence under perspective projection*; that's the real ceiling.

## UPDATE 2026-04-17 — Manual-tune tool + valentine closed

Built an interactive pose tuner at [calib/pose_tune.html](../calib/pose_tune.html) — it takes the solver's camera-centre estimate + the projected flume wireframe (rim rectangle, 2 cross-ribs, standpipe, EDU) and lets the user drag sliders for yaw/pitch/roll/Cx/Cy/Cz/fx/k1/k2 until the wireframe overlays the actual scene. Radial distortion (k1, k2) is baked into the projection (lines subdivided to 40 segments and distorted per-segment, so straight world lines curve correctly in image).

Per-phone final status:

| Phone | Status | Notes |
|---|---|---|
| **valentine** | ✅ **Closed (manual-tuned).** | fx=781 (matches EXIF to 0.1%). C=(1068, 1079, 228 mm), yaw=−100°, pitch=−68.5°, roll=0. Pose saved to [calib/pose_valentine.json](../calib/pose_valentine.json). User reports "perfect" alignment. |
| **sophia** | ✅ **Closed (manual-tuned, approximate).** User reports "not perfect but close". | fx=763 (~6% from EXIF prior). C=(430, 1510, 357 mm), yaw=−86.5°, pitch=−67°, roll=0. No distortion applied. Pose saved to [calib/pose_sophia.json](../calib/pose_sophia.json). Distortion turned out to be the wrong diagnosis — the angle mismatch was actually resolved by widening the fx slider range + the new `standoff` slider for independent size control. |
| **javier** | ✅ **Closed (manual-tuned, approximate).** User reports "tiny bit off but close". | fx=1681 (surprisingly high; FOV_h ~36°, telephoto-ish — consistent with user having zoomed / cropped framing given the metadata-stripped re-export). C=(201, 2420, 237 mm), yaw=−77°, pitch=−6°, **roll=−90.5° (image is landscape-in-portrait-container).** Pose saved to [calib/pose_javier.json](../calib/pose_javier.json). |
| **anna** | **Unsolvable from session 1.** Frame is too close / pure sediment. Confirmed by user. | Her pose will have to come from session 2 (where rim is partially visible) or nothing. |

## If you want to push further

The mesh you showed earlier in the Waldo viewer would trivialise this: `StreamTable.glb` provides dense 3D landmarks covering the whole scene, and phone→mesh PnP would close in minutes with no ambiguity. That's still the cleanest path forward if you can obtain the GLB from the GSD course staff. The in-video-only solve, now that we've walked through it, is provably limited by what's visible in any single phone's frame.

## Final result (end of 2026-04-17 session)

Three of four phones have approximate session-1 poses on disk. All three were converged via the manual-tune tool after automated solvers hit colinearity singularities:

| Phone | File | fx (px) | Roll | Notes |
|---|---|---|---|---|
| valentine | [calib/pose_valentine.json](../calib/pose_valentine.json) | 781 | 0° | User: "perfect" |
| sophia | [calib/pose_sophia.json](../calib/pose_sophia.json) | 763 | 0° | User: "close" |
| javier | [calib/pose_javier.json](../calib/pose_javier.json) | 1681 | −90.5° | User: "tiny bit off". Telephoto + unusual orientation. |
| anna | — | — | — | Unsolvable from S1 (no structure in frame). |

Sophia and valentine have nearly identical `fx` (763 and 781 — both main-wide iPhones) and near-identical pitch (−67°, −68.5°) — suggests both phones were mounted on tripods at similar heights and tilts, which is a reassuring cross-check. Javier is the outlier across multiple parameters (fx, roll), which matches the file-provenance flags (Dolby Vision re-export, metadata stripped, .mov vs .mp4 format mismatches in session 2). His pose should be treated as lower-confidence than the other two.

The tool that made this work — [calib/pose_tune.html](../calib/pose_tune.html) — ended up being more productive than the automated solvers for this rig, because the eye can resolve the colinearity ambiguity that geometric constraints alone cannot.

## Overlay-video check (2026-04-17)

Generated `overlay_<label>.mp4` for all 3 solved phones via [scripts/make_overlay_video.py](../scripts/make_overlay_video.py) using [scripts/pose_utils.py](../scripts/pose_utils.py). Each overlay draws the schema wireframe (rim + cross-ribs + standpipe) projected by the pose onto every sampled frame:

| Phone | Overlay quality |
|---|---|
| javier | **Approximately aligned** — red rim lines roughly trace the flume edges; blue cross-rib falls near the wooden bar; green lower-rib crosses the image plausibly. Imperfect but interpretable. |
| sophia | **Partial** — only upper and lower cross-rib edges visible (the rim corners project off-frame top/bottom). Suggests sophia's camera is closer than the schema rectangle's centre, so the rim falls outside her FOV. |
| valentine | **Empty** — all 11 schema landmarks project off-frame. Her tune aligned only the visible cross-bar locally, leaving the schema rim geometrically consistent with that constraint but physically wrong. |

**Key insight the overlay exposes**: a manual tune is only as tight as the landmarks you can see while tuning. For valentine, with just the wooden cross-bar visible (a single world line of unknown Y), the solve was under-constrained — any rotation/translation that keeps the bar in the right place counts as "aligned" to the eye, even when the rest of the flume drifts off. **Her pose should be re-tuned or re-measured with a more aggressive reference** (e.g., measuring the actual Y of the wooden bar and updating the schema, or finding another landmark in the flume interior visible in her frame).
