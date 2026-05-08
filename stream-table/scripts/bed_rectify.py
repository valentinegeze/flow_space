"""Rectified, temporally-smoothed bed heightmaps from Kinect depth.

Pipeline:
  1. For each requested timestamp t, extract WINDOW consecutive depth frames at 30 fps
     and take the per-pixel median → clean depth image (drops ~3 mm shot noise).
  2. Use a baseline timestamp (default t=15s, pre-clack, dry bed) to fit the bed plane
     via SVD on the 3D point cloud. Build a rotation R that aligns the plane normal
     with +Z, so the bed lies flat in the rectified frame.
  3. For each timestamp: project depth → 3D, apply R, bin (x,y) into a regular
     top-down grid at GRID_MM resolution, store mean z per cell.
  4. Output: one .npy per timestamp (height in mm, NaN for empty cells), metadata.json
     with the grid origin / spacing / plane equation, and a single HTML viewer.

Output is sim-ready: regular grid, bed-relative height, real-world mm.

Usage:
  python3 scripts/bed_rectify.py                                 # default baseline + 6 timestamps
  python3 scripts/bed_rectify.py --window 15 --grid-mm 0.5
  python3 scripts/bed_rectify.py --baseline-t 10 --timestamps 30,60,90,120,150,180,210
"""
import argparse, json, subprocess
from pathlib import Path
import numpy as np

REPO = Path(__file__).resolve().parent.parent
MKV = REPO / "videos" / "depth_20260311_105209.mkv"
OUT_DIR = REPO / "calib" / "bed_rectified"

DEPTH_W, DEPTH_H = 640, 576
DEPTH_FX, DEPTH_FY = 505.0, 505.2
DEPTH_CX, DEPTH_CY = 306.3, 297.2
DEPTH_FPS = 30
BED_MIN, BED_MAX = 700, 850


def extract_depth_window(t_seconds, n_frames):
    """Extract `n_frames` consecutive depth frames starting at t and return their median."""
    duration = n_frames / DEPTH_FPS
    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{t_seconds}",
        "-t", f"{duration + 0.05}",
        "-i", str(MKV),
        "-map", "0:1",
        "-c:v", "rawvideo", "-pix_fmt", "gray16le",
        "-f", "rawvideo", "-",
    ]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        return None
    frame_size = DEPTH_W * DEPTH_H * 2
    buf = r.stdout[: frame_size * n_frames]
    n_got = len(buf) // frame_size
    if n_got < 2:
        return None
    arr = np.frombuffer(buf[: n_got * frame_size], dtype=np.uint16).reshape(n_got, DEPTH_H, DEPTH_W)
    arr = arr.astype(np.float32)
    arr[arr == 0] = np.nan
    return np.nanmedian(arr, axis=0), n_got


def depth_to_points(depth_mm, bed_min=BED_MIN, bed_max=BED_MAX):
    """Project a depth image (mm) to a Nx3 array of camera-frame XYZ (mm)."""
    valid = np.isfinite(depth_mm) & (depth_mm >= bed_min) & (depth_mm <= bed_max)
    v_idx, u_idx = np.where(valid)
    z = depth_mm[v_idx, u_idx]
    x = (u_idx - DEPTH_CX) * z / DEPTH_FX
    y = (v_idx - DEPTH_CY) * z / DEPTH_FY
    return np.stack([x, y, z], axis=1)


def fit_plane_svd(points):
    """Best-fit plane through a Nx3 cloud by SVD. Returns (normal, centroid)."""
    centroid = points.mean(axis=0)
    centered = points - centroid
    _, _, vh = np.linalg.svd(centered, full_matrices=False)
    normal = vh[-1]
    if normal[2] > 0:
        normal = -normal  # choose normal pointing toward camera (Kinect is at z=0 looking +z)
    return normal / np.linalg.norm(normal), centroid


def rotation_from_normal(normal, target=(0.0, 0.0, 1.0)):
    """Rotation matrix R such that R @ normal = target (Rodrigues formula)."""
    n = np.asarray(normal, dtype=np.float64)
    t = np.asarray(target, dtype=np.float64)
    n = n / np.linalg.norm(n)
    t = t / np.linalg.norm(t)
    v = np.cross(n, t)
    s = np.linalg.norm(v)
    c = float(np.dot(n, t))
    if s < 1e-9:
        return np.eye(3) if c > 0 else -np.eye(3)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K * ((1 - c) / (s * s))


