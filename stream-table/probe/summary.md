# Stage 1 — Input Probe Summary

Generated from `ffprobe -show_streams -show_format -print_format json` on each input.
Raw JSON per file in `probe/<filename>.json`.

## File table

| Label     | File                                                   | Container | Resolution (stored) | Display WxH | FPS    | Duration | Codec (v) | Audio?         | Size    |
|-----------|--------------------------------------------------------|-----------|---------------------|-------------|--------|----------|-----------|----------------|---------|
| anna      | `AM_03-11_01_wide-inlet_no-obstacles.mp4`              | mp4       | 1280×720 rot −90°   | 720×1280    | 30.00  | 274.27 s | H.264     | AAC 2ch 44.1k  | 117 MB  |
| sophia    | `skm_0311_01_wide_no-obs.mp4`                          | mp4       | 1920×1080 rot −90°  | 1080×1920   | 30.00  | 206.10 s | H.264     | AAC 2ch 48k + 4ch aux | 393 MB |
| javier    | `20260311_Linear Outlet_No Artifacts.mp4`              | mp4       | 1080×1920 (native)  | 1080×1920   | 30.00  | 319.74 s | H.264     | AAC 2ch 48k    | 334 MB  |
| valentine | `vmg_03-11_01.mp4`                                     | mp4       | 1080×1920 (native)  | 1080×1920   | 30.00  | 226.88 s | H.264     | AAC 2ch 48k    | 613 MB  |
| kinect    | `depth_20260311_105209.mkv`                            | matroska  | see below           | —           | 30.00  | 237.93 s | see below | **none**       | 20.62 GB |

## Kinect MKV — Azure Kinect confirmed

Matroska tags include `K4A_DEPTH_FIRMWARE_VERSION`, `K4A_COLOR_FIRMWARE_VERSION`, `K4A_DEVICE_SERIAL_NUMBER`, `K4A_DEPTH_DELAY_NS`, `K4A_WIRED_SYNC_MODE`, `K4A_START_OFFSET_NS` — this is an Azure Kinect recording written by the official SDK recorder, not libfreenect2.

Stream breakdown (all tracks at 30 fps, duration 237.93 s):

| Track | Title  | Codec      | Dimensions  | Notes                                                            |
|-------|--------|------------|-------------|------------------------------------------------------------------|
| 0     | COLOR  | MJPEG      | 1920×1080   | compressed RGB; decode via ffmpeg/pyav                           |
| 1     | DEPTH  | rawvideo   | 640×576     | 16-bit raw mm depth (NFOV unbinned 2×2). **This is the depth stream.** |
| 2     | IR     | rawvideo   | 640×576     | 16-bit IR reflectance, same optical geometry as DEPTH            |
| 3     | IMU    | subtitle   | —           | K4A IMU samples (accel + gyro) written as timed metadata         |
| 4     | —      | attachment | —           | likely K4A calibration blob (camera intrinsics/extrinsics JSON)  |

**Access note:** `cv2.VideoCapture` will only surface the COLOR track reliably. Use `pyk4a` (preferred), or parse tracks 1–2 directly via `pyav` (`container.streams.video[1]` and `[2]`) to read the raw 16-bit depth/IR planes. The attachment at track 4 likely holds the factory calibration — we'll need it for Stage 3/4 to unproject depth to metric XYZ.

## Clack-detection implications for Stage 2

- **Audio available** on all four phone videos (anna, sophia, javier, valentine) — Hilbert-envelope onset detection (already proven by `scripts/sync_clap.py`) should localize the clack to ~1 ms on each.
- **No audio on the Kinect MKV.** Stage 2 will need the visual-fallback path for this file: decode the COLOR stream, look for the two white PVC pipes converging in the first ~30 s. I'll need you to confirm (or adjust) an ROI before running.
- Sophia has a second audio track (4-channel spatial audio). The 2-channel AAC at index 1 is the one to extract — it's what the existing sync script uses.

## Other observations

- Orientation: anna and sophia are stored as landscape raster with a −90° display-matrix rotation; javier and valentine are already native portrait. Stage 4/5 needs to apply the rotation metadata when rendering or sampling frames — `pyav`/ffmpeg `-vf "transpose"` will handle this, but raw OpenCV reads will NOT auto-rotate.
- `creation_time` is 2026-03-11 across all five (matches the experiment date encoded in filenames).
- sophia and anna embed iPhone GPS tags; javier and valentine do not (edited/re-exported).
- All five inputs are ≥206 s and the clack, per the existing sync run, falls in the first 25 s of every file — we have plenty of post-clack content.
