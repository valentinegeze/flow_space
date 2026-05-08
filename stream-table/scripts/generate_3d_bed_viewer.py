"""Generate an interactive 3D viewer of the stream-table bed over time.

Uses Plotly to build a single-file HTML with:
  - 3D surface of the bed elevation (from Kinect depth)
  - Time slider: scrub through N timestamps
  - Mouse-controlled rotate / pan / zoom

Output: calib/kinect_3d_bed.html — portable standalone, no dependencies.

Usage:
  python3 scripts/generate_3d_bed_viewer.py
  python3 scripts/generate_3d_bed_viewer.py --timestamps 27.4,87.4,147.4,207.4
  python3 scripts/generate_3d_bed_viewer.py --downsample 4
"""
import subprocess, argparse
from pathlib import Path
import numpy as np

REPO = Path(__file__).resolve().parent.parent
MKV = REPO / "videos" / "depth_20260311_105209.mkv"

DEPTH_W, DEPTH_H = 640, 576
DEPTH_FX = 505.0; DEPTH_FY = 505.2; DEPTH_CX = 306.3; DEPTH_CY = 297.2
BED_MIN = 700; BED_MAX = 850


def extract_depth(t):
    out = Path(f"/tmp/d3d_{t:.2f}.raw")
    cmd = ["ffmpeg", "-y", "-ss", f"{t}", "-i", str(MKV),
           "-map", "0:1", "-frames:v", "1",
           "-c:v", "rawvideo", "-pix_fmt", "gray16le", "-f", "rawvideo", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        return None
    arr = np.fromfile(out, dtype=np.uint16)
    return arr.reshape(DEPTH_H, DEPTH_W) if arr.size == DEPTH_W * DEPTH_H else None


def depth_to_heightmap(depth, downsample=4):
    """Convert Kinect depth (mm from camera) into a height grid in world-like coords.
    Height = (bed_max - depth) so 'taller' values are higher sediment.
    Pixels outside bed range → NaN (rendered as holes in the surface).

    Returns X (mm grid), Y (mm grid), Z (mm height) arrays.
    """
    d = depth[::downsample, ::downsample].astype(np.float32)
    valid = (d > 0) & (d >= BED_MIN) & (d <= BED_MAX)
    H, W = d.shape
    # Compute per-pixel XY in Kinect camera frame (at its own depth) for correct perspective scaling
    u, v = np.meshgrid(np.arange(W), np.arange(H))
    # Account for the downsample in the pixel coordinates back to the original image
    u_orig = u * downsample
    v_orig = v * downsample
    # Project each depth pixel to world-frame X, Y (mm) via depth intrinsics
    X = np.where(valid, (u_orig - DEPTH_CX) * d / DEPTH_FX, np.nan)
    Y = np.where(valid, (v_orig - DEPTH_CY) * d / DEPTH_FY, np.nan)
    # "Height" = how close to the Kinect (higher bed = closer = smaller depth)
    Z = np.where(valid, BED_MAX - d, np.nan)
    return X, Y, Z


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timestamps", type=str, default=None,
                    help="comma-separated list of timestamps; overrides --start/--end/--step")
    ap.add_argument("--start", type=float, default=30.0,
                    help="first timestamp in seconds (Kinect MKV time). Default 30 (just past clack at 27.4s).")
    ap.add_argument("--end", type=float, default=235.0,
                    help="last timestamp. Default 235 (near end of Kinect recording at 237.9s).")
    ap.add_argument("--step", type=float, default=3.0,
                    help="interval between sampled timestamps in seconds. Default 3s.")
    ap.add_argument("--downsample", type=int, default=5,
                    help="downsample depth grid; higher = smaller file + faster rotation. Default 5.")
    ap.add_argument("--out", type=str, default="calib/kinect_3d_bed.html")
    args = ap.parse_args()

    try:
        import plotly.graph_objects as go
    except ImportError:
        print("plotly not installed. Install with: pip install plotly")
        return

    if args.timestamps:
        timestamps = [float(t.strip()) for t in args.timestamps.split(",")]
    else:
        timestamps = []
        t = args.start
        while t <= args.end:
            timestamps.append(round(t, 1))
            t += args.step
    print(f"Generating 3D viewer for {len(timestamps)} timestamps "
          f"(from {timestamps[0]:.1f}s to {timestamps[-1]:.1f}s, step={args.step}s), "
          f"downsample={args.downsample}")

    frames = []
    for t in timestamps:
        d = extract_depth(t)
        if d is None:
            print(f"  t={t:.1f}s: extraction failed"); continue
        X, Y, Z = depth_to_heightmap(d, args.downsample)
        frames.append({"t": t, "X": X, "Y": Y, "Z": Z})
        valid = ~np.isnan(Z)
        print(f"  t={t:.1f}s: Z range [{np.nanmin(Z):.0f}, {np.nanmax(Z):.0f}] mm, {valid.sum()} valid cells")

    # Initial frame
    f0 = frames[0]
    surf = go.Surface(
        x=f0["X"], y=f0["Y"], z=f0["Z"],
        colorscale="Turbo",
        cmin=0, cmax=BED_MAX - BED_MIN,
        colorbar=dict(title=dict(text="Height above<br>max depth (mm)"), x=1.02),
        lighting=dict(ambient=0.5, diffuse=0.8, specular=0.2),
        contours=dict(z=dict(show=True, usecolormap=False, color="rgba(0,0,0,0.25)", width=1, project=dict(z=False))),
        hovertemplate="X: %{x:.0f} mm<br>Y: %{y:.0f} mm<br>height: %{z:.0f} mm<extra></extra>",
    )

    fig = go.Figure(data=[surf])

    # Build animation frames
    fig.frames = [
        go.Frame(
            data=[go.Surface(x=fd["X"], y=fd["Y"], z=fd["Z"], colorscale="Turbo",
                             cmin=0, cmax=BED_MAX - BED_MIN)],
            name=f"t{fd['t']:.0f}",
        )
        for fd in frames
    ]

    # Slider + play button
    slider = dict(
        active=0,
        currentvalue=dict(prefix="t = ", suffix=" s", font=dict(size=14)),
        pad=dict(t=50),
        steps=[
            dict(method="animate",
                 args=[[f"t{fd['t']:.0f}"],
                       dict(mode="immediate", frame=dict(duration=300, redraw=True), transition=dict(duration=0))],
                 label=f"{fd['t']:.0f}")
            for fd in frames
        ],
    )

    fig.update_layout(
        title=dict(text="Stream-table bed topography (Kinect, interactive 3D)",
                   font=dict(size=16)),
        scene=dict(
            xaxis=dict(title="X (mm, Kinect frame)"),
            yaxis=dict(title="Y (mm)", autorange="reversed"),
            zaxis=dict(title="Height above deepest bed (mm)", range=[0, BED_MAX - BED_MIN]),
            aspectmode="data",
            camera=dict(eye=dict(x=1.2, y=1.2, z=1.2)),
        ),
        sliders=[slider],
        updatemenus=[dict(
            type="buttons", x=0.1, y=0, xanchor="right", yanchor="top",
            pad=dict(t=50, r=10),
            buttons=[
                dict(label="▶ Play",  method="animate",
                     args=[None, dict(frame=dict(duration=500, redraw=True), fromcurrent=True,
                                      mode="immediate", transition=dict(duration=0))]),
                dict(label="⏸ Pause", method="animate",
                     args=[[None], dict(frame=dict(duration=0, redraw=False), mode="immediate",
                                        transition=dict(duration=0))]),
            ],
        )],
        margin=dict(l=10, r=10, t=60, b=10),
    )

    out = REPO / args.out
    fig.write_html(str(out), include_plotlyjs=True, full_html=True)
    size_mb = out.stat().st_size / 1e6
    print(f"\nSaved {out.relative_to(REPO)}  ({size_mb:.1f} MB)")
    print(f"Open directly: file://{out}")
    print(f"Or via server: http://127.0.0.1:8765/{out.relative_to(REPO)}")


if __name__ == "__main__":
    main()
