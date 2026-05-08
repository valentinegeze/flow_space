"""Shared utilities for working with solved phone poses.

Provides:
  load_pose(label)                 — load calib/pose_<label>.json
  world_to_pixel(pose, Xw)         — project 3D world point to image (u, v)
  pixel_to_world_ray(pose, u, v)   — back-project image pixel to a world-frame ray (origin, dir)
  draw_wireframe(img, pose)        — overlay flume wireframe on an OpenCV BGR image
  WORLD                             — dict of schema landmarks → (X, Y, Z) in mm
  WIREFRAME_EDGES                   — list of (endpointA, endpointB, RGB) edges for the wireframe

Convention: X_cam = R @ X_world + t.  Z+ = UP in world.  Image pixels (u, v) with v increasing
downward.  Distortion (k1, k2) is applied to *normalised* image coords if present in the pose.
"""
import json
import numpy as np
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

WORLD = {
    "rim_NW":         (0,   0,    0),
    "rim_NE":         (838, 0,    0),
    "rim_SW":         (0,   1930, 0),
    "rim_SE":         (838, 1930, 0),
    "standpipe_base": (419, 1900, 0),
    "standpipe_top":  (419, 1900, 60),
    "edu_midpoint":   (419, 30,   127),
    "rib_W_upper":    (0,   343,  0),
    "rib_E_upper":    (838, 343,  0),
    "rib_W_lower":    (0,   1588, 0),
    "rib_E_lower":    (838, 1588, 0),  # hypothetical (not in schema but used for wireframe)
}

# (landmark_A, landmark_B, (R, G, B))
WIREFRAME_EDGES = [
    ("rim_NW", "rim_NE", (255, 70, 70)),
    ("rim_NE", "rim_SE", (255, 70, 70)),
    ("rim_SE", "rim_SW", (255, 70, 70)),
    ("rim_SW", "rim_NW", (255, 70, 70)),
    ("rib_W_upper", "rib_E_upper", (70, 170, 255)),
    ("rib_W_lower", "rib_E_lower", (70, 255, 140)),
    ("standpipe_base", "standpipe_top", (255, 220, 70)),
]


def load_pose(label):
    """Load calib/pose_<label>.json, return dict with numpy arrays."""
    p = REPO / "calib" / f"pose_{label}.json"
    if not p.exists():
        raise FileNotFoundError(f"No pose file: {p}")
    return json.loads(p.read_text())


def world_to_pixel(pose, Xw):
    """Project a 3D world point (mm) to image pixel (u, v).

    Returns None if the point is behind the camera.
    """
    R = np.asarray(pose["R"], float)
    t = np.asarray(pose["t_mm"], float)
    K = np.asarray(pose["K"], float)
    Xc = R @ np.asarray(Xw, float) + t
    if Xc[2] <= 0:
        return None
    x = Xc[0] / Xc[2]
    y = Xc[1] / Xc[2]
    d = pose.get("dist_coeffs") or {}
    k1 = float(d.get("k1") or 0.0)
    k2 = float(d.get("k2") or 0.0)
    if k1 or k2:
        r2 = x * x + y * y
        f = 1.0 + k1 * r2 + k2 * r2 * r2
        x *= f
        y *= f
    return np.array([K[0, 0] * x + K[0, 2], K[1, 1] * y + K[1, 2]])


def pixel_to_world_ray(pose, u, v):
    """Back-project an image pixel (u, v) to a world-frame ray.

    Returns (origin_world, direction_world_unit). Does NOT apply inverse distortion
    (small effect for mild k1 and pose-level use — can be added iteratively if needed).
    """
    R = np.asarray(pose["R"], float)
    t = np.asarray(pose["t_mm"], float)
    K = np.asarray(pose["K"], float)
    Kinv = np.linalg.inv(K)
    # Ray direction in camera frame (z=1 plane)
    d_cam = Kinv @ np.array([float(u), float(v), 1.0])
    # Rotate to world frame. X_cam = R @ X_world + t means X_world = R.T @ (X_cam - t)
    # Direction in world = R.T @ d_cam (no translation for direction vectors)
    d_world = R.T @ d_cam
    d_world = d_world / np.linalg.norm(d_world)
    C = -R.T @ t  # camera centre in world
    return C, d_world


def draw_wireframe(img, pose, thickness=3, dot_radius=6, label_landmarks=False):
    """Overlay flume wireframe on an OpenCV BGR image (modifies in place, returns img)."""
    import cv2
    proj = {}
    for name, Xw in WORLD.items():
        proj[name] = world_to_pixel(pose, Xw)
    # Edges
    for a, b, rgb in WIREFRAME_EDGES:
        pa, pb = proj.get(a), proj.get(b)
        if pa is None or pb is None:
            continue
        bgr = (int(rgb[2]), int(rgb[1]), int(rgb[0]))
        cv2.line(img,
                 (int(round(pa[0])), int(round(pa[1]))),
                 (int(round(pb[0])), int(round(pb[1]))),
                 bgr, thickness)
    # Dots
    for name, p in proj.items():
        if p is None:
            continue
        x, y = int(round(p[0])), int(round(p[1]))
        cv2.circle(img, (x, y), dot_radius + 2, (0, 0, 0), -1)
        cv2.circle(img, (x, y), dot_radius, (255, 255, 255), -1)
        if label_landmarks:
            cv2.putText(img, name, (x + 8, y - 8), cv2.FONT_HERSHEY_SIMPLEX,
                        0.6, (255, 255, 255), 2, cv2.LINE_AA)
            cv2.putText(img, name, (x + 8, y - 8), cv2.FONT_HERSHEY_SIMPLEX,
                        0.6, (0, 0, 0), 1, cv2.LINE_AA)
    return img


# CLI self-test / quick projection dump
if __name__ == "__main__":
    import sys
    labels = sys.argv[1:] or ["valentine", "sophia", "javier"]
    for label in labels:
        try:
            pose = load_pose(label)
        except FileNotFoundError as e:
            print(f"{label}: {e}")
            continue
        print(f"\n=== {label} ===")
        print(f"fx = {pose['fx_px']:.1f}   C = {pose['camera_center_world_mm']}")
        for name, Xw in WORLD.items():
            p = world_to_pixel(pose, Xw)
            if p is None:
                print(f"  {name:16s} world={Xw}  → BEHIND camera")
            else:
                W = pose["K"][0][2] * 2
                H = pose["K"][1][2] * 2
                tag = "[in frame]" if 0 <= p[0] < W and 0 <= p[1] < H else "[off-frame]"
                print(f"  {name:16s} world={Xw}  → image=({p[0]:7.1f},{p[1]:7.1f}) {tag}")
