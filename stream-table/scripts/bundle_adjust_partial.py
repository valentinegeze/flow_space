"""Partial BA: fix valentine+sophia poses (from manual tune), only optimize anna, kinect,
and feature 3D positions. Dramatically better conditioned than full BA when few features.

Usage: python3 scripts/bundle_adjust_partial.py
"""
import cv2, json, sys
import numpy as np
from pathlib import Path
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pose_utils import load_pose

REPO = Path(__file__).resolve().parent.parent

FIXED_PHONES = ["valentine", "sophia"]
SOLVE_PHONES = ["anna", "kinect"]

DEFAULT_DIMS = {"anna": (720, 1280), "kinect": (1080, 1920)}
DEFAULT_FX = {"anna": 480.0, "kinect": 504.0}
EXPECTED_ROLL_DEG = {"anna": 0.0, "kinect": 0.0}


def project(fx, R, t, Xw, cx, cy):
    Xc = R @ Xw + t
    if Xc[2] <= 1e-6: return np.array([np.nan, np.nan])
    return np.array([fx*Xc[0]/Xc[2] + cx, fx*Xc[1]/Xc[2] + cy])


def roll_from_R(R):
    zc = np.array([R[2][0], R[2][1], R[2][2]])
    down = np.array([0.0, 0.0, -1.0])
    xnr = np.cross(down, zc); n = np.linalg.norm(xnr)
    if n < 1e-9: return 0.0
    xnr /= n; ynr = np.cross(zc, xnr); ynr /= np.linalg.norm(ynr)
    xa = np.array([R[0][0], R[1][0], R[2][0]])
    return float(np.degrees(np.arctan2(np.dot(xa, ynr), np.dot(xa, xnr))))


def pack(solve_poses, features):
    params = []
    for label in SOLVE_PHONES:
        p = solve_poses[label]
        rvec = Rotation.from_matrix(p["R"]).as_rotvec()
        params.extend([p["fx"], *rvec, *p["t"]])
    for xyz in features:
        params.extend(xyz)
    return np.array(params, float)


def unpack(params, n_features):
    solve_poses = {}
    i = 0
    for label in SOLVE_PHONES:
        fx = params[i]; i += 1
        rvec = params[i:i+3]; i += 3
        t = params[i:i+3]; i += 3
        solve_poses[label] = {"fx": fx, "R": Rotation.from_rotvec(rvec).as_matrix(), "t": np.asarray(t)}
    features = [np.asarray(params[i+3*k:i+3*k+3]) for k in range(n_features)]
    return solve_poses, features


def residuals(params, fixed_poses, observations, n_features, cx_cy):
    solve_poses, features = unpack(params, n_features)
    all_poses = {**fixed_poses, **solve_poses}
    res = []
    for (label, feat_idx, u, v) in observations:
        p = all_poses[label]
        cx, cy = cx_cy[label]
        proj = project(p["fx"], p["R"], p["t"], features[feat_idx], cx, cy)
        if np.isnan(proj[0]):
            res.extend([1e3, 1e3])
        else:
            res.append((proj[0] - u) / 2.0)  # reproj sigma = 2 px
            res.append((proj[1] - v) / 2.0)
    # Tight fx priors on the solve phones
    for label in SOLVE_PHONES:
        p = solve_poses[label]
        res.append((p["fx"] - DEFAULT_FX[label]) / 15.0)
        # Roll anchor
        delta = roll_from_R(p["R"]) - EXPECTED_ROLL_DEG[label]
        while delta > 180: delta -= 360
        while delta < -180: delta += 360
        res.append(delta / 3.0)
        # Soft cheirality: Cz above 100 mm
        C = -p["R"].T @ p["t"]
        res.append(max(0.0, 100.0 - float(C[2])) / 30.0)
        # Soft: camera within a reasonable box around flume (|Cx|, |Cy| < 5000)
        res.append(max(0.0, abs(C[0]) - 5000.0) / 200.0)
        res.append(max(0.0, abs(C[1]) - 5000.0) / 200.0)
    return np.array(res)


