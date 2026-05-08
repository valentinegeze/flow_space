# Session 2 — Tripod-invariance check & calibration-feature inventory

Stage 1/2 for session 2. Compares framing vs session 1 to decide whether poses solved on session 2 transfer to session 1. **Do not process session 2 further until findings below are resolved.**

Frames extracted from `videos/session_2/` at matched timestamps (t ≈ 2, 10, 60, 300 s). Reference crops archived in [probe/session2_compare/](session2_compare/).

## Files present in `videos/session_2/`

| Label     | File                                                  | Container | Stored res | Rotation metadata | Effective display | Duration |
|-----------|-------------------------------------------------------|-----------|------------|-------------------|-------------------|----------|
| anna      | `AM_03-11_04_narrow-inlet_no-obstacles.mp4`           | mp4       | 1280×720   | **none**          | 1280×720 LANDSCAPE| 387.9 s  |
| sophia    | `skm_0311_04_narrow_no-obs.mp4`                       | mp4       | 1920×1080  | `rotate=-90°`     | 1080×1920 PORTRAIT| 387.0 s  |
| javier    | `20260311_Single outlet_No artifacts.mov`             | mov (qt)  | —          | —                 | **unreadable**    | —        |
| valentine | *(absent)*                                            | —         | —          | —                 | —                 | —        |
| kinect    | *(absent)*                                            | —         | —          | —                 | —                 | —        |

Two critical gaps from what you described:
- **No Kinect MKV in session 2.** The overhead Kinect was not recorded during session 2 (or the file was not copied over). This has large consequences — see §3.
- **No Valentine MP4 in session 2.** Valentine drops out of session 2 regardless of tripod state.
- **Javier's .mov has no `moov` atom** (`ffprobe` errors with "moov atom not found"). The file starts with a valid `ftyp qt` + `wide` + `mdat` header but never got its index written — typical of a phone app crash or an incomplete copy. File size 140 MB contains raw H.264 data, so recovery is possible with `untrunc`/`recover_mp4` using a healthy reference recording **from the same device and the same app settings**. Without that, javier session 2 is unusable. Javier session 1 is `.mp4` from the same source so it's not an exact reference; untrunc sometimes succeeds with close matches — worth trying, but not guaranteed.

## 1. Tripod invariance, per camera

### Anna — **FAILS** (tripod moved back, not rotated)
- Session 1: stored 1280×720 with `rotate=-90` → rendered 720×1280 portrait. Reference frames (t=2, 15, 60) show pure sediment, **no rim visible anywhere** in frame.
- Session 2: stored 1280×720 with **no rotation metadata** → rendered 1280×720 landscape. Frames show the near rim running across the bottom edge and the far rim at the top edge with sediment between.
- Per confirmation: the phone was not reoriented, but the tripod was moved back (further from the table) to capture both walls. The rotation-metadata difference is likely an artifact of moving the tripod and the phone's orientation sensor re-latching — independent of the extrinsics change.
- Because the tripod position changed, **the extrinsic pose (R,t) solved from session 2 does not transfer to session 1**. The intrinsic calibration (K, distortion) is still invariant since it's a lens/sensor property, so session 2 can refine intrinsics that then apply to session 1 — but the extrinsic has to stay solved from session 1 landmarks.
- Anna's session 2 footage is self-consistent and calibrates anna's session 2 timeline independently.

### Sophia — **FAILS** (tripod shifted toward center)
- Both sessions: 1920×1080 stored, `rotate=-90°` → 1080×1920 portrait. Metadata matches.
- Per confirmation: in session 1 sophia's phone is more to the right of the bottom of the flume; in session 2, it is slightly more centered. Small translation, no rotation.
- This matches the rail-ghosting I saw in the S1↔S2 blend of the top 100 px — real, non-zero shift; too small to quantify via automated registration against sediment noise, but real.
- Like anna: intrinsics transfer, extrinsics do not. Session 2 pose is a good *initial estimate* for session 1 BA; it's not a direct transfer.

### Javier — **cannot verify yet**
- Session 2 file unreadable. Even if recovered, the .mov→.mp4 container change hints the device, app, or export pipeline differed — worth double-checking that the sensor/lens is unchanged. If javier rebuilt from scratch in session 2, calibration will not be tripod-invariant even if the tripod itself never moved.