def grid_bin(points_xyz, grid_mm, x_extent, y_extent):
    """Bin point z into a regular XY grid (mean per cell). Returns 2D heightmap (HxW)."""
    x_min, x_max = x_extent
    y_min, y_max = y_extent
    nx = int(np.ceil((x_max - x_min) / grid_mm))
    ny = int(np.ceil((y_max - y_min) / grid_mm))
    ix = np.clip(((points_xyz[:, 0] - x_min) / grid_mm).astype(np.int32), 0, nx - 1)
    iy = np.clip(((points_xyz[:, 1] - y_min) / grid_mm).astype(np.int32), 0, ny - 1)
    flat_idx = iy * nx + ix
    sums = np.bincount(flat_idx, weights=points_xyz[:, 2], minlength=nx * ny)
    counts = np.bincount(flat_idx, minlength=nx * ny)
    grid = np.full(nx * ny, np.nan, dtype=np.float32)
    nonzero = counts > 0
    grid[nonzero] = sums[nonzero] / counts[nonzero]
    return grid.reshape(ny, nx)


def heightmap_to_png(grid, out_path, label_text, vmin=None, vmax=None, diverging=False):
    """Render a heightmap with FIXED color limits (vmin/vmax in mm).
    diverging=True centers the map at 0 (for diff maps: blue = depos, red = scour)."""
    import cv2
    valid = np.isfinite(grid)
    if not valid.any():
        return
    if vmin is None or vmax is None:
        if diverging:
            m = max(abs(np.nanpercentile(grid, 2)), abs(np.nanpercentile(grid, 98)), 1.0)
            vmin, vmax = -m, m
        else:
            vmin, vmax = float(np.nanpercentile(grid, 2)), float(np.nanpercentile(grid, 98))
    span = max(vmax - vmin, 1e-6)
    norm = np.clip((grid - vmin) / span, 0, 1)
    u8 = np.where(valid, (norm * 255), 0).astype(np.uint8)
    cmap = cv2.COLORMAP_JET if diverging else cv2.COLORMAP_TURBO
    color = cv2.applyColorMap(u8, cmap)
    color[~valid] = (40, 40, 40)
    h, w = color.shape[:2]
    cv2.rectangle(color, (0, 0), (w, 24), (0, 0, 0), -1)
    cv2.putText(color, label_text, (6, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.imwrite(str(out_path), color, [cv2.IMWRITE_PNG_COMPRESSION, 6])


def clean_bed_mask(grid, max_abs_mm=50.0):
    """Mask out cells whose rectified height is implausibly far from the bed plane
    (rim, walls, residual cross-bar pixels). Operates in-place and returns the masked grid."""
    out = grid.copy()
    bad = np.isfinite(out) & (np.abs(out) > max_abs_mm)
    out[bad] = np.nan
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline-t", type=float, default=15.0,
                    help="timestamp (s) for plane fit; pick a pre-clack frame with dry bed")
    ap.add_argument("--timestamps", type=str, default="20,40,60,90,120,150,180,210",
                    help="comma-separated timestamps to rectify")
    ap.add_argument("--window", type=int, default=10,
                    help="number of consecutive depth frames to median per timestamp")
    ap.add_argument("--grid-mm", type=float, default=1.0,
                    help="output grid spacing in mm")
    ap.add_argument("--bed-max-mm", type=float, default=50.0,
                    help="post-rectify mask: drop cells with |z| above this (rim, walls, residual non-bed)")
    ap.add_argument("--vrange-abs", type=float, default=15.0,
                    help="±mm range for absolute heightmap PNG color scale")
    ap.add_argument("--vrange-diff", type=float, default=10.0,
                    help="±mm range for diff PNG color scale (diverging)")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    times = [float(t) for t in args.timestamps.split(",")]

    # --- 1. Baseline depth + plane fit ---
    print(f"Baseline t={args.baseline_t}s, window={args.window} frames")
    baseline = extract_depth_window(args.baseline_t, args.window)
    if baseline is None:
        raise SystemExit("baseline extraction failed")
    base_depth, n_got = baseline
    print(f"  median over {n_got} frames")
    base_pts = depth_to_points(base_depth)
    print(f"  {len(base_pts):,} bed points")

    normal, centroid = fit_plane_svd(base_pts)
    print(f"  plane normal in Kinect frame: ({normal[0]:+.4f}, {normal[1]:+.4f}, {normal[2]:+.4f})")
    print(f"  plane centroid: ({centroid[0]:+.1f}, {centroid[1]:+.1f}, {centroid[2]:+.1f}) mm")
    R = rotation_from_normal(normal)
    tilt_deg = float(np.degrees(np.arccos(abs(normal[2]))))
    print(f"  bed tilt vs camera axis: {tilt_deg:.2f}°")

    # Apply transform to baseline points to determine grid extent (translate to centroid first)
    base_rect = (R @ (base_pts - centroid).T).T
    x_min, x_max = float(np.percentile(base_rect[:, 0], 0.1)), float(np.percentile(base_rect[:, 0], 99.9))
    y_min, y_max = float(np.percentile(base_rect[:, 1], 0.1)), float(np.percentile(base_rect[:, 1], 99.9))
    print(f"  bed XY extent (after rectify): {x_max-x_min:.0f} × {y_max-y_min:.0f} mm")
    print(f"  output grid: {int(np.ceil((x_max-x_min)/args.grid_mm))} × {int(np.ceil((y_max-y_min)/args.grid_mm))} cells @ {args.grid_mm} mm")

    # --- 2. Rectify each timestamp ---
    results = []
    base_grid = grid_bin(base_rect, args.grid_mm, (x_min, x_max), (y_min, y_max))
    base_grid = clean_bed_mask(base_grid, args.bed_max_mm)
    base_path = OUT_DIR / "heightmap_baseline.npy"
    np.save(base_path, base_grid)
    bvalid = np.isfinite(base_grid)
    print(f"  baseline grid: {bvalid.sum():,} valid cells / {base_grid.size:,} ({bvalid.mean()*100:.1f}%)")
    print(f"  baseline z (5/50/95 pct): {np.nanpercentile(base_grid,5):+.2f} / {np.nanpercentile(base_grid,50):+.2f} / {np.nanpercentile(base_grid,95):+.2f} mm")
    heightmap_to_png(base_grid, OUT_DIR / "heightmap_baseline.png",
                     f"baseline (dry bed) t={args.baseline_t:.0f}s   color clip ±{args.vrange_abs:.0f}mm",
                     vmin=-args.vrange_abs, vmax=args.vrange_abs)
    print(f"\nSaved baseline -> {base_path.relative_to(REPO)}")

    for t in times:
        out = extract_depth_window(t, args.window)
        if out is None:
            print(f"  t={t:.0f}s: extraction failed"); continue
        depth, n_got = out
        pts = depth_to_points(depth)
        if len(pts) < 1000:
            print(f"  t={t:.0f}s: too few points ({len(pts)})"); continue
        rect = (R @ (pts - centroid).T).T
        grid = grid_bin(rect, args.grid_mm, (x_min, x_max), (y_min, y_max))
        grid = clean_bed_mask(grid, args.bed_max_mm)
        npy_path = OUT_DIR / f"heightmap_t{int(t):03d}.npy"
        png_path = OUT_DIR / f"heightmap_t{int(t):03d}.png"
        np.save(npy_path, grid)
        z_p5, z_med, z_p95 = float(np.nanpercentile(grid, 5)), float(np.nanpercentile(grid, 50)), float(np.nanpercentile(grid, 95))
        heightmap_to_png(grid, png_path,
                         f"t={t:.0f}s   z 5/50/95 pct: {z_p5:+.1f}/{z_med:+.1f}/{z_p95:+.1f}mm   color clip ±{args.vrange_abs:.0f}mm",
                         vmin=-args.vrange_abs, vmax=args.vrange_abs)
        # Change-from-baseline
        diff = grid - base_grid
        diff_png = OUT_DIR / f"diff_t{int(t):03d}.png"
        d_p5, d_med, d_p95 = float(np.nanpercentile(diff, 5)), float(np.nanpercentile(diff, 50)), float(np.nanpercentile(diff, 95))
        heightmap_to_png(diff, diff_png,
                         f"Δ baseline   t={t:.0f}s   5/50/95 pct: {d_p5:+.1f}/{d_med:+.1f}/{d_p95:+.1f}mm   ±{args.vrange_diff:.0f}mm  red=scour blue=depos",
                         vmin=-args.vrange_diff, vmax=args.vrange_diff, diverging=True)
        valid_frac = float(np.isfinite(grid).mean())
        results.append({"t": t, "npy": npy_path.name, "png": png_path.name, "diff_png": diff_png.name,
                        "z_p5_mm": z_p5, "z_p50_mm": z_med, "z_p95_mm": z_p95,
                        "diff_p5_mm": d_p5, "diff_p50_mm": d_med, "diff_p95_mm": d_p95,
                        "valid_frac": valid_frac, "n_frames_median": n_got})
        print(f"  t={t:5.0f}s  z(5/50/95)=[{z_p5:+5.1f},{z_med:+5.1f},{z_p95:+5.1f}]mm  Δ(5/50/95)=[{d_p5:+5.1f},{d_med:+5.1f},{d_p95:+5.1f}]mm  valid {valid_frac*100:.1f}%")

    # --- 3. Metadata ---
    meta = {
        "source": MKV.name,
        "baseline_t_s": args.baseline_t,
        "smoothing_window_frames": args.window,
        "grid_mm": args.grid_mm,
        "grid_extent_mm": {"x_min": x_min, "x_max": x_max, "y_min": y_min, "y_max": y_max},
        "grid_shape": [base_grid.shape[0], base_grid.shape[1]],
        "plane_in_kinect_frame": {"normal": normal.tolist(), "centroid_mm": centroid.tolist(),
                                   "tilt_vs_camera_axis_deg": tilt_deg},
        "rotation_R_kinect_to_bed": R.tolist(),
        "intrinsics_used": {"fx": DEPTH_FX, "fy": DEPTH_FY, "cx": DEPTH_CX, "cy": DEPTH_CY,
                            "note": "approximated; true K4A NFOV intrinsics need pyk4a or MKV blob"},
        "bed_depth_mask_mm": [BED_MIN, BED_MAX],
        "frames": results,
    }
    (OUT_DIR / "metadata.json").write_text(json.dumps(meta, indent=2))
    print(f"\nMetadata -> {(OUT_DIR/'metadata.json').relative_to(REPO)}")

    # --- 4. HTML viewer ---
    cards = []
    for r in results:
        cards.append(f"""
        <div class="card">
          <div class="card-header"><span class="t">t = {r['t']:.0f} s</span><span class="m">Δ med {r['diff_p50_mm']:+.1f} mm · 5/95 [{r['diff_p5_mm']:+.1f}, {r['diff_p95_mm']:+.1f}]</span></div>
          <img src="{r['png']}" alt="rectified heightmap t={r['t']}">
          <div class="cap">absolute height (turbo, ±{args.vrange_abs:.0f} mm)</div>
          <img src="{r['diff_png']}" alt="diff t={r['t']}">
          <div class="cap">Δ from baseline (jet diverging, ±{args.vrange_diff:.0f} mm; red=scour blue=deposition)</div>
        </div>""")
    html = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Rectified bed heightmaps — Kinect</title>
<style>
* {{ margin:0; padding:0; box-sizing:border-box; }}
body {{ font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif; background:#0d0d0d; color:#ececec; line-height:1.5; }}
header {{ padding:24px 32px 20px; border-bottom:1px solid #1f1f1f; display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:12px; }}
.eyebrow {{ font-size:10px; font-weight:500; letter-spacing:0.14em; text-transform:uppercase; color:#c05030; }}
h1 {{ font-size:22px; font-weight:300; color:#fff; margin-top:4px; }}
.meta {{ font-family:'SF Mono',Menlo,monospace; font-size:11px; color:#888; }}
main {{ padding:32px; max-width:1500px; margin:0 auto; }}
.desc {{ font-size:13px; color:#999; max-width:760px; margin-bottom:24px; }}
.section-label {{ font-size:10px; font-weight:500; letter-spacing:0.12em; text-transform:uppercase; color:#c05030; margin-bottom:4px; }}
.section-title {{ font-size:15px; color:#fff; margin-bottom:6px; }}
.section-desc {{ font-size:12px; color:#888; max-width:720px; margin-bottom:14px; }}
.section {{ margin-bottom:36px; }}
.baseline-row {{ display:grid; grid-template-columns:1fr; gap:18px; }}
.grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); gap:18px; }}
.card {{ background:#141414; border:1px solid #222; border-radius:6px; overflow:hidden; }}
.card-header {{ padding:10px 14px; border-bottom:1px solid #1f1f1f; display:flex; justify-content:space-between; }}
.card-header .t {{ font-size:12px; font-weight:500; color:#ddd; }}
.card-header .m {{ font-family:'SF Mono',Menlo,monospace; font-size:10px; color:#777; }}
.card img {{ width:100%; display:block; background:#000; }}
.cap {{ font-family:'SF Mono',Menlo,monospace; font-size:10px; color:#9cf; padding:6px 14px 10px; }}
.stats {{ background:#141414; border:1px solid #222; border-radius:6px; padding:14px 18px; font-family:'SF Mono',Menlo,monospace; font-size:11px; color:#bbb; margin-bottom:24px; }}
.stats span {{ color:#888; }}
footer {{ padding:24px 32px; border-top:1px solid #1f1f1f; font-size:11px; color:#666; font-family:'SF Mono',Menlo,monospace; }}
</style></head><body>
<header>
  <div><div class="eyebrow">feminist.it · stream table · digital twin prep</div>
  <h1>Rectified bed heightmaps</h1></div>
  <div class="meta">{args.grid_mm} mm/cell · {args.window}-frame median · plane-aligned · bed-relative z</div>
</header>
<main>
  <p class="desc">Kinect depth median-smoothed over {args.window} consecutive frames per timestamp,
  projected to 3D, rotated so the dry-bed plane lies horizontal, and binned into a top-down grid
  at {args.grid_mm} mm/cell. Output is sim-ready: each cell has a known mm² area and a bed-relative
  height in mm. The same transform is applied to all timestamps so heightmaps are directly comparable.</p>

  <div class="stats">
    <span>baseline:</span> t={args.baseline_t:.0f}s &nbsp; · &nbsp;
    <span>plane normal (Kinect frame):</span> ({normal[0]:+.4f}, {normal[1]:+.4f}, {normal[2]:+.4f}) &nbsp; · &nbsp;
    <span>bed tilt vs camera axis:</span> {tilt_deg:.2f}° &nbsp; · &nbsp;
    <span>grid:</span> {base_grid.shape[1]}×{base_grid.shape[0]} cells &nbsp; · &nbsp;
    <span>extent:</span> {x_max-x_min:.0f}×{y_max-y_min:.0f} mm
  </div>

  <div class="section">
    <div class="section-label">baseline</div>
    <div class="section-title">Dry bed plane fit @ t={args.baseline_t:.0f}s</div>
    <div class="section-desc">Median depth used for the SVD plane fit. Should be near-uniform z (small variations = bed micro-topography or noise floor).</div>
    <div class="baseline-row">
      <div class="card"><div class="card-header"><span class="t">baseline · t = {args.baseline_t:.0f} s</span><span class="m">{base_grid.shape[1]}×{base_grid.shape[0]} cells</span></div>
      <img src="heightmap_baseline.png"><div class="cap">flat dry bed (rectified)</div></div>
    </div>
  </div>

  <div class="section">
    <div class="section-label">timeline</div>
    <div class="section-title">Rectified heightmap & change from baseline per timestamp</div>
    <div class="section-desc">Each card: top = absolute height (turbo, low→high), bottom = Δ from baseline (turbo, scour vs deposit).</div>
    <div class="grid">{''.join(cards)}</div>
  </div>
</main>
<footer>Generated by scripts/bed_rectify.py · {len(results)} timestamps · {args.window}×30fps median · grid {args.grid_mm}mm</footer>
</body></html>"""
    (OUT_DIR / "index.html").write_text(html)
    print(f"Viewer  -> {(OUT_DIR/'index.html').relative_to(REPO)}")
    print(f"\nView: http://localhost:8765/calib/bed_rectified/")


if __name__ == "__main__":
    main()
