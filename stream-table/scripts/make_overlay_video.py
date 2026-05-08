"""Generate a video with the flume wireframe overlaid on a phone's recording.

Usage:
  python3 scripts/make_overlay_video.py valentine             # full video at 1 fps preview
  python3 scripts/make_overlay_video.py valentine --every-n 1 # full framerate (slow)
  python3 scripts/make_overlay_video.py valentine --duration 30  # first 30 seconds only
  python3 scripts/make_overlay_video.py --all                 # all 3 solved phones
"""
import cv2
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pose_utils import load_pose, draw_wireframe

REPO = Path(__file__).resolve().parent.parent

VIDEO_FILES = {
    "anna":      "videos/AM_03-11_01_wide-inlet_no-obstacles.mp4",
    "sophia":    "videos/skm_0311_01_wide_no-obs.mp4",
    "javier":    "videos/20260311_Linear Outlet_No Artifacts.mp4",
    "valentine": "videos/vmg_03-11_01.mp4",
}

# Per-phone post-draw rotation for correct display orientation.
# javier was recorded landscape but stored portrait; rotating 90° CCW on output
# gives the correct human-viewable orientation. Wireframe is drawn in the stored-
# frame pose, so the whole composite rotates together.
ROTATE_CCW_DEG = {
    "javier": 90,  # landscape-in-portrait-container; rotated 90° CCW for correct display
    "anna": 180,   # captured upside down
    "kinect": 270, # captured landscape; rotated 90° CW (= 270° CCW) to match orientation
}


def make_overlay(label, every_n=30, duration_s=None, out_label=None):
    pose = load_pose(label)
    video_path = REPO / VIDEO_FILES[label]
    out_name = f"overlay_{label}.mp4" if out_label is None else f"overlay_{out_label}.mp4"
    out_path = REPO / "calib" / out_name

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Can't open {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS)
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    n_total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    max_frames = n_total if duration_s is None else min(n_total, int(duration_s * fps))

    rotate = ROTATE_CCW_DEG.get(label, 0)
    if rotate in (90, 270):
        out_W, out_H = H, W  # swap on 90/270 rotation
    else:
        out_W, out_H = W, H

    out_fps = max(1.0, fps / every_n)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(out_path), fourcc, out_fps, (out_W, out_H))

    print(f"[{label}] src {W}×{H} @ {fps:.2f} fps, {n_total} frames "
          f"({n_total/fps:.1f} s) → sampling every {every_n} → out @ {out_fps:.2f} fps")

    frame_idx = 0
    written = 0
    while frame_idx < max_frames:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % every_n == 0:
            draw_wireframe(frame, pose, thickness=3, dot_radius=6)
            # Rotate for viewing if configured (wireframe rotates with frame)
            if rotate == 90:
                frame = cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
            elif rotate == 180:
                frame = cv2.rotate(frame, cv2.ROTATE_180)
            elif rotate == 270:
                frame = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
            # Add header on the ROTATED frame so it's upright for viewing
            hdr = f"{label}  fps={out_fps:.1f}  t={frame_idx/fps:.1f}s  frame={frame_idx}"
            cv2.rectangle(frame, (0, 0), (out_W, 36), (0, 0, 0), -1)
            cv2.putText(frame, hdr, (12, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                        (255, 255, 255), 2, cv2.LINE_AA)
            writer.write(frame)
            written += 1
        frame_idx += 1

    cap.release()
    writer.release()
    size_mb = out_path.stat().st_size / 1e6
    print(f"[{label}] wrote {written} frames, {size_mb:.1f} MB → {out_path.relative_to(REPO)}")
    return out_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("label", nargs="?", help="phone label (anna/sophia/valentine/javier)")
    ap.add_argument("--all", action="store_true", help="process all 3 solved phones (sophia/valentine/javier)")
    ap.add_argument("--every-n", type=int, default=30, help="sample every N source frames")
    ap.add_argument("--duration", type=float, default=None, help="limit to first N seconds")
    args = ap.parse_args()

    if args.all:
        for label in ["valentine", "sophia", "javier"]:
            try:
                make_overlay(label, args.every_n, args.duration)
            except Exception as e:
                print(f"[{label}] FAILED: {e}")
    else:
        if not args.label:
            ap.error("provide a label or use --all")
        make_overlay(args.label, args.every_n, args.duration)


if __name__ == "__main__":
    main()
