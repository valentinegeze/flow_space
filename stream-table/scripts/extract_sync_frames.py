"""Extract synchronised mid-flow frames from each phone video.

Uses data/sync.json clack times to align frames so the same physical moment is captured
in valentine and sophia. For javier (no clack sync), picks an absolute video time that
should fall within the flow period.

Output: calib/reference_frames/<label>_flow.jpg  (1080×1920 each)

Usage:
  python3 scripts/extract_sync_frames.py                 # default: clack + 20 s
  python3 scripts/extract_sync_frames.py --post-clack 45 # clack + 45 s
"""
import cv2, json, argparse
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

VIDEO_FILES = {
    "anna":      "videos/AM_03-11_01_wide-inlet_no-obstacles.mp4",
    "sophia":    "videos/skm_0311_01_wide_no-obs.mp4",
    "javier":    "videos/20260311_Linear Outlet_No Artifacts.mp4",
    "valentine": "videos/vmg_03-11_01.mp4",
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--post-clack", type=float, default=20.0,
                    help="seconds after the clack to extract (default 20)")
    ap.add_argument("--javier-time", type=float, default=180.0,
                    help="absolute time (s) into javier's video (no clack sync). t=180 matches valentine/sophia clack+30s visually.")
    ap.add_argument("--suffix", default="_flow",
                    help="output filename suffix, e.g. _flow → javier_flow.jpg")
    args = ap.parse_args()

    sync = json.loads((REPO / "data" / "sync.json").read_text())
    results = {}
    for label in ["valentine", "sophia", "javier"]:
        vid = REPO / VIDEO_FILES[label]
        if label == "javier":
            t = args.javier_time
            note = f"absolute t={t:.1f}s (no clack sync available)"
        else:
            clack = sync["videos"][label]["clap_time_s"]
            t = clack + args.post_clack
            note = f"clack+{args.post_clack:.1f}s (clack at t={clack:.2f}s)"
        cap = cv2.VideoCapture(str(vid))
        fps = cap.get(cv2.CAP_PROP_FPS)
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(t * fps)))
        ret, frame = cap.read()
        cap.release()
        if not ret:
            print(f"  [{label}] FAILED to read frame at t={t:.1f}s")
            continue
        out = REPO / "calib" / "reference_frames" / f"{label}{args.suffix}.jpg"
        cv2.imwrite(str(out), frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
        results[label] = {"t_seconds": t, "note": note, "file": str(out.relative_to(REPO))}
        print(f"  [{label}] {note} → {out.relative_to(REPO)}  ({frame.shape[1]}×{frame.shape[0]})")
    return results

if __name__ == "__main__":
    main()