### Valentine — **N/A (out of session 2)**
- Valentine left before session 2 recording began. She remains calibrated only from session 1.

### Kinect — **available, pending download**
- Session 2 Kinect MKV hosted at `https://streamtable.org/recordings/20260311_113127.mkv` (34.5 GB, not yet downloaded). Tripod-invariance is expected to hold (overhead mount was not touched). Once pulled, verify that the Kinect COLOR frame at a matched timestamp matches the session 1 COLOR reference in [calib/reference_frames/kinect_color.jpg](../calib/reference_frames/kinect_color.jpg).

## 2. Session-2-only calibration features (what session 1 lacks)

Inspected anna and sophia session 2 at t ∈ {0.2, 1, 2, 4, 6, 8, 10, 12, 15, 20, 25, 30, 35, 40, 45, 50, 55, 58, 60, 62, 65, 68, 70, 75, 80, 90, 100, 120, 150, 180, 300} s. Archived representative frames in [probe/session2_compare/](session2_compare/).

### Correction to earlier claim

My earlier report called out "a white PVC inlet held by hand in sophia session 2 around t ≈ 60 s." On closer inspection that was a **misread of sediment patterns** at the top of that frame — a slightly bright/dark sediment lobe I mistook for a pipe + hand. Going back through the archived `session2_compare/sophia_s2.jpg` confirms: no pipe, no hand, just flow patterns. I scanned the full video at 2 Hz for white-pixel spikes in the top 300 rows; the white count was essentially constant (~118–122 kpx across all samples), i.e. no transient PVC-sized white object appears anywhere in the video.

### Corrected inventory

| Feature | Where seen | Useful as landmark? |
|---------|------------|---------------------|
| **Central inlet fitting** | **Not visibly present as a rigid object in either phone view.** Anna's landscape framing captures the middle of the flume — the inlet is above her frame. Sophia's view down-flume from the downstream end has the inlet at her distant horizon (top of frame) where it's either out of frame or masked by the rim. | **No, for phone calibration.** The inlet may still be a world-known point (measurable with a ruler against the flume structure), but without a phone seeing it, it doesn't give an observation constraint on any phone's pose. |
| **Flume far rim (top edge of sophia)** | sophia session 2 at all t — same rim as session 1 | No new info beyond session 1. |
| **Flume near + far rim simultaneously** | anna session 2, both rim edges visible thanks to landscape framing | Not useful, because anna's S2 framing ≠ S1 framing. |
| **Two metal rails above flume** | visible across top of sophia's view, in both S1 and S2. These are rigid structural rails at known parallel spacing (838 mm). | Already a rails-as-lines constraint — session 2 doesn't add new rail geometry. |
| **Setup-moment hands / rulers / markers** | None observed in either video. Flume bed is already dressed with sediment at frame 0 in both videos. | None. |
| **Rim corners from new angle** | None. Anna's landscape view reveals edges, but the framing shift means those corners don't co-observe with session 1. | None. |
| **Dry / sediment-free bed** | Neither video opens on a clean bed. | None. |
| **Obstacles / rulers inside middle Y window (535–1395 mm)** | Filename says "no obstacles" — confirmed visually. Bare sediment bed. | None. |

### Net

**Session 2 adds essentially zero new calibration landmarks.** The only features visible in session 2 are the same rim/rail geometry already present in session 1. The hoped-for "central inlet as shared landmark" doesn't hold up.

What session 2 *does* still offer:
1. An independent per-phone recording that lets intrinsics be re-estimated and cross-validated (intrinsics are lens properties, invariant to tripod position).
2. For sophia (tripod-invariant): a second-session set of the same rim/rail observations — useful to reduce variance on the same landmarks via multi-frame averaging, not to add new landmarks.
3. For anna: intrinsic re-estimation only; no extrinsic transfer because tripod moved.

## 2b. Phone-only tripod-invariance verification — inconclusive

