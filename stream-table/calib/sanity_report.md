# Stage 3 — Intrinsics + Sanity Check Report

## Phone initial intrinsics

All three phones use EXIF-derived or assumed 35mm-equivalent focal length; cx,cy defaulted to image center; distortion set to zero initially. These are refineable via bundle adjustment after the initial PnP.

| view | device | lens | feq (mm) | fx (px) | fov H° | fov V° | certain |
|------|--------|------|----------|---------|--------|--------|---------|
| anna | iPhone (model stripped by re-export) | main (assumed) | 24.0 | 480.0 | 73.7 | 106.3 | **no (assumed)** |
| sophia | iPhone 16 Pro | main (assumed; no explicit focal tag) | 24.0 | 720.0 | 73.7 | 106.3 | **no (assumed)** |
| valentine | iPhone 13 mini | main (wide, 26mm equiv — assumed default) | 26.0 | 780.0 | 69.4 | 101.8 | **no (assumed)** |

## Sanity check 1 — flume pixel extent vs EXIF prediction

For a camera viewing the flume fronto-parallel (camera axis normal to the surface being measured), the 1930 mm length projects to `L × fx / d` pixels at standoff `d`. All of these values shrink by `cos(θ)` for oblique viewing. Use this as an order-of-magnitude check:

| view | 0.5 m | 1.0 m | 1.5 m | 2.0 m | 2.5 m | 3.0 m | frame W | frame H |
|------|-------|-------|-------|-------|-------|-------|---------|---------|
| anna | 1853 | 926 | 618 | 463 | 371 | 309 | 720 | 1280 |
| sophia | 2779 | 1390 | 926 | 695 | 556 | 463 | 1080 | 1920 |
| valentine | 3011 | 1505 | 1004 | 753 | 602 | 502 | 1080 | 1920 |

**What to check visually in `calib/reference_frames/<label>.jpg`:**
- anna (side view from the east rail, upstream end, looking across-and-downstream): flume length runs diagonally away from camera; its diagonal extent in-frame should roughly match `1.0–2.0 m` row, adjusted by viewing-angle foreshortening (expect 30–60% of the number in the table).
- sophia / valentine (downstream end, looking upstream along the length): the length axis is close to the optical axis, so the 1930 mm projects to *very few* pixels along the image Y axis but the 838 mm width should fill most of the image width. If the width doesn't fill most of the frame, standoff is too far or focal length is too short (ultrawide?).

**If any view disagrees with this picture by >20%, the EXIF-derived `fx` is wrong** and we'll need to solve for the intrinsic jointly with the pose (DLT + nonlinear refine), or ask you for the device and lens model so we can look up the correct focal length.

## Sanity check 2 — Kinect depth statistics

Extracted frame at **t = 32.400 s** (clack + 5 s), DEPTH track 0:1, 640×576 gray16le.

```
            n_pixels_total: 368640
            n_pixels_valid: 303894
                 pct_valid: 82.44
                    min_mm: 672
                     p5_mm: 718
                 median_mm: 772
                    p95_mm: 823
                    max_mm: 841
                unit_check: mm
    nfov_unbinned_range_mm: [500, 5460]
         pct_in_nfov_range: 100.0
```

- **Unit check**: median 772 fits mm units (not m or arbitrary).
- **Mounting height**: median depth ≈ **772 mm = 0.77 m**. This is the Kinect-lens to scene-plane distance. For a table-top flume imaged from an overhead rig, this matches a tripod-over-flume setup.
- **Valid-pixel coverage**: 82.44% of depth pixels return a reading. Remainder are out-of-range / IR-absorbed (dark pits or shiny water surface).
- **NFOV range**: 100.0% of valid depths within [500, 5460] mm (the standard NFOV-unbinned depth band). High fraction = scene fits within depth sensor's recommended working range.

## Kinect intrinsics (from factory blob)

- **CALIBRATION_CameraPurposeDepth** — 1024×1024, fx=505.0  fy=505.2  cx=498.3  cy=521.2
- **CALIBRATION_CameraPurposePhotoVideo** — 4096×3072, fx=1940.2  fy=1939.9  cx=2051.4  cy=1544.8

Written: `calib/intrinsics.json`, `calib/kinect_intrinsics.json`, `calib/kinect_depth_stats_t32p4.json`, `calib/sanity_report.md`