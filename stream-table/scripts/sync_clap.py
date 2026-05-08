#!/usr/bin/env python3
"""
sync_clap.py — Detect clap sync point across multiple video files.

Extracts audio from each video, finds the sharp transient (clap),
and outputs sync.json with time offsets relative to the earliest clap.
"""

import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from scipy.io import wavfile
from scipy.signal import hilbert

VIDEOS_DIR = os.path.join(os.path.dirname(__file__), '..', 'videos')
DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data')

# Videos to sync (filename → label)
VIDEOS = {
    '20260311_Linear Outlet_No Artifacts.mp4': 'javier',
    'AM_03-11_01_wide-inlet_no-obstacles.mp4': 'anna',
    'skm_0311_01_wide_no-obs.mp4': 'sophia',
    'vmg_03-11_01.mp4': 'valentine',
}


def extract_audio(video_path, wav_path):
    """Extract mono audio as 16-bit WAV using ffmpeg."""
    cmd = [
        'ffmpeg', '-y', '-i', video_path,
        '-vn', '-ac', '1', '-ar', '44100', '-sample_fmt', 's16',
        wav_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f'  ffmpeg error: {result.stderr[:200]}')
        return False
    return True


def detect_clap(wav_path, search_window_s=30):
    """
    Detect the clap transient in the first N seconds of audio.

    Uses envelope detection via the Hilbert transform, then finds
    the sharpest energy spike (highest derivative of the envelope).
    """
    sr, data = wavfile.read(wav_path)

    # Use only the first search_window_s seconds
    n_samples = min(len(data), int(sr * search_window_s))
    audio = data[:n_samples].astype(np.float64)

    # Normalize
    peak = np.max(np.abs(audio))
    if peak == 0:
        return None
    audio /= peak

    # Compute envelope via Hilbert transform
    analytic = hilbert(audio)
    envelope = np.abs(analytic)

    # Smooth envelope slightly (1ms window)
    kernel_size = max(1, int(sr * 0.001))
    envelope_smooth = np.convolve(envelope, np.ones(kernel_size) / kernel_size, mode='same')

    # Compute derivative of envelope (onset detection)
    onset = np.diff(envelope_smooth)
    onset = np.maximum(onset, 0)  # Only positive changes (attacks)

    # Smooth onset function (5ms window)
    onset_kernel = max(1, int(sr * 0.005))
    onset_smooth = np.convolve(onset, np.ones(onset_kernel) / onset_kernel, mode='same')

    # Find the peak onset — this is the clap
    clap_sample = np.argmax(onset_smooth)
    clap_time = clap_sample / sr

    # Confidence: ratio of peak onset to median onset
    median_onset = np.median(onset_smooth)
    peak_onset = onset_smooth[clap_sample]
    confidence = peak_onset / (median_onset + 1e-10)

    return {
        'time_s': round(float(clap_time), 4),
        'confidence': round(float(confidence), 1),
        'sample_rate': sr,
    }


def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    results = {}
    clap_times = {}

    with tempfile.TemporaryDirectory() as tmpdir:
        for filename, label in VIDEOS.items():
            video_path = os.path.join(VIDEOS_DIR, filename)
            if not os.path.exists(video_path):
                print(f'  SKIP: {filename} not found')
                continue

            print(f'  [{label}] Extracting audio from {filename}...')
            wav_path = os.path.join(tmpdir, f'{label}.wav')

            if not extract_audio(video_path, wav_path):
                print(f'  FAILED: could not extract audio')
                continue

            print(f'  [{label}] Detecting clap...')
            result = detect_clap(wav_path)

            if result is None:
                print(f'  FAILED: no clap detected')
                continue

            print(f'  [{label}] Clap at {result["time_s"]}s (confidence: {result["confidence"]}x)')
            results[label] = result
            clap_times[label] = result['time_s']

    if not clap_times:
        print('No claps detected in any video!')
        sys.exit(1)

    # Compute offsets relative to the earliest clap
    earliest = min(clap_times.values())

    sync = {
        'videos': {},
        'reference_label': min(clap_times, key=clap_times.get),
        'method': 'hilbert_envelope_onset',
    }

    for label, clap_time in clap_times.items():
        sync['videos'][label] = {
            'filename': [k for k, v in VIDEOS.items() if v == label][0],
            'clap_time_s': clap_time,
            'offset_s': round(clap_time - earliest, 4),
            'confidence': results[label]['confidence'],
        }

    out_path = os.path.join(DATA_DIR, 'sync.json')
    with open(out_path, 'w') as f:
        json.dump(sync, f, indent=2)

    print(f'\nSync offsets (relative to {sync["reference_label"]}):')
    for label, info in sync['videos'].items():
        print(f'  {label:>10}: +{info["offset_s"]:.4f}s  (clap at {info["clap_time_s"]:.4f}s)')

    print(f'\nWritten to {out_path}')


if __name__ == '__main__':
    main()
