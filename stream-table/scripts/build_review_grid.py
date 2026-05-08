#!/usr/bin/env python3
"""build_review_grid.py — Assemble the Stage-2 5-up review grid.

Reads sync/offsets.json. For each entry, seeks to its clack timestamp and
takes 10 seconds after. Horizontally stacks all five at a common height.
Output: sync/review_grid.mp4

Pre-seek with input-side -ss (fast, keyframe-aligned), then fine-trim
with output-side -ss 2 so the result is frame-accurate at the clack.
"""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIDEOS_DIR = ROOT / "videos"
SYNC_DIR = ROOT / "sync"
OUT = SYNC_DIR / "review_grid.mp4"
DURATION_S = 10.0
TILE_HEIGHT = 480

PRESEEK_PAD_S = 2.0  # seek to (clack - 2.0) fast, then fine-trim forward by 2.0

# Stream specifier per file. Kinect MKV has multiple video tracks; must pick COLOR (index 0).
STREAM_SPEC = {
    "depth_20260311_105209.mkv": "0:0",
}


def main():
    with open(SYNC_DIR / "offsets.json") as f:
        offsets = json.load(f)
    entries = offsets["entries"]

    # Deterministic left-to-right order. Javier omitted: his video does not
    # capture the clack, so it cannot participate in the sync grid.
    order = ["anna", "sophia", "valentine", "kinect"]
    by_label = {e["label"]: e for e in entries}
    ordered = [by_label[l] for l in order if l in by_label]

    cmd = ["ffmpeg", "-y", "-hide_banner"]

    # Input section
    for e in ordered:
        clack = e["clack_timestamp_seconds"]
        pre = max(0.0, clack - PRESEEK_PAD_S)
        cmd += ["-ss", f"{pre:.4f}", "-i", str(VIDEOS_DIR / e["filename"])]

    # Per-input filter chain
    filters = []
    labels_out = []
    for i, e in enumerate(ordered):
        spec = STREAM_SPEC.get(e["filename"], f"{i}:v")
        # If the file defines an explicit stream spec, it's already prefixed with its input index.
        if e["filename"] in STREAM_SPEC:
            spec = f"{i}:{STREAM_SPEC[e['filename']].split(':')[1]}"

        fine = e["clack_timestamp_seconds"] - max(0.0, e["clack_timestamp_seconds"] - PRESEEK_PAD_S)
        label = f"v{i}"
        labels_out.append(label)
        filters.append(
            f"[{spec}]"
            f"trim=start={fine:.4f}:duration={DURATION_S:.4f},"
            f"setpts=PTS-STARTPTS,"
            f"scale=-2:{TILE_HEIGHT}:flags=bicubic,"
            f"setsar=1,"
            f"drawtext=text='{e['label']} t+%{{pts\\:hms}}':"
            f"x=10:y=10:fontcolor=white:fontsize=18:"
            f"box=1:boxcolor=black@0.55:boxborderw=6"
            f"[{label}]"
        )

    # Stack
    stack_inputs = "".join(f"[{l}]" for l in labels_out)
    filters.append(f"{stack_inputs}hstack=inputs={len(labels_out)}[out]")

    filter_complex = ";".join(filters)
    cmd += ["-filter_complex", filter_complex]
    cmd += ["-map", "[out]"]
    cmd += [
        "-c:v", "libx264",
        "-crf", "23",
        "-preset", "fast",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(OUT),
    ]

    print("Running ffmpeg...")
    print("Output:", OUT)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("FFMPEG STDERR:")
        print(result.stderr[-4000:])
        raise SystemExit(result.returncode)
    print("Done.")
    print(f"  {OUT}  ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
