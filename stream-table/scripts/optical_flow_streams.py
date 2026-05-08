"""Dense optical flow on the Kinect color stream → "where did streams form".

Pipeline:
  1. Extract color frames from the depth MKV at FPS Hz.
  2. Compute Farneback dense optical flow between consecutive frames.
  3. Per-frame: HSV viz (hue = direction, value = magnitude) overlayed on the color frame.
  4. Accumulate flow magnitude across the whole run → "stream signature" heatmap that shows
     where water persistently moved.
  5. Build an MP4 of the per-frame overlays + an HTML viewer.

Usage:
  python3 scripts/optical_flow_streams.py                # default: 2 fps, 480w
  python3 scripts/optical_flow_streams.py --fps 5 --width 640
"""
import subprocess, argparse
from pathlib import Path
import numpy as np
import cv2

REPO = Path(__file__).resolve().parent.parent
MKV = REPO / "videos" / "depth_20260311_105209.mkv"
OUT_DIR = REPO / "calib" / "optical_flow"
FRAME_DIR = OUT_DIR / "frames"


def extract_color_stream(fps, width, t_start, t_end):
    """Pipe color frames out of MKV at the requested rate, scaled to `width` (keeps aspect)."""
    FRAME_DIR.mkdir(parents=True, exist_ok=True)
    for f in FRAME_DIR.glob("*.jpg"):
        f.unlink()
    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{t_start}",
        "-to", f"{t_end}",
        "-i", str(MKV),
        "-map", "0:0",
        "-vf", f"fps={fps},scale={width}:-2",
        "-q:v", "3",
        str(FRAME_DIR / "f_%05d.jpg"),
    ]
    print(f"  extracting color frames @ {fps} fps, width {width} ...")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-2000:])
        raise RuntimeError("ffmpeg color extraction failed")
    frames = sorted(FRAME_DIR.glob("f_*.jpg"))
    print(f"  extracted {len(frames)} frames")
    return frames


def compute_flow(prev_gray, gray):
    return cv2.calcOpticalFlowFarneback(
        prev_gray, gray, None,
        pyr_scale=0.5, levels=3, winsize=21,
        iterations=3, poly_n=7, poly_sigma=1.5, flags=0,
    )


def flow_to_hsv(flow, mag_max=None):
    """Convert flow → BGR with hue = direction, value = magnitude."""
    h, w = flow.shape[:2]
    fx, fy = flow[..., 0], flow[..., 1]
    mag = np.sqrt(fx * fx + fy * fy)
    ang = np.arctan2(fy, fx)
    if mag_max is None:
        mag_max = max(np.percentile(mag, 99), 1e-3)
    hsv = np.zeros((h, w, 3), dtype=np.uint8)
    hsv[..., 0] = ((ang + np.pi) / (2 * np.pi) * 179).astype(np.uint8)
    hsv[..., 1] = 255
    hsv[..., 2] = np.clip(mag / mag_max * 255, 0, 255).astype(np.uint8)
    return cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR), mag


