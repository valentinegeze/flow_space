"""Triangulate 3D world positions of features clicked in 2+ phones.

Input: JSON file with clicks per feature per phone, of the form:
  {
    "feature_name_1": {
      "valentine": [u, v],
      "sophia":    [u, v],
      "javier":    [u, v]
    },
    "feature_name_2": {
      ...
    }
  }

Output: 3D world coords + per-camera reprojection residuals + closest-point-on-each-ray
stats for confidence.

Usage:
  python3 scripts/triangulate.py input.json                          # stdout report
  python3 scripts/triangulate.py input.json --out triangulated.json  # write output
  python3 scripts/triangulate.py --demo                              # run on synthetic data
"""
import json, sys, argparse
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pose_utils import load_pose, world_to_pixel


def projection_matrix(pose):
    """Return 3x4 P matrix such that (s*u, s*v, s) = P @ [X Y Z 1]ᵀ."""
    K = np.asarray(pose["K"], float)
    R = np.asarray(pose["R"], float)
    t = np.asarray(pose["t_mm"], float).reshape(3, 1)
    Rt = np.hstack([R, t])
    return K @ Rt


def triangulate_point(views):
    """Linear DLT triangulation from N ≥ 2 views.
    views: list of (pose, (u, v)) tuples.
    Returns (X_world 3-vector, residuals dict, mean reproj error in px).
    """
    if len(views) < 2:
        raise ValueError("Need at least 2 views for triangulation")
    A = []
    for pose, (u, v) in views:
        P = projection_matrix(pose)
        # Undistort uv if distortion present (iterative inverse)
        d = pose.get("dist_coeffs") or {}
        k1 = float(d.get("k1") or 0.0)
        k2 = float(d.get("k2") or 0.0)
        if k1 or k2:
            cx, cy = pose["K"][0][2], pose["K"][1][2]
            fx = pose["K"][0][0]
            x, y = (u - cx) / fx, (v - cy) / fx
            # Iteratively invert radial distortion
            x0, y0 = x, y
            for _ in range(6):
                r2 = x*x + y*y
                f = 1.0 + k1*r2 + k2*r2*r2
                x, y = x0 / f, y0 / f
            u = x * fx + cx
            v = y * fx + cy
        A.append(u * P[2] - P[0])
        A.append(v * P[2] - P[1])
    A = np.array(A)
    _, _, Vt = np.linalg.svd(A)
    Xh = Vt[-1]
    if abs(Xh[3]) < 1e-12:
        return None, {}, float("nan")
    X = Xh[:3] / Xh[3]
    residuals = {}
    errs = []
    for i, (pose, (u, v)) in enumerate(views):
        p = world_to_pixel(pose, X)
        label = pose.get("label", f"view{i}")
        if p is None:
            residuals[label] = {"u_meas": float(u), "v_meas": float(v), "u_proj": None, "v_proj": None, "err_px": float("inf"), "behind_camera": True}
            errs.append(float("inf"))
        else:
            err = float(np.hypot(p[0] - u, p[1] - v))
            residuals[label] = {"u_meas": float(u), "v_meas": float(v), "u_proj": float(p[0]), "v_proj": float(p[1]), "err_px": err, "behind_camera": False}
            errs.append(err)
    mean_err = float(np.mean([e for e in errs if np.isfinite(e)])) if any(np.isfinite(e) for e in errs) else float("inf")
    return X, residuals, mean_err


def run_demo():
    """Self-test: project a known 3D point with each pose, then re-triangulate."""
    print("=== Demo: triangulate a known world point from 3 synthetic clicks ===")
    poses = {label: load_pose(label) for label in ["valentine", "sophia", "javier"]}
    true_X = np.array([419.0, 965.0, 0.0])  # flume centre on bed
    views = []
    for label, pose in poses.items():
        p = world_to_pixel(pose, true_X)
        if p is None:
            print(f"  {label}: world point projects behind camera — skipping")
            continue
        pose_with_label = dict(pose); pose_with_label["label"] = label
        views.append((pose_with_label, (p[0], p[1])))
        print(f"  {label}: true_X → image ({p[0]:.1f}, {p[1]:.1f})")
    X, res, err = triangulate_point(views)
    print(f"\n  triangulated X = ({X[0]:.2f}, {X[1]:.2f}, {X[2]:.2f}) mm")
    print(f"  true_X         = ({true_X[0]:.2f}, {true_X[1]:.2f}, {true_X[2]:.2f}) mm")
    print(f"  diff           = {np.linalg.norm(X - true_X):.2f} mm")
    print(f"  mean reproj err = {err:.3f} px")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", nargs="?", help="path to clicks JSON")
    ap.add_argument("--out", help="path to write output JSON")
    ap.add_argument("--demo", action="store_true")
    args = ap.parse_args()

    if args.demo:
        run_demo()
        return
    if not args.input:
        ap.error("provide input JSON or --demo")

    input_path = Path(args.input)
    data = json.loads(input_path.read_text())
    poses_cache = {}

    results = {}
    for feature, clicks in data.items():
        views = []
        for label, uv in clicks.items():
            if label not in poses_cache:
                try:
                    poses_cache[label] = load_pose(label)
                    poses_cache[label]["label"] = label
                except FileNotFoundError:
                    print(f"[{feature}] no pose for {label}; skipping that view")
                    continue
            u, v = float(uv[0]), float(uv[1])
            views.append((poses_cache[label], (u, v)))
        if len(views) < 2:
            results[feature] = {"error": f"only {len(views)} view(s) — need ≥2"}
            continue
        X, res, err = triangulate_point(views)
        if X is None:
            results[feature] = {"error": "degenerate SVD"}
            continue
        results[feature] = {
            "world_xyz_mm": X.tolist(),
            "mean_reproj_err_px": err,
            "per_view_residuals": res,
            "num_views": len(views),
        }

    # Pretty-print
    for feat, r in results.items():
        print(f"\n=== {feat} ===")
        if "error" in r:
            print(f"  ERROR: {r['error']}")
            continue
        print(f"  world (X, Y, Z) = ({r['world_xyz_mm'][0]:.1f}, {r['world_xyz_mm'][1]:.1f}, {r['world_xyz_mm'][2]:.1f}) mm")
        print(f"  mean reprojection error: {r['mean_reproj_err_px']:.2f} px  (over {r['num_views']} views)")
        for view, rr in r["per_view_residuals"].items():
            if rr.get("behind_camera"):
                print(f"    {view:10s} BEHIND CAMERA")
            else:
                print(f"    {view:10s} meas=({rr['u_meas']:.1f},{rr['v_meas']:.1f}) proj=({rr['u_proj']:.1f},{rr['v_proj']:.1f}) err={rr['err_px']:.2f} px")

    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=2))
        print(f"\nWrote {args.out}")


if __name__ == "__main__":
    main()
