"""Kinect-vs-phone pose cross-check.

If the Kinect's pose (in the same world frame as the phones) is available, sample 3D points
from the Kinect's depth frame, project them into each phone's view using the solved phone
poses, and compare against where those points appear in the phone videos.

Currently a STUB: the Kinect's pose in the flume world frame is not yet solved. This script
outlines the pipeline and prints the specific data still needed to run it end-to-end.

Prerequisite to run:
  1. Solve the Kinect's pose in the same world frame used by the phones (origin at rim_NW,
     axes as in the schema). Options:
     (a) Manual tune: extract a Kinect-color frame where the flume rim is visible (the current
         calib/reference_frames/kinect_color.jpg is pure sediment and is useless for tuning),
         then tune via calib/pose_tune.html → save as calib/pose_kinect.json.
     (b) Depth-based solve: fit the Kinect's pose from the depth image itself by finding the
         flume rim plane (Z=0 in world) and aligning. Heavier implementation.
  2. Once pose_kinect.json exists alongside pose_{valentine, sophia, javier}.json, this
     script can sample depth points, convert to world 3D via the Kinect pose, and reproject
     into each phone. Residuals quantify how wrong each phone's pose is.

Usage (once the prerequisite is met):
  python3 scripts/kinect_crosscheck.py
  python3 scripts/kinect_crosscheck.py --n-samples 200
"""
import sys, json, argparse
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pose_utils import load_pose, world_to_pixel

REPO = Path(__file__).resolve().parent.parent
KINECT_INTRINSICS_PATH = REPO / "calib" / "kinect_intrinsics.json"
KINECT_MKV_PATH = REPO / "videos" / "depth_20260311_105209.mkv"
KINECT_DEPTH_STATS_PATH = REPO / "calib" / "kinect_depth_stats_t32p4.json"


def load_kinect_pose():
    path = REPO / "calib" / "pose_kinect.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


def kinect_depth_to_world(depth_pixel_uv, depth_mm, kinect_pose, kinect_intr):
    """Convert a Kinect depth-pixel + depth value into a world-frame 3D point.

    Uses the DEPTH camera intrinsics (not the color-camera intrinsics) to unproject.
    Requires kinect_pose to define the mapping from the Kinect camera frame to the world
    frame (X_world = R_kc.T @ (X_cam - t_kc)).
    """
    u, v = depth_pixel_uv
    # Depth camera intrinsics
    depth_intr = kinect_intr["calibration_CameraPurposeDepth"]
    fx = depth_intr["fx_px"]; fy = depth_intr["fy_px"]
    cx = depth_intr["cx_px"]; cy = depth_intr["cy_px"]
    # Unproject in depth camera frame
    Z_cam = float(depth_mm)
    X_cam = (u - cx) * Z_cam / fx
    Y_cam = (v - cy) * Z_cam / fy
    p_cam = np.array([X_cam, Y_cam, Z_cam])
    # Transform to world: X_world = R_kc.T @ (p_cam - t_kc)
    R_kc = np.asarray(kinect_pose["R"], float)
    t_kc = np.asarray(kinect_pose["t_mm"], float)
    X_world = R_kc.T @ (p_cam - t_kc)
    return X_world