def main():
    data = json.loads((REPO / "calib" / "cross_features_merged.json").read_text())
    feat_in = data["features"]
    n_features = len(feat_in)

    # Load fixed poses
    fixed_poses = {}
    cx_cy = {}
    for label in FIXED_PHONES:
        p = load_pose(label)
        fixed_poses[label] = {
            "fx": float(p["K"][0][0]),
            "R": np.asarray(p["R"], float),
            "t": np.asarray(p["t_mm"], float),
        }
        cx_cy[label] = (float(p["K"][0][2]), float(p["K"][1][2]))
        C = -fixed_poses[label]["R"].T @ fixed_poses[label]["t"]
        print(f"FIXED {label}: fx={fixed_poses[label]['fx']:.0f}, C={C.tolist()}")

    for label in SOLVE_PHONES:
        W, H = DEFAULT_DIMS[label]
        cx_cy[label] = (W/2.0, H/2.0)

    # Observations (all views)
    observations = []
    for feat_idx, f in enumerate(feat_in):
        for label, uv in f["clicks_per_phone"].items():
            if label in fixed_poses or label in SOLVE_PHONES:
                observations.append((label, feat_idx, float(uv[0]), float(uv[1])))
    print(f"\n{len(observations)} observations, {n_features} features")

    # Stage 1: triangulate each feature from FIXED views (valentine+sophia)
    def triangulate(uv_by_label):
        rows = []
        for lbl, uv in uv_by_label.items():
            if lbl not in fixed_poses: continue
            p = fixed_poses[lbl]
            K = np.array([[p["fx"], 0, cx_cy[lbl][0]], [0, p["fx"], cx_cy[lbl][1]], [0, 0, 1]])
            P = K @ np.hstack([p["R"], p["t"].reshape(3, 1)])
            u, v = uv
            rows.append(u * P[2] - P[0])
            rows.append(v * P[2] - P[1])
        if len(rows) < 4: return None
        A = np.array(rows); _, _, Vt = np.linalg.svd(A)
        Xh = Vt[-1]; return Xh[:3] / Xh[3] if abs(Xh[3]) > 1e-12 else None

    feat_init = []
    for f in feat_in:
        X = triangulate(f["clicks_per_phone"])
        feat_init.append(X.tolist() if X is not None else [419.0, 965.0, 0.0])
    print(f"\nTriangulated features from {FIXED_PHONES}:")
    for f, X in zip(feat_in, feat_init):
        print(f"  {f['name']:8s}  ({X[0]:+7.0f},{X[1]:+7.0f},{X[2]:+6.0f})")

    # Stage 2: PnP-solve anna and kinect
    solve_poses = {}
    for label in SOLVE_PHONES:
        obj_pts, img_pts = [], []
        for idx, f in enumerate(feat_in):
            if label in f["clicks_per_phone"]:
                obj_pts.append(feat_init[idx])
                img_pts.append(f["clicks_per_phone"][label])
        obj_pts = np.array(obj_pts, dtype=np.float32)
        img_pts = np.array(img_pts, dtype=np.float32)
        fx = DEFAULT_FX[label]
        W, H = DEFAULT_DIMS[label]
        K = np.array([[fx, 0, W/2], [0, fx, H/2], [0, 0, 1]], dtype=np.float32)
        flag = cv2.SOLVEPNP_EPNP if len(obj_pts) < 6 else cv2.SOLVEPNP_ITERATIVE
        ok, rvec, tvec = cv2.solvePnP(obj_pts, img_pts, K, None, flags=flag)
        if ok:
            R = cv2.Rodrigues(rvec)[0]; t = tvec.flatten()
            C = -R.T @ t
            solve_poses[label] = {"fx": fx, "R": R, "t": t}
            print(f"PnP [{label}]: C={C.tolist()}, fx={fx:.0f} ({len(obj_pts)} pts, flag={'EPNP' if flag==cv2.SOLVEPNP_EPNP else 'iterative'})")
        else:
            print(f"PnP [{label}]: FAILED")
            return

    # Before BA stats
    def compute_stats(sp, fp, features):
        all_p = {**fp, **sp}
        per = {l: [] for l in list(fp) + list(sp)}
        for (label, idx, u, v) in observations:
            p = all_p[label]; cx, cy = cx_cy[label]
            pr = project(p["fx"], p["R"], p["t"], features[idx], cx, cy)
            per[label].append(np.hypot(pr[0]-u, pr[1]-v) if not np.isnan(pr[0]) else float("inf"))
        return per

    print("\nBefore BA:")
    per_before = compute_stats(solve_poses, fixed_poses, [np.asarray(f) for f in feat_init])
    for l, errs in per_before.items():
        valid = [e for e in errs if np.isfinite(e)]
        if valid: print(f"  {l:10s} mean={np.mean(valid):6.1f} max={np.max(valid):6.1f} (n={len(valid)})")

    # Run BA
    x0 = pack(solve_poses, feat_init)
    print(f"\nRunning BA on {len(SOLVE_PHONES)*7 + n_features*3} unknowns…")
    result = least_squares(
        residuals, x0,
        args=(fixed_poses, observations, n_features, cx_cy),
        method="lm", max_nfev=30000, xtol=1e-10, ftol=1e-10)
    print(f"Converged: {result.message}  nfev={result.nfev}  cost={result.cost:.2f}")

    sp_out, feats_out = unpack(result.x, n_features)
    per_after = compute_stats(sp_out, fixed_poses, feats_out)
    print("\nAfter BA:")
    for l, errs in per_after.items():
        valid = [e for e in errs if np.isfinite(e)]
        if valid: print(f"  {l:10s} mean={np.mean(valid):6.1f} max={np.max(valid):6.1f} (n={len(valid)})")

    print("\nRefined feature 3D (mm):")
    for f, X in zip(feat_in, feats_out):
        in_flume = (-200<=X[0]<=1100) and (-200<=X[1]<=2100) and (-400<=X[2]<=200)
        print(f"  {f['name']:8s}  ({X[0]:+7.0f},{X[1]:+7.0f},{X[2]:+6.0f})  {'[in flume]' if in_flume else '[out]'}")

    print("\nSolved poses for anna + kinect:")
    for label, p in sp_out.items():
        C = -p["R"].T @ p["t"]
        zc = p["R"][2]
        pitch = float(np.degrees(np.arcsin(np.clip(zc[2], -1, 1))))
        yaw = float(np.degrees(np.arctan2(zc[1], zc[0])))
        roll = roll_from_R(p["R"])
        out_path = REPO / "calib" / f"pose_{label}_partial.json"
        out_path.write_text(json.dumps({
            "label": label, "session": 1, "method": "bundle_adjust_partial_round2_clack60s",
            "K": [[float(p["fx"]), 0, cx_cy[label][0]], [0, float(p["fx"]), cx_cy[label][1]], [0, 0, 1]],
            "R": p["R"].tolist(), "t_mm": p["t"].tolist(),
            "camera_center_world_mm": C.tolist(),
            "euler_deg": {"yaw": yaw, "pitch": pitch, "roll": roll},
            "fx_px": float(p["fx"]),
            "dist_coeffs": {"k1": 0, "k2": 0},
            "notes": [f"Partial BA with valentine+sophia fixed; {n_features} features; mean reproj {np.mean([e for e in per_after[label] if np.isfinite(e)]):.1f} px"],
        }, indent=2))
        print(f"  {out_path.relative_to(REPO)}  fx={p['fx']:.0f}  C={C.tolist()}  roll={roll:.1f}°")


if __name__ == "__main__":
    main()
