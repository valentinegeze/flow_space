# Stream-table multi-view calibration & digital twin

A research project building a digital twin of a physical stream-table experiment from
synchronized multi-camera recordings, with the eventual goal of using the twin to model
post-fire flood behavior. This document is a self-contained brief for getting outside
advice on the calibration code.

---

## 1. The vision

The stream table is a sand-and-water flume used to physically simulate hydrology. We
recorded one experiment from **four phone cameras** (anna, sophia, valentine, javier) and
**one Azure Kinect** (RGB + depth, mounted overhead). The goal is to:

1. **Calibrate the rig** — recover each camera's pose in a shared world frame, in physical
   units (mm), tied to the flume's geometry.
2. **Reconstruct in 3D** — combine the multi-view RGB with Kinect depth for a frame-by-frame
   3D reconstruction of the bed and water surface.
3. **Build a digital twin** — a runtime simulation that matches the physical experiment.
4. **Bridge to fire** — use the twin to simulate post-fire hydrology (smaller soil
   particles after a burn → different runoff behavior on burned vs unburned terrain).

Step 1 (calibration) is what's currently in flight and is where we want advice.

---

## 2. Physical setup

### Cameras

| label     | device                      | sees                                     | sync-clap visible |
|-----------|-----------------------------|------------------------------------------|-------------------|
| anna      | iPhone (model stripped)     | side view, oblique                       | yes               |
| sophia    | iPhone 16 Pro               | downstream end, looking up the channel   | yes               |
| valentine | iPhone 13 mini              | downstream end, looking up the channel   | yes               |
| javier    | iPhone (model stripped)     | side view                                | no                |
| kinect    | Azure Kinect color          | overhead, narrow view of channel middle  | yes               |

Sync was done by clapping two plastic tubes together (clapperboard) at the start. The
clap's video timestamp per cam is in `data/sync.json`. Javier's recording missed the clap,
so it's excluded from the synced multi-view.

### Flume coordinate system

The flume has a known rectangular rim ("the channel") with these mm coordinates (from
`calib/pose_tune.html`'s `WORLD` dict):

```
rim_NW: (0,    0,    0)
rim_NE: (838,  0,    0)
rim_SE: (838,  1930, 0)
rim_SW: (0,    1930, 0)
```

Plus four cross-rib endpoints (Y=343 and Y=1588 on both walls), the standpipe base
(419, 1900, 0), and an EDU midpoint at (419, 30, 127). All rim corners + ribs +
standpipe base are coplanar (Z=0). This is our world frame — we want every cam's
view matrix expressed here.

The flume sits on a larger lab table (120" × 38.5" = 3048 × 977.9 mm). The Kinect is
mounted **30.25" above the table centre** (= 768.4 mm height, confirmed against Kinect
depth median 772 mm), at (482.6 mm, 1460.5 mm) on the lab table — roughly centered
widthwise (49.4%) and slightly past lengthwise centre (47.9%). Where the flume sits on
the lab table is **not** measured precisely.

### Kinect FOV problem

The Kinect's overhead FOV catches the channel **middle** but **not the rim corners** or
the inlet/outlet hardware. So the Kinect cannot directly see any of the four rim_NW/NE/
SE/SW landmarks. Cross-ribs at Y=343 and Y=1588 are likely visible.

### Intrinsics caveat

`calib/intrinsics.json` lists per-phone intrinsics derived from EXIF or assumed 26mm-eq
focal lengths:

| label     | W    | H    | fx (assumed) | certain? |
|-----------|------|------|--------------|----------|
| anna      | 720  | 1280 | 480          | no       |
| sophia    | 1080 | 1920 | 720          | no       |
| valentine | 1080 | 1920 | 780          | no       |
| javier    | 1080 | 1920 | 780          | no       |
| kinect    | 1080 | 1920 | from factory | partial  |

The Kinect's color cam factory intrinsic is for **4096 × 3072 landscape**; the proxy
`calib/reference_frames/kinect.jpg` is **1080 × 1920 portrait**, meaning the proxy was
rotated 90° at extraction. The current code scales `fx` and `fy` by `1080/4096` and
`1920/3072` respectively, **without** swapping fx↔fy or cx↔cy for the rotation. This
may be wrong; we haven't confirmed.

