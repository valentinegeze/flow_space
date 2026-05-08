"""Extract a Kinect depth frame and convert to a 3D point cloud (in Kinect frame).

Uses ffmpeg to pull a single raw depth frame from the MKV (track 0:1, 640×576 uint16),
applies approximate Kinect depth intrinsics, and writes a PLY file you can open in
MeshLab, CloudCompare, Blender, or similar.

Optionally textures each point with the color value at the approximately-aligned color
pixel (uses coarse rescaling — not sub-mm accurate but visually useful).

Usage:
  python3 scripts/kinect_depth_pointcloud.py                  # clack+60s, uncolored
  python3 scripts/kinect_depth_pointcloud.py --t 87.4         # specific timestamp
  python3 scripts/kinect_depth_pointcloud.py --color          # texture with aligned color
  python3 scripts/kinect_depth_pointcloud.py --downsample 4   # 1 in N pixels
"""
import subprocess, json, sys, argparse
import numpy as np
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MKV = REPO / "videos" / "depth_20260311_105209.mkv"

# Depth-camera intrinsics at 640×576 (approximate — scaled from factory 1024×1024 values).
# K4A NFOV_UNBINNED mode crops the 1024×1024 sensor to 640×576; fx, fy stay the same in px.
# Principal point shifts due to crop.
# Factory at 1024×1024: fx=505.0, fy=505.2, cx=498.3, cy=521.2.
# Approximate crop offset (symmetric about centre): (1024-640)/2 = 192 in x, (1024-576)/2 = 224 in y.
# So cx_640 ≈ 498.3 - 192 = 306.3, cy_576 ≈ 521.2 - 224 = 297.2.
DEPTH_FX = 505.0
DEPTH_FY = 505.2
DEPTH_CX = 306.3
DEPTH_CY = 297.2
DEPTH_W, DEPTH_H = 640, 576


def extract_depth_frame(t_seconds, out_path):
    """Extract one raw depth frame (uint16 little-endian) from the Kinect MKV."""
    cmd = [
        "ffmpeg", "-y", "-ss", f"{t_seconds}", "-i", str(MKV),
        "-map", "0:1", "-frames:v", "1",
        "-c:v", "rawvideo", "-pix_fmt", "gray16le",
        "-f", "rawvideo", str(out_path),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {res.stderr[-500:]}")
    return out_path


def extract_color_frame(t_seconds, out_path):
    cmd = [
        "ffmpeg", "-y", "-ss", f"{t_seconds}", "-i", str(MKV),
        "-map", "0:0", "-frames:v", "1", str(out_path),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg color extract failed: {res.stderr[-500:]}")
    return out_path


def depth_to_pointcloud(depth, downsample=1):
    """Unproject a HxW uint16 depth image (mm values) to Nx3 point cloud in Kinect depth frame."""
    H, W = depth.shape
    u = np.arange(W)[::downsample]
    v = np.arange(H)[::downsample]
    uu, vv = np.meshgrid(u, v)
    zz = depth[::downsample, ::downsample].astype(np.float32)
    valid = zz > 0
    uu, vv, zz = uu[valid], vv[valid], zz[valid]
    X = (uu - DEPTH_CX) * zz / DEPTH_FX
    Y = (vv - DEPTH_CY) * zz / DEPTH_FY
    Z = zz
    return np.column_stack([X, Y, Z]), (uu, vv)


def write_ply(path, points, colors=None):
    with open(path, "w") as f:
        f.write("ply\nformat ascii 1.0\n")
        f.write(f"element vertex {len(points)}\n")
        f.write("property float x\nproperty float y\nproperty float z\n")
        if colors is not None:
            f.write("property uchar red\nproperty uchar green\nproperty uchar blue\n")
        f.write("end_header\n")
        if colors is None:
            for p in points:
                f.write(f"{p[0]:.2f} {p[1]:.2f} {p[2]:.2f}\n")
        else:
            for p, c in zip(points, colors):
                f.write(f"{p[0]:.2f} {p[1]:.2f} {p[2]:.2f} {c[0]} {c[1]} {c[2]}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--t", type=float, default=87.4, help="timestamp in kinect MKV (seconds)")
    ap.add_argument("--color", action="store_true", help="texture with aligned color (coarse)")
    ap.add_argument("--downsample", type=int, default=2)
    ap.add_argument("--out", type=str, default=None)
    args = ap.parse_args()

    raw = Path("/tmp/kinect_depth.raw")
    print(f"Extracting depth at t={args.t:.2f}s …")
    extract_depth_frame(args.t, raw)
    depth = np.fromfile(raw, dtype=np.uint16).reshape(DEPTH_H, DEPTH_W)
    valid = (depth > 0).sum()
    print(f"  {DEPTH_W}×{DEPTH_H} depth frame, {valid}/{depth.size} valid pixels ({100*valid/depth.size:.1f}%)")
    print(f"  depth range: min={depth[depth>0].min()} mm, max={depth.max()} mm, median={np.median(depth[depth>0]):.0f} mm")

    points, (uu, vv) = depth_to_pointcloud(depth, downsample=args.downsample)
    print(f"\nPoint cloud: {len(points)} points (downsample={args.downsample})")
    print(f"  X range: [{points[:,0].min():.0f}, {points[:,0].max():.0f}] mm")
    print(f"  Y range: [{points[:,1].min():.0f}, {points[:,1].max():.0f}] mm")
    print(f"  Z range: [{points[:,2].min():.0f}, {points[:,2].max():.0f}] mm (depth = distance from Kinect)")

    colors = None
    if args.color:
        import cv2
        color_path = Path("/tmp/kinect_color.jpg")
        extract_color_frame(args.t, color_path)
        color_img = cv2.imread(str(color_path))
        color_H, color_W = color_img.shape[:2]
        # Coarse alignment: scale depth pixel (u, v) to color pixel. 1920×1080 color vs 640×576 depth.
        sx = color_W / DEPTH_W
        sy = color_H / DEPTH_H
        colors = []
        for (u_d, v_d) in zip(uu, vv):
            u_c = min(int(u_d * sx), color_W - 1)
            v_c = min(int(v_d * sy), color_H - 1)
            b, g, r = color_img[v_c, u_c]
            colors.append((r, g, b))
        colors = np.array(colors, dtype=np.uint8)
        print(f"  textured with color from {color_W}×{color_H} color frame")

    out = Path(args.out) if args.out else REPO / "calib" / f"kinect_pointcloud_t{args.t:.0f}.ply"
    write_ply(out, points, colors)
    size_mb = out.stat().st_size / 1e6
    print(f"\nSaved {out.relative_to(REPO)}  ({size_mb:.1f} MB)")
    print("Open in MeshLab, CloudCompare, Blender, or similar.")


if __name__ == "__main__":
    main()
