"""Sediment-transport analysis via Kinect depth differencing.

At two timestamps, extract the Kinect depth frame. Bed elevation change per pixel =
(depth_before - depth_after), in mm:
  - positive = bed dropped (scour/erosion)
  - negative = bed rose (deposition)
  - zero = no change

Outputs:
  - colorised PNG diff map (red = scour, blue = deposition), optionally overlaid on color
  - CSV of per-pixel change
  - overall volume statistics (total volume moved, max erosion depth, max deposition height,
    etc.)

Usage:
  python3 scripts/bed_change_analysis.py                        # T0=27.4 (clack), T1=87.4 (+60s)
  python3 scripts/bed_change_analysis.py --t0 27.4 --t1 147.4  # 2-minute interval
  python3 scripts/bed_change_analysis.py --overlay              # overlay on color frame
"""
import subprocess, argparse
from pathlib import Path
import numpy as np
import cv2

REPO = Path(__file__).resolve().parent.parent
MKV = REPO / "videos" / "depth_20260311_105209.mkv"

DEPTH_W, DEPTH_H = 640, 576
DEPTH_FX = 505.0
DEPTH_FY = 505.2
DEPTH_CX = 306.3
DEPTH_CY = 297.2


def extract_depth(t_seconds, out_raw):
    cmd = [
        "ffmpeg", "-y", "-ss", f"{t_seconds}", "-i", str(MKV),
        "-map", "0:1", "-frames:v", "1",
        "-c:v", "rawvideo", "-pix_fmt", "gray16le",
        "-f", "rawvideo", str(out_raw),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg depth extract failed at t={t_seconds}: {r.stderr[-300:]}")
    return np.fromfile(out_raw, dtype=np.uint16).reshape(DEPTH_H, DEPTH_W)


def extract_color(t_seconds, out_jpg):
    cmd = [
        "ffmpeg", "-y", "-ss", f"{t_seconds}", "-i", str(MKV),
        "-map", "0:0", "-frames:v", "1", str(out_jpg),
    ]
    subprocess.run(cmd, capture_output=True, text=True)
    return cv2.imread(str(out_jpg))


def pixel_area_at_depth_mm2(depth_mm):
    """Approximate world-frame area covered by one depth pixel, as a function of depth.
    Each pixel subtends 1/fx radians horizontally, 1/fy vertically. At distance d, the
    pixel footprint = (d/fx) × (d/fy) mm²."""
    return (depth_mm / DEPTH_FX) * (depth_mm / DEPTH_FY)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--t0", type=float, default=27.4, help="'before' timestamp in Kinect MKV (sec). Default: clack time.")
    ap.add_argument("--t1", type=float, default=87.4, help="'after' timestamp. Default: clack + 60s.")
    ap.add_argument("--overlay", action="store_true", help="overlay change map on color frame")
    ap.add_argument("--max-abs-mm", type=float, default=50.0,
                    help="colorscale clamp (mm); changes beyond this look saturated")
    ap.add_argument("--bed-min-mm", type=float, default=650.0,
                    help="minimum depth (mm) to count as bed; filter out closer intrusions (cross-bar, hands)")
    ap.add_argument("--bed-max-mm", type=float, default=900.0,
                    help="maximum depth to count as bed; filter out deep holes beyond flume")
    args = ap.parse_args()

    dt = args.t1 - args.t0
    print(f"Interval: t0={args.t0:.1f}s → t1={args.t1:.1f}s  (Δt = {dt:.1f} s)")

    d0 = extract_depth(args.t0, Path("/tmp/d0.raw")).astype(np.float32)
    d1 = extract_depth(args.t1, Path("/tmp/d1.raw")).astype(np.float32)
    valid = (d0 > 0) & (d1 > 0)
    # Bed-depth mask: both depths must fall within the expected bed range to count.
    # Excludes cross-bar, hands, tools that are closer to the Kinect than the sediment.
    valid = valid & (d0 >= args.bed_min_mm) & (d0 <= args.bed_max_mm)
    valid = valid & (d1 >= args.bed_min_mm) & (d1 <= args.bed_max_mm)
    print(f"  valid bed pixels at both t0 & t1 ({args.bed_min_mm:.0f}-{args.bed_max_mm:.0f} mm range): {valid.sum()} / {d0.size} ({100*valid.sum()/d0.size:.1f}%)")

    # Δdepth: positive = depth increased (bed went further from Kinect = lower bed)
    diff_mm = np.zeros_like(d0)
    diff_mm[valid] = d1[valid] - d0[valid]  # mm change (+ = scour, - = deposition)
    rate_mm_s = diff_mm / dt  # mm/s

    # Statistics
    print(f"\n  bed change (positive = scour, negative = deposition):")
    print(f"    mean:          {diff_mm[valid].mean():+7.2f} mm    ({rate_mm_s[valid].mean():+.4f} mm/s)")
    print(f"    median:        {np.median(diff_mm[valid]):+7.2f} mm")
    print(f"    max scour:     {diff_mm[valid].max():+7.2f} mm")
    print(f"    max deposit:   {diff_mm[valid].min():+7.2f} mm")
    print(f"    RMS:           {np.sqrt((diff_mm[valid]**2).mean()):+7.2f} mm")

    # Volume accounting. Per pixel area depends on depth.
    depth_avg = (d0 + d1) / 2
    area_mm2 = pixel_area_at_depth_mm2(depth_avg)
    # Volume change per pixel (mm³). positive = material removed, negative = material added.
    vol_mm3 = diff_mm * area_mm2
    scour_vol_mm3 = vol_mm3[valid][vol_mm3[valid] > 0].sum()
    depos_vol_mm3 = -vol_mm3[valid][vol_mm3[valid] < 0].sum()
    net_vol_mm3 = vol_mm3[valid].sum()
    print(f"\n  volumes (approximate):")
    print(f"    total scoured (removed):    {scour_vol_mm3/1e3:10.2f} mL  ({scour_vol_mm3/1e3/dt:+.3f} mL/s)")
    print(f"    total deposited (added):    {depos_vol_mm3/1e3:10.2f} mL  ({depos_vol_mm3/1e3/dt:+.3f} mL/s)")
    print(f"    net (scour - deposition):   {net_vol_mm3/1e3:+10.2f} mL")

    # Visualisation: red = scour, blue = deposition, white = no change, grey = invalid
    vis = np.zeros((DEPTH_H, DEPTH_W, 3), dtype=np.uint8)
    vis[~valid] = (120, 120, 120)  # grey for missing
    M = args.max_abs_mm
    clamped = np.clip(diff_mm / M, -1, 1)
    vis[valid] = 255  # start white
    # Where scour (positive), fade toward red. Where deposition (negative), fade toward blue.
    scour_mask = valid & (diff_mm > 0)
    depos_mask = valid & (diff_mm < 0)
    # Intensity 0-1 scaled by clamped magnitude
    s_int = np.clip(diff_mm / M, 0, 1)
    d_int = np.clip(-diff_mm / M, 0, 1)
    # Red fades white→red: keep R=255, reduce G, B
    vis[..., 1] = np.where(scour_mask, (255 * (1 - s_int)).astype(np.uint8), vis[..., 1])
    vis[..., 0] = np.where(scour_mask, (255 * (1 - s_int)).astype(np.uint8), vis[..., 0])
    # Blue: keep B=255, reduce R, G
    vis[..., 2] = np.where(depos_mask, (255 * (1 - d_int)).astype(np.uint8), vis[..., 2])
    vis[..., 1] = np.where(depos_mask, (255 * (1 - d_int)).astype(np.uint8), vis[..., 1])
    # (cv2 uses BGR, but the structure above is actually (R, G, B) order — fix for cv2 save)
    # Easier: build RGB then swap to BGR at the end
    out = vis[:, :, [2, 1, 0]]  # swap to BGR for OpenCV

    # Colorbar / legend on the image
    legend_h = 40
    stripe = np.zeros((legend_h, DEPTH_W, 3), dtype=np.uint8)
    for x in range(DEPTH_W):
        t = (x / (DEPTH_W - 1)) * 2 - 1  # -1 to +1
        if t >= 0:
            stripe[:, x] = (int(255 * (1 - t)), int(255 * (1 - t)), 255)  # BGR: white → red
        else:
            stripe[:, x] = (255, int(255 * (1 + t)), int(255 * (1 + t)))  # BGR: blue → white
    legend = np.full((legend_h + 24, DEPTH_W, 3), 255, dtype=np.uint8)
    legend[24:, :] = stripe
    cv2.putText(legend, f"-{M:.0f} mm  deposition", (4, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,0,0), 1, cv2.LINE_AA)
    txt = f"+{M:.0f} mm  scour"
    (tw, _), _ = cv2.getTextSize(txt, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
    cv2.putText(legend, txt, (DEPTH_W - tw - 4, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,0,0), 1, cv2.LINE_AA)
    final = np.vstack([out, legend])
    out_path = REPO / "calib" / f"bed_change_t{int(args.t0)}_t{int(args.t1)}.png"
    cv2.imwrite(str(out_path), final, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    size_kb = out_path.stat().st_size / 1024
    print(f"\nSaved {out_path.relative_to(REPO)}  ({size_kb:.0f} KB)")

    # Also save the raw Δdepth map (mm) as 32-bit float for further analysis
    diff_path = REPO / "calib" / f"bed_change_t{int(args.t0)}_t{int(args.t1)}.npy"
    np.save(diff_path, diff_mm.astype(np.float32))
    print(f"Saved raw Δ-depth as {diff_path.relative_to(REPO)} (float32, {DEPTH_H}×{DEPTH_W})")

    # Overlay option: blend change map with color frame (coarse alignment)
    if args.overlay:
        color = extract_color(args.t1, Path("/tmp/kinect_color.jpg"))
        # Scale change map up to color size
        ch_rgb = cv2.resize(out, (color.shape[1], color.shape[0]), interpolation=cv2.INTER_NEAREST)
        blend = cv2.addWeighted(color, 0.55, ch_rgb, 0.45, 0)
        ov_path = REPO / "calib" / f"bed_change_t{int(args.t0)}_t{int(args.t1)}_overlay.jpg"
        cv2.imwrite(str(ov_path), blend, [cv2.IMWRITE_JPEG_QUALITY, 90])
        print(f"Saved overlay {ov_path.relative_to(REPO)}")


if __name__ == "__main__":
    main()
