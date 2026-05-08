#!/usr/bin/env python3
"""
extract_depth.py — Extract depth frames from the RealSense MKV recording.

The MKV has 3 streams:
  Stream 0: 1920x1080 MJPEG (RGB camera)
  Stream 1: 640x576 raw 16-bit b16g (depth)
  Stream 2: 640x576 raw 16-bit b16g (infrared/confidence)

This script extracts key frames from streams 0 and 1,
saving RGB as JPEGs and depth as 16-bit PNGs + a numpy archive.
"""

import json
import os
import struct
import subprocess
import sys

import numpy as np

VIDEOS_DIR = os.path.join(os.path.dirname(__file__), '..', 'videos')
DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'depth')
MKV_FILE = 'depth_20260311_105209.mkv'

# Extract one frame every N seconds
FRAME_INTERVAL_S = 5
# Max frames to extract
MAX_FRAMES = 50


def extract_rgb_frames(mkv_path, out_dir, interval_s, max_frames):
    """Extract RGB key frames from stream 0."""
    rgb_dir = os.path.join(out_dir, 'rgb')
    os.makedirs(rgb_dir, exist_ok=True)

    cmd = [
        'ffmpeg', '-y', '-i', mkv_path,
        '-map', '0:0',  # Stream 0 (RGB)
        '-vf', f'fps=1/{interval_s}',
        '-frames:v', str(max_frames),
        '-q:v', '2',
        os.path.join(rgb_dir, 'frame_%04d.jpg')
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f'  RGB extraction error: {result.stderr[:300]}')
        return 0

    frames = sorted([f for f in os.listdir(rgb_dir) if f.endswith('.jpg')])
    return len(frames)


def extract_depth_frames(mkv_path, out_dir, interval_s, max_frames):
    """
    Extract raw depth frames from stream 1.

    The depth stream is 640x576 raw 16-bit little-endian grayscale (b16g).
    We extract raw frames, then parse the 16-bit data into numpy arrays
    and save as 16-bit PNGs.
    """
    depth_dir = os.path.join(out_dir, 'frames')
    os.makedirs(depth_dir, exist_ok=True)

    # Get duration
    probe_cmd = [
        'ffprobe', '-v', 'error',
        '-select_streams', 'v:1',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        mkv_path
    ]
    result = subprocess.run(probe_cmd, capture_output=True, text=True)
    duration = float(result.stdout.strip()) if result.stdout.strip() else 240.0

    W, H = 640, 576
    frame_size = W * H * 2  # 16-bit = 2 bytes per pixel

    depths_all = []
    global_min = float('inf')
    global_max = 0
    frame_count = 0

    for i in range(min(max_frames, int(duration / interval_s))):
        t = i * interval_s
        print(f'  Extracting depth frame {i+1} at t={t}s...')

        # Extract single raw frame at time t
        cmd = [
            'ffmpeg', '-y',
            '-ss', str(t),
            '-i', mkv_path,
            '-map', '0:1',  # Stream 1 (depth)
            '-frames:v', '1',
            '-f', 'rawvideo',
            '-pix_fmt', 'gray16le',
            'pipe:1'
        ]
        result = subprocess.run(cmd, capture_output=True)

        if result.returncode != 0 or len(result.stdout) < frame_size:
            print(f'    Skipped (got {len(result.stdout)} bytes, need {frame_size})')
            continue

        # Parse raw 16-bit data
        raw = result.stdout[:frame_size]
        depth = np.frombuffer(raw, dtype=np.uint16).reshape(H, W)

        # Track stats (ignore zero = no reading)
        valid = depth[depth > 0]
        if len(valid) > 0:
            global_min = min(global_min, int(valid.min()))
            global_max = max(global_max, int(valid.max()))

        # Save as 16-bit PNG
        try:
            from PIL import Image
            img = Image.fromarray(depth, mode='I;16')
            img.save(os.path.join(depth_dir, f'depth_{i:04d}.png'))
        except ImportError:
            # Fallback: save as numpy
            np.save(os.path.join(depth_dir, f'depth_{i:04d}.npy'), depth)

        depths_all.append({
            'index': i,
            'time_s': t,
            'min_depth': int(valid.min()) if len(valid) > 0 else 0,
            'max_depth': int(valid.max()) if len(valid) > 0 else 0,
            'valid_pixels': int(len(valid)),
        })
        frame_count += 1

    return frame_count, depths_all, global_min, global_max


def main():
    mkv_path = os.path.join(VIDEOS_DIR, MKV_FILE)
    if not os.path.exists(mkv_path):
        print(f'MKV not found: {mkv_path}')
        sys.exit(1)

    os.makedirs(DATA_DIR, exist_ok=True)

    print('Extracting RGB reference frames...')
    n_rgb = extract_rgb_frames(mkv_path, DATA_DIR, FRAME_INTERVAL_S, MAX_FRAMES)
    print(f'  {n_rgb} RGB frames extracted')

    print('\nExtracting depth frames...')
    n_depth, frame_info, d_min, d_max = extract_depth_frames(
        mkv_path, DATA_DIR, FRAME_INTERVAL_S, MAX_FRAMES
    )
    print(f'  {n_depth} depth frames extracted')
    print(f'  Depth range: {d_min} – {d_max} (raw 16-bit units)')

    # Write metadata
    meta = {
        'source': MKV_FILE,
        'rgb_resolution': [1920, 1080],
        'depth_resolution': [640, 576],
        'frame_interval_s': FRAME_INTERVAL_S,
        'n_rgb_frames': n_rgb,
        'n_depth_frames': n_depth,
        'depth_range': {'min': d_min if d_min != float('inf') else 0, 'max': d_max},
        'frames': frame_info,
    }

    meta_path = os.path.join(DATA_DIR, 'depth_meta.json')
    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=2)

    print(f'\nMetadata written to {meta_path}')


if __name__ == '__main__':
    main()
