#!/usr/bin/env python3
"""detect_clack.py — Stage 2 clack detection.

- Audio-based Hilbert-envelope onset detection on the 4 phone videos.
- Manual timestamp for the Kinect MKV (no audio track).
- Writes sync/offsets.json plus per-file visualization plots.
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy.io import wavfile
from scipy.signal import hilbert

ROOT = Path(__file__).resolve().parent.parent
VIDEOS_DIR = ROOT / "videos"
SYNC_DIR = ROOT / "sync"
SYNC_DIR.mkdir(exist_ok=True)

# Audio detection is retained for future files but currently unused —
# all four phone videos were re-checked and the audio detector locked onto
# transients that weren't the actual clack, so every entry is now manual.
AUDIO_FILES = []

# Manual clack times (user-identified by flipping through frame samples).
# javier deliberately excluded: his recording does not capture the clack.
MANUAL = {
    "AM_03-11_01_wide-inlet_no-obstacles.mp4": {
        "label": "anna",
        "clack_timestamp_seconds": 0.800,
        "method": "manual",
        "confidence": "high",
        "notes": "user-identified pipe contact at t=0.800s (100ms frame sampling)",
    },
    "skm_0311_01_wide_no-obs.mp4": {
        "label": "sophia",
        "clack_timestamp_seconds": 1.500,
        "method": "manual",
        "confidence": "high",
        "notes": "user-identified pipe contact at t=1.500s (100ms frame sampling)",
    },
    "vmg_03-11_01.mp4": {
        "label": "valentine",
        "clack_timestamp_seconds": 23.333,
        "method": "manual",
        "confidence": "high",
        "notes": "user-identified pipe contact at t=23.333s (frame-level 33ms sampling)",
    },
    "depth_20260311_105209.mkv": {
        "label": "kinect",
        "clack_timestamp_seconds": 27.400,
        "method": "manual",
        "confidence": "high",
        "notes": "user-identified pipe contact on Kinect COLOR at t=27.400s; no audio track in MKV",
        "map_stream": "0:0",  # ffmpeg stream specifier for the COLOR track
    },
}

SEARCH_WINDOW_S = 30  # per spec: "first transient in the first 30 seconds"
THRESHOLD_SIGMAS = 4  # per spec: "> 4σ above the rolling median"


def extract_audio(video_path, wav_path):
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", str(video_path),
            "-vn", "-ac", "1", "-ar", "48000", "-sample_fmt", "s16",
            str(wav_path),
        ],
        check=True, capture_output=True,
    )


def detect_audio_clack(wav_path, search_window_s=SEARCH_WINDOW_S):
    sr, data = wavfile.read(wav_path)
    if data.ndim > 1:
        data = data[:, 0]
    n = min(len(data), int(sr * search_window_s))
    audio = data[:n].astype(np.float64)
    peak = np.max(np.abs(audio))
    if peak == 0:
        return None
    audio /= peak

    env = np.abs(hilbert(audio))
    k = max(1, int(sr * 0.001))
    env = np.convolve(env, np.ones(k) / k, mode="same")

    onset = np.diff(env)
    onset = np.maximum(onset, 0)
    ok = max(1, int(sr * 0.005))
    onset = np.convolve(onset, np.ones(ok) / ok, mode="same")

    # Robust baseline: global median + MAD-derived sigma.
    median_onset = float(np.median(onset))
    mad = float(np.median(np.abs(onset - median_onset)))
    sigma = 1.4826 * mad  # MAD → σ for Gaussian noise

    # Threshold high enough to exclude mic-handling ticks at recording start.
    # The true clack is a percussive outlier — empirically 20-35× the baseline.
    # We take the *first* onset peak that crosses this strict threshold, so multiple
    # clacks still resolve to the earliest one.
    THRESHOLD_X = 15  # multiple of (median + 4σ baseline)
    threshold = (median_onset + THRESHOLD_SIGMAS * sigma) * THRESHOLD_X

    # Find contiguous runs above threshold and pick the first run's local max.
    above = onset > threshold
    method = "first_peak"
    if not np.any(above):
        # Nothing distinctly loud — fall back to argmax within the window.
        clack_sample = int(np.argmax(onset))
        method = "argmax_fallback"
    else:
        # Identify the start of the first contiguous run above threshold.
        transitions = np.diff(above.astype(np.int8))
        starts = np.where(transitions == 1)[0] + 1
        if above[0]:
            starts = np.insert(starts, 0, 0)
        first_run_start = int(starts[0])
        # Walk to the end of that run, then pick its argmax.
        j = first_run_start
        while j + 1 < len(onset) and above[j + 1]:
            j += 1
        clack_sample = first_run_start + int(np.argmax(onset[first_run_start:j + 1]))

    clack_time = clack_sample / sr
    peak_onset = float(onset[clack_sample])
    ratio = peak_onset / (median_onset + 1e-12)

    if ratio >= 20:
        conf = "high"
    elif ratio >= 10:
        conf = "medium"
    else:
        conf = "low"

    return {
        "clack_timestamp_seconds": round(float(clack_time), 4),
        "ratio": round(float(ratio), 1),
        "threshold": float(threshold),
        "sigma": float(sigma),
        "confidence": conf,
        "detector": method,
        "sample_rate": sr,
        "env_t": np.arange(len(env)) / sr,
        "env": env,
        "onset_t": np.arange(len(onset)) / sr,
        "onset": onset,
    }


def save_audio_plot(label, filename, result, out_path):
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(10, 5), sharex=True)
    clack = result["clack_timestamp_seconds"]

    ax1.plot(result["env_t"], result["env"], lw=0.5, color="#3c78b4")
    ax1.axvline(clack, color="#c05030", lw=1.2, label=f"clack @ {clack:.4f}s")
    ax1.set_ylabel("envelope")
    ax1.set_title(
        f'{label}  —  {filename}    '
        f'confidence: {result["confidence"]}    '
        f'peak/median onset = {result["ratio"]}x'
    )
    ax1.legend(loc="upper right")
    ax1.set_xlim(0, min(result["env_t"][-1], SEARCH_WINDOW_S))

    ax2.plot(result["onset_t"], result["onset"], lw=0.5, color="#7a7a7a")
    ax2.axvline(clack, color="#c05030", lw=1.2)
    ax2.set_ylabel("onset (d envelope / dt)")
    ax2.set_xlabel("time (s)")

    plt.tight_layout()
    fig.savefig(out_path, dpi=90)
    plt.close(fig)


def extract_frame_jpg(video_path, time_s, out_path, map_stream=None):
    cmd = ["ffmpeg", "-y", "-loglevel", "error",
           "-ss", f"{time_s}", "-i", str(video_path)]
    if map_stream:
        cmd += ["-map", map_stream]
    cmd += ["-frames:v", "1", "-q:v", "3", str(out_path)]
    subprocess.run(cmd, check=True, capture_output=True)


def save_visual_triptych(filename, clack_time, out_path, map_stream=None):
    video_path = VIDEOS_DIR / filename
    times = [max(0.0, clack_time - 0.2), clack_time, clack_time + 0.2]
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        paths = []
        for i, t in enumerate(times):
            p = td / f"f{i}.jpg"
            extract_frame_jpg(video_path, t, p, map_stream)
            paths.append(p)

        fig, axes = plt.subplots(1, 3, figsize=(12, 4.5))
        labels = [
            f"t = {times[0]:.3f}s  (before)",
            f"t = {times[1]:.3f}s  (clack)",
            f"t = {times[2]:.3f}s  (after)",
        ]
        for ax, p, label in zip(axes, paths, labels):
            ax.imshow(plt.imread(p))
            ax.set_title(label, fontsize=10)
            ax.axis("off")
        fig.suptitle(f"{filename} — manual clack localization", fontsize=11)
        plt.tight_layout()
        fig.savefig(out_path, dpi=90)
        plt.close(fig)


def main():
    entries = []

    # Audio path
    for filename, label in AUDIO_FILES:
        video_path = VIDEOS_DIR / filename
        if not video_path.exists():
            print(f"SKIP: {video_path} not found")
            continue

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            wav_path = tmp.name
        try:
            extract_audio(video_path, wav_path)
            res = detect_audio_clack(wav_path)
            if res is None:
                print(f"{label}: audio detection FAILED (silent stream?)")
                continue

            plot_path = SYNC_DIR / f"audio_{filename}.png"
            save_audio_plot(label, filename, res, plot_path)

            print(
                f'{label:>10}  clack = {res["clack_timestamp_seconds"]:.4f}s  '
                f'confidence = {res["confidence"]}  (ratio {res["ratio"]}x)'
            )
            entries.append({
                "filename": filename,
                "label": label,
                "method": "audio",
                "clack_timestamp_seconds": res["clack_timestamp_seconds"],
                "confidence": res["confidence"],
                "notes": (
                    f'Hilbert envelope onset; first crossing of median + '
                    f'{THRESHOLD_SIGMAS}σ in first {SEARCH_WINDOW_S}s; '
                    f'peak/median = {res["ratio"]}x; detector={res["detector"]}'
                ),
            })
        finally:
            os.unlink(wav_path)

    # Manual path (Kinect)
    for filename, m in MANUAL.items():
        video_path = VIDEOS_DIR / filename
        if not video_path.exists():
            print(f"SKIP (manual): {video_path} not found")
            continue

        plot_path = SYNC_DIR / f"visual_{filename}.png"
        save_visual_triptych(filename, m["clack_timestamp_seconds"], plot_path, m.get("map_stream"))

        print(
            f'{m["label"]:>10}  clack = {m["clack_timestamp_seconds"]:.4f}s  '
            f'confidence = {m["confidence"]}  (method: {m["method"]})'
        )
        entries.append({
            "filename": filename,
            "label": m["label"],
            "method": m["method"],
            "clack_timestamp_seconds": m["clack_timestamp_seconds"],
            "confidence": m["confidence"],
            "notes": m["notes"],
        })

    # Reference = earliest clack (smallest wall offset from video start)
    ref = min(entries, key=lambda e: e["clack_timestamp_seconds"])["label"] if entries else None
    out = {
        "entries": entries,
        "reference_label": ref,
        "method_summary": {
            "audio": sum(1 for e in entries if e["method"] == "audio"),
            "visual": sum(1 for e in entries if e["method"] == "visual"),
            "manual": sum(1 for e in entries if e["method"] == "manual"),
        },
    }
    out_path = SYNC_DIR / "offsets.json"
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)

    print(f"\nWritten {out_path}")
    print(f"Reference (earliest clack): {ref}")


if __name__ == "__main__":
    main()