---

## 3. Calibration state on disk

```
calib/
  intrinsics.json                       # phone intrinsics (uncertain)
  kinect_intrinsics.json                # Azure Kinect factory intrinsics
  cross_features_merged.json            # 6 hand-clicked features × 4 cams (newer round)
  cross_features.json                   # 5 features × 3 cams (older round, has stale BA xyz)
  reference_frames/<label>.jpg          # one stable frame per cam at clap+5s
  pose_<label>_kinect_anchored.json     # per-cam pose in Kinect's frame (latest, Apr 17)
  pose_<label>_refined.json             # earlier joint-BA result (degenerate — features at ±9 km)
  pose_<label>.json                     # earliest per-cam PnP (assumed intrinsics)
  pose_<label>_flume.json               # NOT YET SOLVED — target output of kinect_align.html
```

The `kinect_anchored` poses are the most trustworthy. They have reasonable reprojection
errors (22–36 px mean) and are anchored to the **Kinect's color-camera frame** as world
(not the flume frame). Notes in those files explicitly call out: "to convert to flume
frame, need a rigid transform from Kinect frame → flume frame, computed from 3+ known
world points."

The `_refined` (BA) results are known-bad. Joint bundle adjustment on 5 features × 3 cams
collapsed to 1.9 px reprojection but moved features to ~9 km away — classic
under-constrained-BA degeneracy.

---

## 4. The interactive tools (browser, all in `calib/`)

All tools assume a local HTTP server with PUT support running from the repo root. We use
`scripts/pair_tune_server.py` (a SimpleHTTPRequestHandler subclass that accepts PUT into
`calib/*.json`).

```
python3 scripts/pair_tune_server.py    # serves on localhost:8000
```

### `pair_tune.html` — pairwise epipolar tuner with optional 3D anchors