Automated registration between sophia S1 and S2 early frames:
- SIFT features: 5000+ detected per frame, but only ~0–29 pass a cross-frame ratio test. RANSAC homographies degenerate (corner displacements up to 2100 px, scale factors like 0.1–1.5 — clearly wrong) because the handful of true static matches are outnumbered by accidental matches on sediment noise.
- Phase correlation on the top 100–200 rows (most static region): peaks in the 0.003–0.04 range across all time samples. For truly aligned structured content the peak would be ≥0.3; these are noise-floor values, meaning there's too little shared texture for phase correlation to lock onto.
- Visual 50/50 blend of sophia's top 100 px (see [session2_compare/sophia_top_band_blend.png](session2_compare/sophia_top_band_blend.png) after archiving): the two metal rails above the flume **ghost slightly** — i.e. they're at subtly different positions between S1 and S2. I can't quantify the shift automatically, but it's not zero.

**Conclusion:** I cannot confirm sub-pixel tripod-invariance for sophia from phone data alone. There are two viable paths forward:

- **Option 1 (recommended, cheap): hand annotation.** I build a tiny annotation page: it shows sophia S1 and sophia S2 side-by-side and asks you to click the same 3–5 physical points (left rail end, right rail end, a rim corner, a clamp/bolt head). Takes you about 3 minutes. The pixel deltas directly measure tripod shift — if ≤2 px across points, invariance confirmed; if 5–20 px, small shift similar to anna's case (translation-mostly, poses needs BA); if >20 px, fail.
- **Option 2: rely on the Kinect depth data.** Kinect depth gives direct static-scene registration. If depth maps of the empty flume match to within depth noise between sessions, Kinect invariance is established; the phones still need their own check.

## 3. Implications for the calibration plan (revised)

With all three phones shifted between sessions and no new shared landmarks, the calibration plan's framing changes:

- **Original framing:** session 2 has better calibration geometry → solve poses on session 2 → transfer directly to session 1.
- **Revised framing:** session 2 is an independent recording of the same rig, where every phone moved slightly. Session 2 pose gives an *initial estimate*; session 1 landmarks do the final BA refinement. Session 2 provides extra data for *intrinsics* (lens properties, invariant to tripod shifts) and for cross-validating each phone's solve.

Per camera:

1. **Sophia**: tripod shifted toward center. Intrinsics transfer; extrinsic is a BA initial guess. Session 2 does **not** introduce a new shared landmark (earlier "PVC inlet" claim retracted).
2. **Anna**: tripod moved back. Intrinsics transfer; extrinsic is a BA initial guess. Session 2 framing shows both rims, which may give anna a few extra rim-corner observations *within session 2* — but those don't transfer to session 1 poses.
3. **Javier**: blocked on recovery of truncated `.mov`. If recovered, still need to verify tripod state given the `.mov` vs `.mp4` container difference.
4. **Kinect**: overhead mount believed invariant; unverified. Once MKV is downloaded, verify by depth-map comparison of the static tabletop between sessions.
5. **Valentine**: out of session 2.

### Key uncertainty

Session 2's utility now rests on whether it has **enough landmarks per phone to independently solve the pose**, so that that pose can serve as a BA initial estimate for session 1. Since the phones moved but the scene is unchanged, session 2's landmark budget is effectively the same as session 1's. If session 1 was landmark-marginal, session 2 is marginal in the same way — BA initial estimates won't rescue a problem with landmark count.

Before committing compute to session 2 processing, confirm: does each phone's session 2 view actually contain enough point+line landmarks (rim corners + rails as lines) to close the pose solve? This is the same math question that was open for session 1.

## 4. Still open (queued for your go-ahead)

- Re-evaluate per-phone landmark budgets with these findings folded in (your step 3).
- Rails-as-line-constraints math — compute required point count per phone given the two-parallel-rails line constraints, for both sessions. Session 2 does not change rail visibility meaningfully; whichever constraint holds for session 1 holds for session 2 the same way.
- Javier session 2 clack-sync feasibility — blocked until the .mov is recovered. If recovery succeeds, run `scripts/detect_clack.py` on the recovered audio; session 2 sync offsets go in a separate `data/sync_session2.json`.

## Answers received (2026-04-16)

1. Kinect MKV hosted at `https://streamtable.org/recordings/20260311_113127.mkv` (34.5 GB). Download pending.
2. Valentine left before session 2 — no file expected.
3. Anna's phone was not reoriented; tripod was moved back to include both walls. Extrinsics differ; intrinsics unchanged.
4. `untrunc` on javier approved.
