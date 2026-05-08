"""Run bed-change analysis over a rolling time window across the whole Kinect recording.

Produces:
  - calib/bed_timeseries/frame_tXX_tYY.png     (one diff image per interval)
  - calib/bed_timeseries/stats.csv             (per-interval volumes, rates, extrema)
  - calib/bed_timeseries/summary.png           (rate vs time plot)
  - calib/bed_timeseries/index.html            (gallery + plot for easy browsing)

Usage:
  python3 scripts/bed_change_timeseries.py                       # 30s windows from clack to end
  python3 scripts/bed_change_timeseries.py --window 20 --step 20 # non-overlapping 20s windows
  python3 scripts/bed_change_timeseries.py --cumulative          # compare each t1 against fixed t0
"""
import subprocess, argparse, csv
from pathlib import Path
import numpy as np

REPO = Path(__file__).resolve().parent.parent
MKV = REPO / "videos" / "depth_20260311_105209.mkv"
OUT_DIR = REPO / "calib" / "bed_timeseries"
OUT_DIR.mkdir(parents=True, exist_ok=True)

DEPTH_W, DEPTH_H = 640, 576
DEPTH_FX = 505.0; DEPTH_FY = 505.2; DEPTH_CX = 306.3; DEPTH_CY = 297.2


def extract_depth(t_seconds):
    out = Path(f"/tmp/depth_{t_seconds:.2f}.raw")
    cmd = ["ffmpeg", "-y", "-ss", f"{t_seconds}", "-i", str(MKV),
           "-map", "0:1", "-frames:v", "1",
           "-c:v", "rawvideo", "-pix_fmt", "gray16le",
           "-f", "rawvideo", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        return None
    arr = np.fromfile(out, dtype=np.uint16)
    if arr.size != DEPTH_W * DEPTH_H:
        return None
    return arr.reshape(DEPTH_H, DEPTH_W)


def extract_color(t_seconds):
    import cv2
    out = Path(f"/tmp/color_{t_seconds:.2f}.jpg")
    cmd = ["ffmpeg", "-y", "-ss", f"{t_seconds}", "-i", str(MKV),
           "-map", "0:0", "-frames:v", "1", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        return None
    return cv2.imread(str(out))


def analyse(d0, d1, dt, bed_min=700, bed_max=850):
    valid = (d0 > 0) & (d1 > 0) & (d0 >= bed_min) & (d0 <= bed_max) & (d1 >= bed_min) & (d1 <= bed_max)
    d0f = d0.astype(np.float32); d1f = d1.astype(np.float32)
    diff = np.zeros_like(d0f)
    diff[valid] = d1f[valid] - d0f[valid]
    depth_avg = (d0f + d1f) / 2
    area_mm2 = (depth_avg / DEPTH_FX) * (depth_avg / DEPTH_FY)
    vol = diff * area_mm2
    vol_v = vol[valid]
    stats = {
        "n_valid_px":   int(valid.sum()),
        "mean_mm":      float(diff[valid].mean()),
        "median_mm":    float(np.median(diff[valid])),
        "max_scour_mm": float(diff[valid].max()),
        "max_depos_mm": float(diff[valid].min()),
        "rms_mm":       float(np.sqrt((diff[valid]**2).mean())),
        "scour_mL":     float(vol_v[vol_v > 0].sum() / 1e3) if (vol_v > 0).any() else 0.0,
        "depos_mL":     float(-vol_v[vol_v < 0].sum() / 1e3) if (vol_v < 0).any() else 0.0,
    }
    stats["net_mL"] = stats["scour_mL"] - stats["depos_mL"]
    stats["scour_mL_per_s"] = stats["scour_mL"] / dt
    stats["depos_mL_per_s"] = stats["depos_mL"] / dt
    stats["net_mL_per_s"]   = stats["net_mL"] / dt
    return diff, valid, stats


def colorise(diff, valid, max_abs_mm=40):
    import cv2
    vis = np.zeros((DEPTH_H, DEPTH_W, 3), dtype=np.uint8)
    vis[~valid] = (120, 120, 120)
    vis[valid] = 255
    s_int = np.clip(diff / max_abs_mm, 0, 1)
    d_int = np.clip(-diff / max_abs_mm, 0, 1)
    scour = valid & (diff > 0); depos = valid & (diff < 0)
    # RGB packing (we swap to BGR at the end for cv2)
    R = vis[..., 0]; G = vis[..., 1]; B = vis[..., 2]
    G[scour] = (255 * (1 - s_int[scour])).astype(np.uint8)
    B[scour] = (255 * (1 - s_int[scour])).astype(np.uint8)
    R[depos] = (255 * (1 - d_int[depos])).astype(np.uint8)
    G[depos] = (255 * (1 - d_int[depos])).astype(np.uint8)
    return vis[:, :, [2, 1, 0]]  # BGR for cv2


def colorise_depth(depth, bed_min=700, bed_max=850):
    """Colorize an absolute depth frame using a terrain-style colormap so high-bed
    (close to kinect) and low-bed (far from kinect) are visually distinct.
    Invalid/masked pixels are grey."""
    import cv2
    valid = (depth > 0) & (depth >= bed_min) & (depth <= bed_max)
    # Normalize bed pixels into [0, 1]
    norm = np.zeros_like(depth, dtype=np.float32)
    norm[valid] = (depth[valid].astype(np.float32) - bed_min) / (bed_max - bed_min)
    # Apply a color map (Turbo is vivid for this range). 0 = closest (high bed), 1 = deepest (low bed).
    u8 = (norm * 255).clip(0, 255).astype(np.uint8)
    cmap = cv2.applyColorMap(u8, cv2.COLORMAP_TURBO)
    # Grey out invalid
    cmap[~valid] = (120, 120, 120)
    return cmap


def add_label(img_bgr, text):
    import cv2
    out = img_bgr.copy()
    h, w = out.shape[:2]
    cv2.rectangle(out, (0, 0), (w, 28), (0, 0, 0), -1)
    cv2.putText(out, text, (6, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", type=float, default=30.0, help="interval length in seconds")
    ap.add_argument("--step", type=float, default=30.0, help="step between interval starts")
    ap.add_argument("--t-start", type=float, default=27.4, help="first t0 (default: clack at 27.4s)")
    ap.add_argument("--t-end", type=float, default=237.0, help="do not analyse past this t1 (Kinect ends at 237.9s)")
    ap.add_argument("--cumulative", action="store_true",
                    help="compare each t1 against fixed t0 (total scour from start) instead of rolling window")
    ap.add_argument("--max-abs-mm", type=float, default=40.0)
    args = ap.parse_args()

    # Build schedule
    intervals = []
    if args.cumulative:
        t0 = args.t_start
        t1 = t0 + args.window
        while t1 <= args.t_end:
            intervals.append((t0, t1))
            t1 += args.step
    else:
        t0 = args.t_start
        while t0 + args.window <= args.t_end:
            intervals.append((t0, t0 + args.window))
            t0 += args.step

    print(f"{len(intervals)} intervals ({'cumulative from start' if args.cumulative else 'rolling window'})")
    for t0, t1 in intervals[:3]:
        print(f"  {t0:.1f} → {t1:.1f}")
    if len(intervals) > 3:
        print(f"  …")

    import cv2
    # Cache depths and colors
    depth_cache = {}; color_cache = {}
    def get_depth(t):
        if t not in depth_cache: depth_cache[t] = extract_depth(t)
        return depth_cache[t]
    def get_color(t):
        if t not in color_cache: color_cache[t] = extract_color(t)
        return color_cache[t]

    rows = []
    for (t0, t1) in intervals:
        d0 = get_depth(t0); d1 = get_depth(t1)
        if d0 is None or d1 is None:
            print(f"  [{t0:.1f}→{t1:.1f}] failed to load"); continue
        diff, valid, stats = analyse(d0, d1, t1 - t0)
        vis = colorise(diff, valid, args.max_abs_mm)
        label = f"t={t0:.0f}→{t1:.0f}s  scour {stats['scour_mL']:.1f} mL  depos {stats['depos_mL']:.1f} mL  net {stats['net_mL']:+.1f} mL"
        vis_labelled = add_label(vis, label)
        img_path = OUT_DIR / f"frame_t{int(t0):03d}_t{int(t1):03d}.png"
        cv2.imwrite(str(img_path), vis_labelled, [cv2.IMWRITE_PNG_COMPRESSION, 6])

        # Overlay on color frame at t1 (the "after" frame)
        overlay_path = None
        color = get_color(t1)
        if color is not None:
            vis_resized = cv2.resize(vis, (color.shape[1], color.shape[0]), interpolation=cv2.INTER_NEAREST)
            # Only overlay where the change is non-trivial (|diff| > 3 mm) — keeps the color legible elsewhere
            diff_resized = cv2.resize(diff, (color.shape[1], color.shape[0]), interpolation=cv2.INTER_NEAREST)
            valid_resized = cv2.resize(valid.astype(np.uint8), (color.shape[1], color.shape[0]), interpolation=cv2.INTER_NEAREST).astype(bool)
            mask = valid_resized & (np.abs(diff_resized) > 3.0)
            blend = color.copy()
            alpha = 0.65
            blend[mask] = (alpha * vis_resized[mask] + (1 - alpha) * color[mask]).astype(np.uint8)
            blend_labelled = add_label(blend, label)
            overlay_path = OUT_DIR / f"overlay_t{int(t0):03d}_t{int(t1):03d}.jpg"
            cv2.imwrite(str(overlay_path), blend_labelled, [cv2.IMWRITE_JPEG_QUALITY, 85])

        # Also save: absolute depth maps at t0 and t1 (topography), and change overlayed
        # on the depth map (bed topography + dynamics in one view).
        depth_t0_vis = colorise_depth(d0.astype(np.uint16))
        depth_t1_vis = colorise_depth(d1.astype(np.uint16))
        depth_t0_lab = add_label(depth_t0_vis, f"depth @ t={t0:.0f}s  (turbo: red = closer/higher bed, blue = deeper/lower)")
        depth_t1_lab = add_label(depth_t1_vis, f"depth @ t={t1:.0f}s")
        depth_t0_path = OUT_DIR / f"depth_t{int(t0):03d}.png"
        depth_t1_path = OUT_DIR / f"depth_t{int(t1):03d}.png"
        cv2.imwrite(str(depth_t0_path), depth_t0_lab, [cv2.IMWRITE_PNG_COMPRESSION, 6])
        cv2.imwrite(str(depth_t1_path), depth_t1_lab, [cv2.IMWRITE_PNG_COMPRESSION, 6])

        # Change overlaid on depth map (combines topography + change in one viz)
        # Use depth at t1 (after) as base, change on top where it's significant
        depth_change_base = depth_t1_vis.copy()
        change_mask = valid & (np.abs(diff) > 3.0)
        # Darken the depth-map where change happened, then overlay change color
        alpha = 0.7
        depth_change_base[change_mask] = (alpha * vis[change_mask] + (1 - alpha) * depth_change_base[change_mask]).astype(np.uint8)
        depth_change_lab = add_label(depth_change_base, f"depth topography + change  t={t0:.0f}→{t1:.0f}s")
        depth_change_path = OUT_DIR / f"depth_change_t{int(t0):03d}_t{int(t1):03d}.png"
        cv2.imwrite(str(depth_change_path), depth_change_lab, [cv2.IMWRITE_PNG_COMPRESSION, 6])

        rows.append({
            "t0_s": t0, "t1_s": t1, "dt_s": t1 - t0, **stats,
            "image": img_path.name,
            "overlay": overlay_path.name if overlay_path else None,
            "depth_t0": depth_t0_path.name,
            "depth_t1": depth_t1_path.name,
            "depth_change": depth_change_path.name,
        })
        print(f"  [{t0:.1f}→{t1:.1f}] scour {stats['scour_mL']:6.1f} mL  depos {stats['depos_mL']:5.1f} mL  net {stats['net_mL']:+6.1f} mL  max_scour {stats['max_scour_mm']:+5.1f} mm")

    # CSV
    csv_path = OUT_DIR / "stats.csv"
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else [])
        w.writeheader(); w.writerows(rows)
    print(f"\nSaved {csv_path.relative_to(REPO)}")

    # Summary plot
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    ts = [(r["t0_s"] + r["t1_s"]) / 2 - args.t_start for r in rows]
    scour_rate = [r["scour_mL_per_s"] for r in rows]
    depos_rate = [r["depos_mL_per_s"] for r in rows]
    net_rate   = [r["net_mL_per_s"] for r in rows]
    fig, ax = plt.subplots(2, 1, figsize=(10, 7), sharex=True)
    ax[0].plot(ts, scour_rate, "-o", color="crimson", label="scour rate (mL/s)")
    ax[0].plot(ts, depos_rate, "-s", color="royalblue", label="deposition rate (mL/s)")
    ax[0].plot(ts, net_rate,  "-^", color="black",     label="net (mL/s)")
    ax[0].set_ylabel("Rate (mL/s)"); ax[0].legend(); ax[0].grid(alpha=0.3)
    ax[0].set_title("Sediment transport rate vs time post-clack")
    ax[1].plot(ts, [r["max_scour_mm"] for r in rows], "-o", color="crimson", label="max scour (mm)")
    ax[1].plot(ts, [r["max_depos_mm"] for r in rows], "-o", color="royalblue", label="max deposition (mm)")
    ax[1].plot(ts, [r["mean_mm"] for r in rows],      "-",  color="grey",    label="mean Δ-depth (mm)")
    ax[1].set_xlabel("time post-clack (s, interval midpoint)"); ax[1].set_ylabel("depth change (mm)")
    ax[1].legend(); ax[1].grid(alpha=0.3)
    plt.tight_layout()
    plot_path = OUT_DIR / "summary.png"
    plt.savefig(plot_path, dpi=110)
    print(f"Saved {plot_path.relative_to(REPO)}")

    # HTML gallery
    html = ["""<!DOCTYPE html><html><head><meta charset='utf-8'><title>Bed-change time series</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0f0f0f; color: #eee; margin: 0; padding: 24px; max-width: 1400px; margin-inline: auto; }
h1 { margin: 0 0 10px; color: #c05030; letter-spacing: 0.04em; font-size: 14px; text-transform: uppercase; }
h2 { margin: 24px 0 10px; color: #eee; font-size: 15px; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 500; }
.summary { margin: 10px 0 30px; }
.summary img { max-width: 100%; border: 1px solid #333; border-radius: 4px; background: #fff; }
.pair-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
.pair-grid .cell { background: #1a1a1a; padding: 10px; border-radius: 4px; border: 1px solid #222; }
.pair-grid .cell img { width: 100%; display: block; border-radius: 3px; }
.pair-grid .cell .cap { font-family: 'SF Mono', Menlo, monospace; font-size: 11px; color: #9cf; margin-top: 6px; }
.tight-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.tight-grid .cell img { width: 100%; display: block; border: 1px solid #333; border-radius: 3px; }
.tight-grid .cell p { font-family: 'SF Mono', Menlo, monospace; font-size: 10.5px; color: #9cf; margin: 4px 0 0; }
table { border-collapse: collapse; margin: 10px 0; font-size: 12px; font-family: 'SF Mono', Menlo, monospace; }
th, td { border: 1px solid #333; padding: 5px 10px; text-align: right; }
th { background: #222; color: #c05030; text-align: center; }
tr:nth-child(even) { background: #1a1a1a; }
tr:hover { background: #252525; }
.legend-box { background: #1a1a1a; padding: 12px 16px; border: 1px solid #333; border-radius: 4px; font-size: 12px; margin-bottom: 20px; }
.legend-box .dot { display: inline-block; width: 14px; height: 14px; border-radius: 3px; vertical-align: middle; margin: 0 4px; border: 1px solid #444; }
.notes { font-size: 13px; color: #aaa; max-width: 900px; line-height: 1.5; }
</style></head><body>

<h1>Bed-change time series — Kinect depth differencing</h1>
<p class='notes'>Each interval compares Kinect depth at t<sub>0</sub> and t<sub>1</sub>. Positive Δ-depth = bed lowered (scour). Negative Δ-depth = bed raised (deposition). Pixels outside the 700–850 mm bed range (cross-bar, hands, tools) are excluded. Pixel area scales with local depth; volumes are sums of per-pixel Δ·area.</p>

<div class='legend-box'>
  <span class='dot' style='background:#e33'></span>scour (bed dropped)
  &nbsp;&nbsp;&nbsp;
  <span class='dot' style='background:#fff'></span>no change
  &nbsp;&nbsp;&nbsp;
  <span class='dot' style='background:#3af'></span>deposition (bed rose)
  &nbsp;&nbsp;&nbsp;
  <span class='dot' style='background:#777'></span>masked (outside bed depth range)
</div>

<h2>Rate-vs-time summary</h2>
<div class=summary><img src='summary.png'></div>

<h2>Per-interval stats</h2>
<table><tr><th>t₀ (s)</th><th>t₁ (s)</th><th>scour (mL)</th><th>depos (mL)</th><th>net (mL)</th><th>net rate (mL/s)</th><th>max scour (mm)</th><th>max depos (mm)</th></tr>"""]
    for r in rows:
        html.append(f"<tr><td>{r['t0_s']:.1f}</td><td>{r['t1_s']:.1f}</td><td>{r['scour_mL']:.2f}</td><td>{r['depos_mL']:.2f}</td><td>{r['net_mL']:+.2f}</td><td>{r['net_mL_per_s']:+.3f}</td><td>{r['max_scour_mm']:+.1f}</td><td>{r['max_depos_mm']:+.1f}</td></tr>")
    html.append("</table>")

    # Overlay gallery — "on the table"
    html.append("<h2>Overlaid on the sediment bed (from Kinect color frame at t₁)</h2>")
    html.append("<div class='pair-grid'>")
    for r in rows:
        if r.get("overlay"):
            html.append(f"<div class=cell><img src='{r['overlay']}'><div class=cap>t = {r['t0_s']:.1f} → {r['t1_s']:.1f} s · net {r['net_mL']:+.1f} mL · max scour {r['max_scour_mm']:+.0f} mm</div></div>")
    html.append("</div>")

    # Absolute-depth (topography) gallery
    html.append("<h2>Kinect depth topography at each t₁</h2>")
    html.append("<p class='notes'>Absolute distance from the Kinect to the bed at each frame, colorised with "
                "the Turbo colormap. <strong>Red</strong> = bed is closer to Kinect (higher elevation / "
                "raised sediment). <strong>Blue</strong> = bed is farther from Kinect (lower elevation / "
                "scour holes). Grey = outside the 700-850 mm bed depth range.</p>")
    html.append("<div class='tight-grid'>")
    for r in rows:
        if r.get("depth_t1"):
            html.append(f"<div class=cell><img src='{r['depth_t1']}'><p>depth @ t = {r['t1_s']:.0f} s</p></div>")
    html.append("</div>")

    # Depth + change combined
    html.append("<h2>Topography + change (bed depth with scour/deposition overlay)</h2>")
    html.append("<p class='notes'>Turbo-colored bed topography at t₁, with change overlay where |Δ| > 3 mm. "
                "Shows both the current shape of the bed AND what changed during this interval — read the "
                "background color for topography, the red/blue mottling for dynamics.</p>")
    html.append("<div class='pair-grid'>")
    for r in rows:
        if r.get("depth_change"):
            html.append(f"<div class=cell><img src='{r['depth_change']}'><div class=cap>t = {r['t0_s']:.1f} → {r['t1_s']:.1f} s</div></div>")
    html.append("</div>")

    # Raw diff maps
    html.append("<h2>Raw Δ-depth maps</h2><div class='tight-grid'>")
    for r in rows:
        html.append(f"<div class=cell><img src='{r['image']}'><p>t = {r['t0_s']:.1f} → {r['t1_s']:.1f} s · net {r['net_mL']:+.1f} mL</p></div>")
    html.append("</div>")
    html.append("<p class='notes' style='margin-top:30px'>All images are masked to the sediment bed (700-850 mm depth from Kinect). The cross-bar and transient hands/objects are filtered out by depth range.</p>")
    html.append("</body></html>")
    html_path = OUT_DIR / "index.html"
    html_path.write_text("\n".join(html))
    print(f"Saved {html_path.relative_to(REPO)}")

    print(f"\nView in browser: http://127.0.0.1:8765/calib/bed_timeseries/")


if __name__ == "__main__":
    main()