Loads a pair of cams (cam A ↔ cam B) and lets you tune cam B's 6-DOF relative pose
plus optional intrinsic refinement (fx_A, fx_B). For each correspondence visible in
both cams, displays the **Sampson distance** (the residual we minimize). For features
with a 3D world anchor (XYZ in cam A's frame), displays per-cam **reprojection error**
instead and contributes 2-px residuals to the LM cost.

Math:

- View matrix per cam: `viewMatrixA() = [I | 0]`, `viewMatrixB(state) = [R | t]` where
  `R = eulerToR(yaw, pitch, roll)` (ZYX intrinsic) and `t = -R · C` (Simek).
- Camera matrix: `K = [[fx, 0, cx], [0, fy, cy], [0, 0, 1]]`.
- Fundamental: `F = K_B⁻ᵀ · [t_rel]× R_rel · K_A⁻¹` where R_rel and t_rel come from
  composing the two view matrices.
- Sampson: `(x₂ᵀ F x₁)² / (||(F x₁)[:2]||² + ||(Fᵀ x₂)[:2]||²)`.
- LM with numerical Jacobian (forward diff), Marquardt damping, free-parameter mask
  (checkbox per param: Cx, Cy, Cz, yaw, pitch, roll, fx_A, fx_B).

Shows side-by-side reference frames with feature dots colour-coded, plus the gold
**epipolar line** in the clicked image (representing the other cam's view of that
feature) and an **epipole marker** at the projection of the other cam's optical centre.

Undo/redo via Cmd-Z / Cmd-Shift-Z. Commit-to-disk PUTs `pair_<A>_<B>.json`.

**Status**: works, but the pairwise solve is scale-ambiguous — translation magnitude is
free along the t direction. 3D anchors are the only way to pin it.

### `kinect_align.html` — homography-based "anchor-cam-to-flume"

Pick a cam from the dropdown. The sidebar shows 9 known coplanar (Z=0) flume landmarks
grouped into rim corners, cross-rib endpoints, and other (standpipe base). Toggle the
checkboxes for whichever you can identify in this cam's image, click each in the image,
solver auto-runs once ≥4 are clicked. Method:

1. **DLT homography** from world XY ↔ image UV (4+ point pairs, Z=0 plane).
2. **Decompose** H into [R | t] using K (Faugeras style: `H = K · [r1 r2 t]`,
   `r1 = K⁻¹ h1 / λ`, etc., orthogonalize R via Gram-Schmidt + cross product).
3. Recovered pose displayed; reprojection RMS over the clicked points.
4. Tape-measure sanity check (Kinect only): solved height vs 768 mm, solved (x,y)
   vs flume-centred prediction.
5. Commit writes `pose_<cam>_flume.json`.

**Status**: written and parses. Not yet exercised by the user — they'll click corners on
a phone (e.g. valentine, since it sees the rim) and ribs on the Kinect.

### `multiview.html` — first-person fly-around through synced video

A Three.js scene where each cam is a billboard at its solved pose with the proxy video
playing on its image plane. Snap buttons fly the orbit camera between camera "eyes" with
quaternion slerp + position lerp + FOV lerp over 1.3 s. While locked to a cam, controls
are disabled and the orbit camera's projection matches that cam's intrinsics — so the
billboard fills the screen exactly (math: at depth D with size `(D·W/fx, D·H/fy)`, it
subtends `2 atan(H/2fy)` vertically, which is the FOV we set).

Sync via `data/sync.json`'s `clap_time_s` per video. Master clock = "seconds since clap";
each video's `currentTime = clap_time_s + master`. Drift > 250 ms triggers a re-seek.

**Status**: works for 3 cams (anna, sophia, valentine — proxies exist). Kinect color
isn't wired (its 20 GB MKV needs an offline ffmpeg extraction to mp4 first). Currently
poses come from `pose_<cam>_kinect_anchored.json` (Kinect's frame), so the flume-rim
wireframe doesn't line up with the videos until at least one cam is anchored to the
flume via kinect_align.html.

---

## 5. Coordinate conventions

- All calibration math: **OpenCV** — X right, Y down, Z forward.
- Three.js scene: standard Y-up, Z-toward-camera. `multiview.html` converts CV → Three.js
  by flipping Y and Z (equivalent to `diag(1,-1,-1)` on both sides of the rotation matrix).
- View matrix `[R | t]` takes **world points** to **camera coordinates**:
  `X_cam = R · X_world + t`.
- Camera centre in world: `C = -Rᵀ · t`.
- Sliders in pair_tune control C (cam B's centre in cam A's frame) plus Euler angles;
  `t` is derived as `-R · C`.

---

## 6. The road we walked (and where we're stuck)

### Earlier attempts (Apr 16–17)

1. **Per-cam PnP** with assumed intrinsics → `pose_<cam>.json`. Reasonable starting point
   but high reprojection errors (sometimes 100+ px) because intrinsics were wrong.
2. **Joint bundle adjustment** with 5 features × 3 cams → `pose_<cam>_refined.json`.
   Reprojection collapsed to 1–2 px but features moved to ±9 km. Classic
   under-constrained-BA: with 5 features and 3 cams free, there are too few residuals
   for the parameter count.
3. **Kinect-anchored PnP** — used the Kinect depth at clicked feature pixels to lift them
   to 3D in Kinect's frame, then per-cam PnP against those 3D points → 22–36 px mean
   reprojection. These poses (`pose_<cam>_kinect_anchored.json`) are the current best.
   Stalled on: needed a Kinect→flume rigid transform to convert to a physically
   meaningful frame.

### Current attempt (Apr 22 onward)

Move into the browser:

- Pairwise epipolar with manual tuning + LM (pair_tune.html) — gives R + t-direction
  per pair, scale-ambiguous.
- 3D anchors per feature (XYZ in cam A's frame) — resolves scale once any one is set.
- Homography-based per-cam-to-flume anchoring (kinect_align.html) — needs ≥4 coplanar
  visible landmarks per cam.
- First-person multiview (multiview.html) — relies on whichever poses exist on disk;
  upgrades automatically as `pose_<cam>_flume.json` gets created.

### Open problems we want advice on

1. **Kinect-to-flume anchoring without rim corners.** The Kinect doesn't see rim_NW/NE/
   SE/SW. The plan is to use the four cross-rib endpoints (rib_W_upper, rib_E_upper,
   rib_W_lower, rib_E_lower at Y=343 and Y=1588 on both walls). Concerns: cross-rib
   endpoints are ambiguous to identify visually (the rib meets the wall at a fuzzy edge),
   so click accuracy may be ~5–10 px → ~mm-level error in flume-frame Kinect pose. Is
   this acceptable? Should we instead solve a depth-aware 3D rigid transform (use Kinect
   depth at the rib endpoint pixels, get 3D in Kinect frame, then 4-point rigid
   alignment between two 3D point sets — Procrustes/Kabsch)?
2. **Kinect color intrinsic rotation.** The factory intrinsic is for 4096×3072 landscape,
   but the proxy is 1080×1920 portrait. Current code scales without swapping fx↔fy /
   cx↔cy for the rotation. Need to verify orientation and apply the right correction.
3. **Anna's intrinsic is fully unknown** (EXIF stripped). The pair_tune LM can refine
   fx_A, but with 5–6 correspondences per pair and 7 free params (6-DOF + fx), the
   problem is borderline observable. Recommendation?
4. **Chaining pairs through a graph.** Once we have rim-anchored poses for one or two
   phones plus pairwise relative poses, we want to compose them into a globally
   consistent set. The naive composition will accumulate error. Should we be doing a
   final global BA over (cam extrinsics, feature 3D positions, intrinsics) once a few
   anchors exist? Or use pose-graph optimization with the homography results as
   strong-prior constraints?
5. **Multi-video sync precision.** HTML5 `<video>` elements drift; we re-seek when drift
   exceeds 250 ms. For visual fly-around this is fine; for actual measurement we'd want
   frame-accurate sync. Better strategy?
6. **Browser-side LM for pairs vs Python BA for the full graph.** The browser tools are
   responsive and let the user iterate, but for the final solve a more numerically
   careful BA (Ceres-style) might be appropriate. Where's the right line between "ship
   the in-browser solve" and "go to Python"?

---

## 7. What advice we'd find most useful

Concretely, please weigh in on:

- **Anchoring strategy** for the Kinect (cross-ribs vs depth-based rigid alignment vs
  some clever fiducial we haven't thought of).
- **Whether the pair_tune LM is well-formed** — Sampson + reprojection mixed cost,
  numerical Jacobian, Marquardt damping. Anything we should change.
- **Convention bugs** — is anything we wrote subtly wrong about extrinsic vs view
  matrices, sign flips, Euler conventions, etc.? See the `viewMatrixA / viewMatrixB /
  fundamental` block in `calib/pair_tune.html`.
- **Whether the fly-around tool's first-person trick** (orbit camera FOV = solved cam
  FOV, image plane at `D·{W/fx, H/fy}` so it fills the view) is the right approach, or
  whether we should be doing actual textured-frustum projection / IBR.

---

## 8. Quick file map

```
stream-table/
├── PROJECT.md                      ← this file
├── data/
│   ├── sync.json                   ← clap times per cam
│   └── depth/                      ← extracted Kinect depth frames
├── videos/
│   ├── *.mp4 / .mkv                ← raw recordings
│   └── proxies/*.mp4               ← browser-friendly h264 proxies
├── scripts/
│   ├── pair_tune_server.py         ← static + PUT server for the browser tools
│   ├── kinect_anchor_pnp.py        ← original Python PnP that produced kinect_anchored
│   ├── bundle_adjust*.py           ← earlier failed BA attempts
│   ├── extract_depth.py
│   ├── extract_sync_frames.py
│   ├── sync_clap.py / detect_clack.py
│   └── …                            (plenty more, mostly diagnostic)
├── calib/
│   ├── pair_tune.html              ← pairwise epipolar tuner + LM + 3D anchors
│   ├── kinect_align.html           ← cam → flume homography
│   ├── multiview.html              ← first-person fly-around
│   ├── pose_tune.html              ← (older single-cam PnP tuner — deprecated by pair_tune)
│   ├── intrinsics.json
│   ├── kinect_intrinsics.json
│   ├── cross_features_merged.json
│   ├── cross_features.json
│   ├── pose_<cam>_kinect_anchored.json
│   ├── pose_<cam>_refined.json     (known-bad)
│   ├── pose_<cam>.json             (early naive PnP)
│   └── reference_frames/<cam>.jpg
```

The browser tools all use the same coordinate conventions and read directly from these
JSON files, so changes are hot-reload by refreshing.