def label(img, text):
    out = img.copy()
    h, w = out.shape[:2]
    cv2.rectangle(out, (0, 0), (w, 24), (0, 0, 0), -1)
    cv2.putText(out, text, (6, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fps", type=float, default=2.0, help="sampling fps for optical flow")
    ap.add_argument("--width", type=int, default=480, help="frame width (height auto, keeps aspect)")
    ap.add_argument("--t-start", type=float, default=27.4, help="start time (default: clack at 27.4)")
    ap.add_argument("--t-end", type=float, default=237.0, help="end time")
    ap.add_argument("--mag-thresh", type=float, default=0.5,
                    help="ignore flow magnitude below this (px/frame) when accumulating signature")
    ap.add_argument("--mag-max", type=float, default=4.0,
                    help="upper clip for per-frame visualization (px/frame)")
    ap.add_argument("--keep-frames", action="store_true", help="keep extracted color frames")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    frames = extract_color_stream(args.fps, args.width, args.t_start, args.t_end)
    if len(frames) < 2:
        raise SystemExit("need at least 2 frames")

    # Read all frames into memory once (small at 480w)
    print(f"  computing optical flow on {len(frames)-1} pairs ...")
    overlay_dir = OUT_DIR / "overlay"
    overlay_dir.mkdir(exist_ok=True)
    for f in overlay_dir.glob("*.jpg"):
        f.unlink()

    accum_mag = None
    n_above_thresh = None
    prev_color = cv2.imread(str(frames[0]))
    prev_gray = cv2.cvtColor(prev_color, cv2.COLOR_BGR2GRAY)
    h, w = prev_gray.shape

    dt = 1.0 / args.fps
    for i, fp in enumerate(frames[1:], start=1):
        color = cv2.imread(str(fp))
        gray = cv2.cvtColor(color, cv2.COLOR_BGR2GRAY)
        flow = compute_flow(prev_gray, gray)
        flow_bgr, mag = flow_to_hsv(flow, mag_max=args.mag_max)

        if accum_mag is None:
            accum_mag = np.zeros_like(mag, dtype=np.float64)
            n_above_thresh = np.zeros_like(mag, dtype=np.int32)
        # Sum magnitude (only where above noise floor) → bright lines = persistent flow
        contrib = np.where(mag > args.mag_thresh, mag, 0.0)
        accum_mag += contrib
        n_above_thresh += (mag > args.mag_thresh).astype(np.int32)

        # Overlay flow onto color
        alpha = 0.65
        flow_mask = (mag > args.mag_thresh)
        blend = color.copy()
        blend[flow_mask] = (alpha * flow_bgr[flow_mask] + (1 - alpha) * color[flow_mask]).astype(np.uint8)
        t_now = args.t_start + i * dt
        out = label(blend, f"t={t_now:5.1f}s   flow (hue=dir, brightness=speed up to {args.mag_max:.1f}px/fr)")
        cv2.imwrite(str(overlay_dir / f"ov_{i:05d}.jpg"), out, [cv2.IMWRITE_JPEG_QUALITY, 82])

        prev_gray = gray
        if i % 25 == 0 or i == len(frames) - 1:
            print(f"    {i}/{len(frames)-1}")

    # === Accumulated stream signature ===
    print(f"  building stream signature ...")
    # Mean speed per pixel (only counting frames where motion was real)
    safe_n = np.maximum(n_above_thresh, 1)
    mean_mag = accum_mag / safe_n
    # Persistence: fraction of frames the pixel had motion
    persistence = n_above_thresh / max(len(frames) - 1, 1)

    # Composite signature: mean_mag scaled by persistence (so transient noise is dim)
    sig = mean_mag * persistence
    sig_norm = sig / max(np.percentile(sig, 99), 1e-6)
    sig_u8 = np.clip(sig_norm * 255, 0, 255).astype(np.uint8)
    sig_color = cv2.applyColorMap(sig_u8, cv2.COLORMAP_INFERNO)

    # Overlay signature on a representative color frame (middle of sequence)
    mid_color = cv2.imread(str(frames[len(frames) // 2]))
    sig_mask = sig_u8 > 25
    blend = mid_color.copy()
    blend[sig_mask] = (0.7 * sig_color[sig_mask] + 0.3 * mid_color[sig_mask]).astype(np.uint8)
    sig_path = OUT_DIR / "stream_signature.png"
    cv2.imwrite(str(sig_path), label(blend, "stream signature: cumulative flow magnitude (inferno; brighter = more sustained motion)"))
    cv2.imwrite(str(OUT_DIR / "stream_signature_pure.png"), label(sig_color, "stream signature (no underlay)"))
    cv2.imwrite(str(OUT_DIR / "persistence.png"),
                label(cv2.applyColorMap((persistence * 255).clip(0, 255).astype(np.uint8), cv2.COLORMAP_VIRIDIS),
                      "persistence: fraction of frames each pixel had detectable flow"))

    print(f"  → {sig_path.relative_to(REPO)}")

    # === MP4 of overlay sequence ===
    mp4_path = OUT_DIR / "flow_overlay.mp4"
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(args.fps),
        "-i", str(overlay_dir / "ov_%05d.jpg"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-crf", "20",
        str(mp4_path),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-1500:])
    else:
        print(f"  → {mp4_path.relative_to(REPO)}")

    # === HTML viewer ===
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stream formation — Kinect optical flow</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #0d0d0d; color: #ececec; line-height: 1.5; }}
  header {{ padding: 24px 32px 20px; border-bottom: 1px solid #1f1f1f; display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 12px; }}
  .eyebrow {{ font-size: 10px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: #c05030; }}
  h1 {{ font-size: 22px; font-weight: 300; letter-spacing: -0.01em; margin-top: 4px; color: #fff; }}
  .meta {{ font-family: 'SF Mono', Menlo, monospace; font-size: 11px; color: #888; }}
  main {{ padding: 32px; max-width: 1500px; margin: 0 auto; }}
  .description {{ font-size: 13px; color: #999; font-weight: 300; max-width: 720px; margin-bottom: 28px; }}
  .legend {{ position: sticky; top: 0; z-index: 5; background: rgba(13,13,13,0.92); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border: 1px solid #1f1f1f; border-radius: 6px; padding: 12px 18px; margin-bottom: 24px; display: flex; align-items: center; gap: 24px; flex-wrap: wrap; font-size: 11px; color: #bbb; }}
  .legend-item {{ display: flex; align-items: center; gap: 8px; }}
  .swatch {{ width: 14px; height: 14px; border-radius: 3px; border: 1px solid #333; }}
  .hue-bar {{ width: 90px; height: 12px; border-radius: 2px; border: 1px solid #333; background: linear-gradient(90deg, hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%)); }}
  .inferno-bar {{ width: 90px; height: 12px; border-radius: 2px; border: 1px solid #333; background: linear-gradient(90deg, #000004, #51127c, #b73779, #fc8961, #fcfdbf); }}
  .section {{ margin-bottom: 36px; }}
  .section-label {{ font-size: 10px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; color: #c05030; margin-bottom: 4px; }}
  .section-title {{ font-size: 15px; font-weight: 400; color: #fff; margin-bottom: 6px; }}
  .section-desc {{ font-size: 12px; color: #888; max-width: 720px; margin-bottom: 14px; }}
  .hero {{ display: grid; grid-template-columns: 1.15fr 1fr; gap: 18px; }}
  @media (max-width: 980px) {{ .hero {{ grid-template-columns: 1fr; }} }}
  .panel {{ background: #141414; border: 1px solid #222; border-radius: 6px; overflow: hidden; display: flex; flex-direction: column; }}
  .panel-header {{ padding: 10px 14px; border-bottom: 1px solid #1f1f1f; display: flex; justify-content: space-between; align-items: baseline; }}
  .panel-title {{ font-size: 12px; font-weight: 500; color: #ddd; letter-spacing: 0.02em; }}
  .panel-sub {{ font-family: 'SF Mono', Menlo, monospace; font-size: 10px; color: #777; }}
  .panel-body {{ padding: 0; background: #000; display: flex; align-items: center; justify-content: center; min-height: 0; }}
  .panel-body img, .panel-body video {{ width: 100%; height: auto; display: block; }}
  .grid2 {{ display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }}
  @media (max-width: 720px) {{ .grid2 {{ grid-template-columns: 1fr; }} }}
  footer {{ padding: 24px 32px; border-top: 1px solid #1f1f1f; font-size: 11px; color: #666; font-family: 'SF Mono', Menlo, monospace; }}
</style>
</head>
<body>

<header>
  <div>
    <div class="eyebrow">feminist.it · stream table</div>
    <h1>Stream formation — Kinect color optical flow</h1>
  </div>
  <div class="meta">{args.fps} Hz · {args.width} px wide · Farneback dense flow · t = {args.t_start} → {args.t_end} s</div>
</header>

<main>

  <p class="description">
    Dense optical flow between consecutive Kinect color frames reveals where water actually moved on
    the sediment bed. The stream signature accumulates per-pixel motion magnitude across the entire
    run, weighted by how often that pixel had detectable flow — bright regions are persistent
    channels, not transient noise.
  </p>

  <div class="legend">
    <div class="legend-item"><span style="color:#aaa">direction</span><div class="hue-bar"></div></div>
    <div class="legend-item"><span style="color:#aaa">speed</span><span class="swatch" style="background:#000"></span><span style="color:#666">→</span><span class="swatch" style="background:#fff"></span><span style="color:#777">0 → {args.mag_max:.1f} px/fr</span></div>
    <div class="legend-item"><span style="color:#aaa">signature</span><div class="inferno-bar"></div><span style="color:#777">low → high</span></div>
  </div>

  <section class="section">
    <div class="section-label">primary results</div>
    <div class="section-title">Per-frame flow vs. accumulated stream signature</div>
    <div class="section-desc">Left: live optical flow overlaid on the bed (hue = direction, brightness = speed). Right: where water moved most over the entire run, painted onto the bed.</div>
    <div class="hero">
      <div class="panel">
        <div class="panel-header"><span class="panel-title">flow overlay (timeline)</span><span class="panel-sub">flow_overlay.mp4 · {args.fps} Hz</span></div>
        <div class="panel-body"><video controls loop autoplay muted playsinline src="flow_overlay.mp4"></video></div>
      </div>
      <div class="panel">
        <div class="panel-header"><span class="panel-title">stream signature on bed</span><span class="panel-sub">cumulative · inferno</span></div>
        <div class="panel-body"><img src="stream_signature.png" alt="stream signature on bed"></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="section-label">supporting maps</div>
    <div class="section-title">Signature alone & motion persistence</div>
    <div class="section-desc">Signature without the bed underneath isolates the channel network. Persistence shows what fraction of frames each pixel had detectable motion — a different read on the same data.</div>
    <div class="grid2">
      <div class="panel">
        <div class="panel-header"><span class="panel-title">stream signature (isolated)</span><span class="panel-sub">no underlay</span></div>
        <div class="panel-body"><img src="stream_signature_pure.png" alt="stream signature isolated"></div>
      </div>
      <div class="panel">
        <div class="panel-header"><span class="panel-title">flow persistence</span><span class="panel-sub">fraction of frames w/ motion · viridis</span></div>
        <div class="panel-body"><img src="persistence.png" alt="flow persistence"></div>
      </div>
    </div>
  </section>

</main>

<footer>Generated by scripts/optical_flow_streams.py · Kinect Azure depth_20260311_105209.mkv</footer>

</body>
</html>"""
    (OUT_DIR / "index.html").write_text(html)
    print(f"  → {(OUT_DIR/'index.html').relative_to(REPO)}")
    print(f"\nView: http://localhost:8765/calib/optical_flow/")

    if not args.keep_frames:
        for f in FRAME_DIR.glob("*.jpg"):
            f.unlink()
        FRAME_DIR.rmdir()
        for f in overlay_dir.glob("*.jpg"):
            f.unlink()


if __name__ == "__main__":
    main()