def sample_depth_frame(mkv_path, n_samples=100, timestamp_s=32.4):
    """Pull a depth frame from the Kinect MKV at the given timestamp.
    Returns list of (u_depth, v_depth, depth_mm) sampled uniformly across valid pixels.
    Requires pyav or ffmpeg-python for raw-video depth track extraction.
    """
    try:
        import av  # type: ignore
    except ImportError:
        raise RuntimeError("pyav not installed — try: pip install av")
    # Depth track is index 1 in the K4A MKV (per probe summary)
    container = av.open(str(mkv_path))
    depth_stream = None
    for s in container.streams:
        if s.type == "video" and "DEPTH" in (s.metadata.get("title") or "").upper():
            depth_stream = s
            break
    if depth_stream is None:
        # Fallback: stream 1
        depth_stream = container.streams.video[1]
    # Seek to timestamp
    container.seek(int(timestamp_s * av.time_base))
    for frame in container.decode(depth_stream):
        if frame.time and frame.time >= timestamp_s:
            arr = np.frombuffer(frame.planes[0], dtype=np.uint16).reshape(frame.height, frame.width)
            container.close()
            # Sample valid pixels (depth > 0)
            valid_mask = arr > 0
            ys, xs = np.where(valid_mask)
            if len(ys) == 0:
                return []
            idx = np.random.choice(len(ys), min(n_samples, len(ys)), replace=False)
            samples = [(int(xs[i]), int(ys[i]), float(arr[ys[i], xs[i]])) for i in idx]
            return samples
    container.close()
    return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-samples", type=int, default=100)
    ap.add_argument("--timestamp-s", type=float, default=32.4, help="depth frame at this time (clack+5s per probe)")
    args = ap.parse_args()

    kinect_pose = load_kinect_pose()
    if kinect_pose is None:
        print("="*70)
        print("BLOCKED: Kinect pose not yet solved.")
        print("="*70)
        print("""
The Kinect cross-check needs calib/pose_kinect.json in the same world frame used by the
phones. That file does not yet exist.

To produce it:
  1. Extract a Kinect COLOR frame from videos/depth_20260311_105209.mkv that shows the flume
     rim (the current calib/reference_frames/kinect_color.jpg is pure sediment — overwrite it
     with a better frame, e.g. near t=0 before sediment filled the bed):
        ffmpeg -i videos/depth_20260311_105209.mkv -map 0:0 -ss 0 -frames:v 1 \\
          calib/reference_frames/kinect_color.jpg
  2. Open calib/pose_tune.html, select the "Kinect" view, tune yaw/pitch/roll/C so the flume
     wireframe aligns with the frame. Since the Kinect is overhead and nearly top-down,
     defaults should be close to Cx=419, Cy=965, Cz=~800, yaw=0, pitch=-89.
  3. Copy the exported pose JSON to calib/pose_kinect.json.

Once that exists, re-run this script to produce the phone-vs-Kinect cross-check residuals.
""")
        # Also dump Kinect intrinsics summary so user can confirm they're loaded
        if KINECT_INTRINSICS_PATH.exists():
            kintr = json.loads(KINECT_INTRINSICS_PATH.read_text())
            print("Kinect intrinsics available at calib/kinect_intrinsics.json:")
            for k, v in kintr.items():
                if isinstance(v, dict) and "fx_px" in v:
                    print(f"  {k}: fx={v['fx_px']:.1f}, resolution {v.get('width','?')}×{v.get('height','?')}")
        return

    # ---- kinect_pose exists; run the actual cross-check ----
    kinect_intr = json.loads(KINECT_INTRINSICS_PATH.read_text())
    print(f"Kinect pose loaded: C = {kinect_pose['camera_center_world_mm']}")

    phone_poses = {}
    for label in ["valentine", "sophia", "javier"]:
        try:
            p = load_pose(label)
            p["label"] = label
            phone_poses[label] = p
        except FileNotFoundError:
            print(f"  ⚠ no pose for {label}")

    print(f"Sampling {args.n_samples} depth points from Kinect MKV at t={args.timestamp_s}s…")
    try:
        samples = sample_depth_frame(KINECT_MKV_PATH, args.n_samples, args.timestamp_s)
    except Exception as e:
        print(f"  ERROR pulling depth frame: {e}")
        return
    print(f"  got {len(samples)} valid depth samples")

    # Convert each to world + project into each phone
    residuals = {label: [] for label in phone_poses}
    for (u_d, v_d, depth_mm) in samples:
        X_world = kinect_depth_to_world((u_d, v_d), depth_mm, kinect_pose, kinect_intr)
        for label, pose in phone_poses.items():
            p = world_to_pixel(pose, X_world)
            if p is not None:
                residuals[label].append((X_world.tolist(), p.tolist()))

    print("\nResults (summary):")
    for label, rs in residuals.items():
        print(f"  {label}: {len(rs)} Kinect points projected in front of camera")
        # Would compare against phone video pixels at same timestamp here.
        # (See note in readme — needs to open phone video at matched timestamp and compare.)


if __name__ == "__main__":
    main()
