"""Bundle adjust N cameras (any subset of anna, valentine, sophia, javier, kinect),
using feature clicks from cross-project. Phones with existing pose_<label>.json act as
priors; those without get solved from scratch.

Inputs:
  calib/cross_features_merged.json  — the features + per-phone clicks
Output:
  calib/pose_<label>_refined.json  — one per phone that was in the BA
  calib/bundle_adjust_v2_report.md

Usage:
  python3 scripts/bundle_adjust_v2.py
  python3 scripts/bundle_adjust_v2.py --features other.json
  python3 scripts/bundle_adjust_v2.py --bed-prior --bed-sigma 30
"""
import json, sys, argparse
import numpy as np
from pathlib import Path
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pose_utils import load_pose

REPO = Path(__file__).resolve().parent.parent

# Default image dimensions per phone (W, H) in their stored orientation.
# Needed for phones without a prior pose to initialise K.
DEFAULT_DIMS = {
    "anna":      (720, 1280),
    "valentine": (1080, 1920),
    "sophia":    (1080, 1920),
    "javier":    (1920, 1080),   # after 90° CCW rotation
    "kinect":    (1080, 1920),   # after 90° CW rotation
}

# Expected roll per phone (for constraint). All rotations applied on disk → roll=0 expected.
EXPECTED_ROLL_DEG = {
    "anna":      0.0,
    "valentine": 0.0,
    "sophia":    0.0,
    "javier":    0.0,
    "kinect":    0.0,
}
ROLL_SIGMA_DEG = 3.0

# Default fx guess when no prior pose exists, in pixels.
DEFAULT_FX = {
    "anna":      480.0,
    "valentine": 780.0,
    "sophia":    763.0,
    "javier":    1576.0,
    "kinect":    504.0,   # Kinect RGB factory fx (scaled later to extracted res)
}


def roll_from_R(R):
    zc = np.array([R[2][0], R[2][1], R[2][2]])
    down = np.array([0.0, 0.0, -1.0])
    xnr = np.cross(down, zc)
    n = np.linalg.norm(xnr)
    if n < 1e-9:
        return 0.0
    xnr /= n
    ynr = np.cross(zc, xnr); ynr /= np.linalg.norm(ynr)
    xa = np.array([R[0][0], R[1][0], R[2][0]])
    return float(np.degrees(np.arctan2(np.dot(xa, ynr), np.dot(xa, xnr))))


def project_simple(fx, R, t, Xw, cx, cy):
    Xc = R @ Xw + t
    if Xc[2] <= 1e-6:
        return np.array([np.nan, np.nan])
    return np.array([fx*Xc[0]/Xc[2] + cx, fx*Xc[1]/Xc[2] + cy])


def pack(poses_init, features):
    params = []
    for label, p in poses_init.items():
        fx = p["fx"]
        rvec = Rotation.from_matrix(p["R"]).as_rotvec()
        t = p["t"]
        params.extend([fx, *rvec, *t])
    for xyz in features:
        params.extend(xyz)
    return np.array(params, float)


def unpack(params, labels, n_features):
    poses = {}
    i = 0
    for label in labels:
        fx = params[i]; i += 1
        rvec = params[i:i+3]; i += 3
        t = params[i:i+3]; i += 3
        R = Rotation.from_rotvec(rvec).as_matrix()
        poses[label] = {"fx": fx, "R": R, "t": np.asarray(t)}
    features = []
    for _ in range(n_features):
        features.append(np.asarray(params[i:i+3])); i += 3
    return poses, features


def residuals(params, labels, observations, n_features, priors, cx_cy, sigmas, bed_prior):
    poses, features = unpack(params, labels, n_features)
    res = []
    for (label, feat_idx, u, v) in observations:
        p = poses[label]
        cx, cy = cx_cy[label]
        proj = project_simple(p["fx"], p["R"], p["t"], features[feat_idx], cx, cy)
        if np.isnan(proj[0]):
            res.extend([1e3, 1e3])
        else:
            res.append((proj[0] - u) / sigmas["reproj"])
            res.append((proj[1] - v) / sigmas["reproj"])
    for label in labels:
        p_cur = poses[label]
        pr = priors.get(label)
        if pr is not None:
            res.append((p_cur["fx"] - pr["fx"]) / sigmas["fx"])
            rvec_cur = Rotation.from_matrix(p_cur["R"]).as_rotvec()
            for j in range(3):
                res.append((rvec_cur[j] - pr["rvec"][j]) / sigmas["rvec"])
                res.append((p_cur["t"][j] - pr["t"][j]) / sigmas["t"])
        else:
            # No pose prior → still use a TIGHT fx prior from DEFAULT_FX so fx can't blow up
            fx_target = DEFAULT_FX.get(label, 780.0)
            res.append((p_cur["fx"] - fx_target) / 30.0)  # σ=30 px, tight
        # Roll anchor always applied (pose_tune.html convention)
        rt = EXPECTED_ROLL_DEG.get(label)
        if rt is not None:
            delta = roll_from_R(p_cur["R"]) - rt
            while delta > 180: delta -= 360
            while delta < -180: delta += 360
            res.append(delta / ROLL_SIGMA_DEG)
        # Soft cheirality prior: always emit, penalises Cz < 100 mm
        C = -p_cur["R"].T @ p_cur["t"]
        res.append(max(0.0, 100.0 - float(C[2])) / 50.0)
    if bed_prior:
        for f in features:
            res.append(f[2] / sigmas["bed"])
    return np.asarray(res)


def compute_err(params, labels, observations, n_features, cx_cy):
    poses, features = unpack(params, labels, n_features)
    per = {l: [] for l in labels}
    for (label, feat_idx, u, v) in observations:
        p = poses[label]
        cx, cy = cx_cy[label]
        proj = project_simple(p["fx"], p["R"], p["t"], features[feat_idx], cx, cy)
        if np.isnan(proj[0]):
            per[label].append(float("inf"))
        else:
            per[label].append(float(np.hypot(proj[0]-u, proj[1]-v)))
    return per, features, poses


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--features", default="calib/cross_features_merged.json")
    ap.add_argument("--bed-prior", action="store_true")
    ap.add_argument("--reproj-sigma", type=float, default=2.0)
    ap.add_argument("--fx-sigma", type=float, default=60.0)
    ap.add_argument("--rvec-sigma", type=float, default=0.3)
    ap.add_argument("--t-sigma", type=float, default=400.0)
    ap.add_argument("--bed-sigma", type=float, default=40.0)
    args = ap.parse_args()

    data = json.loads((REPO / args.features).read_text())
    feat_in = data["features"]
    # Labels present in the clicks
    labels = []
    for f in feat_in:
        for lbl in f["clicks_per_phone"]:
            if lbl not in labels:
                labels.append(lbl)
    labels.sort(key=lambda x: ["anna","valentine","sophia","javier","kinect"].index(x))
    print(f"Labels in features: {labels}")

    # Load priors where available
    priors = {}
    poses_init = {}
    for label in labels:
        try:
            p_old = load_pose(label)
            fx = float(p_old["K"][0][0])
            R = np.asarray(p_old["R"], float)
            t = np.asarray(p_old["t_mm"], float)
            rvec = Rotation.from_matrix(R).as_rotvec()
            priors[label] = {"fx": fx, "rvec": rvec, "t": t}
            poses_init[label] = {"fx": fx, "R": R, "t": t}
            print(f"  {label}: prior loaded (fx={fx:.0f}, C={(-R.T@t).tolist()})")
        except FileNotFoundError:
            # No prior — initialise as overhead-looking-down pose (well-defined & good for kinect;
            # acceptable for anna since BA will move it to a sensible place).
            fx = DEFAULT_FX.get(label, 780.0)
            C0 = np.array([419.0, 965.0, 800.0])
            R = np.array([[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]])
            t = -R @ C0
            poses_init[label] = {"fx": fx, "R": R, "t": t}
            print(f"  {label}: NO prior — overhead init at {C0.tolist()} (solve fresh)")

    # Principal points
    cx_cy = {}
    for label in labels:
        if label in priors:
            p_old = load_pose(label)
            cx_cy[label] = (float(p_old["K"][0][2]), float(p_old["K"][1][2]))
        else:
            W, H = DEFAULT_DIMS[label]
            cx_cy[label] = (W/2.0, H/2.0)

    # Observations
    observations = []
    for feat_idx, f in enumerate(feat_in):
        for label, uv in f["clicks_per_phone"].items():
            if label not in labels: continue
            observations.append((label, feat_idx, float(uv[0]), float(uv[1])))

    n_features = len(feat_in)

    # ─── Two-stage init ──────────────────────────────────────────────────────
    # Stage 1: triangulate each feature from valentine+sophia clicks to get a 3D guess
    def triangulate_from_views(uv_by_label):
        """DLT triangulation from 2 or 3 views, using their prior poses."""
        rows = []
        for lbl, uv in uv_by_label.items():
            if lbl not in priors: continue
            p = poses_init[lbl]
            K = np.array([[p["fx"], 0, cx_cy[lbl][0]], [0, p["fx"], cx_cy[lbl][1]], [0, 0, 1]])
            Rt = np.hstack([p["R"], p["t"].reshape(3, 1)])
            P = K @ Rt
            u, v = uv
            rows.append(u * P[2] - P[0])
            rows.append(v * P[2] - P[1])
        if len(rows) < 4: return None
        A = np.array(rows)
        _, _, Vt = np.linalg.svd(A)
        Xh = Vt[-1]
        if abs(Xh[3]) < 1e-12: return None
        return Xh[:3] / Xh[3]

    feat_init = []
    triangulated_count = 0
    for f in feat_in:
        X = triangulate_from_views(f["clicks_per_phone"])
        if X is not None and np.all(np.isfinite(X)):
            feat_init.append(X.tolist())
            triangulated_count += 1
        else:
            feat_init.append([419.0, 965.0, 0.0])
    print(f"\nStage 1: triangulated {triangulated_count}/{n_features} features from prior phones")

    # Stage 2: PnP-solve anna and kinect from the triangulated 3D points + their clicks
    import cv2
    for label in labels:
        if label in priors: continue  # skip phones with priors
        obj_pts, img_pts = [], []
        for feat_idx, f in enumerate(feat_in):
            if label in f["clicks_per_phone"]:
                obj_pts.append(feat_init[feat_idx])
                img_pts.append(f["clicks_per_phone"][label])
        if len(obj_pts) < 4:
            print(f"  Stage 2 [{label}]: only {len(obj_pts)} correspondences, skipping PnP")
            continue
        obj_pts = np.array(obj_pts, dtype=np.float32)
        img_pts = np.array(img_pts, dtype=np.float32)
        fx = DEFAULT_FX.get(label, 780.0)
        W, H = DEFAULT_DIMS.get(label, (1080, 1920))
        K = np.array([[fx, 0, W/2], [0, fx, H/2], [0, 0, 1]], dtype=np.float32)
        # EPNP handles 4-5 points; iterative needs ≥6
        flag = cv2.SOLVEPNP_EPNP if len(obj_pts) < 6 else cv2.SOLVEPNP_ITERATIVE
        ok, rvec, tvec = cv2.solvePnP(obj_pts, img_pts, K, None, flags=flag)
        if ok:
            R = cv2.Rodrigues(rvec)[0]
            t = tvec.flatten()
            C = -R.T @ t
            poses_init[label] = {"fx": fx, "R": R, "t": t}
            print(f"  Stage 2 [{label}]: PnP solved, C = {C.tolist()}, fx = {fx:.0f}")
        else:
            print(f"  Stage 2 [{label}]: PnP failed")

    x0 = pack(poses_init, feat_init)
    sigmas = {
        "reproj": args.reproj_sigma, "fx": args.fx_sigma,
        "rvec": args.rvec_sigma, "t": args.t_sigma, "bed": args.bed_sigma,
    }

    print(f"\n{len(observations)} observations, {n_features} features, {len(labels)} cameras")
    print(f"Unknowns: {len(labels) * 7 + n_features * 3}")

    # Before BA (at initial guess)
    per0, _, _ = compute_err(x0, labels, observations, n_features, cx_cy)
    print("\nInitial (at defaults/priors):")
    for label in labels:
        errs = [e for e in per0[label] if np.isfinite(e)]
        if errs:
            print(f"  {label:10s} mean={np.mean(errs):7.1f} max={np.max(errs):7.1f}")

    print("\nRunning BA…")
    result = least_squares(
        residuals, x0,
        args=(labels, observations, n_features, priors, cx_cy, sigmas, args.bed_prior),
        method="lm", max_nfev=50000, xtol=1e-10, ftol=1e-10)
    print(f"Converged: {result.message}  nfev={result.nfev}  cost={result.cost:.2f}")

    per1, feats_out, poses_out = compute_err(result.x, labels, observations, n_features, cx_cy)
    print("\nAfter BA:")
    for label in labels:
        errs = [e for e in per1[label] if np.isfinite(e)]
        if errs:
            print(f"  {label:10s} mean={np.mean(errs):7.2f} max={np.max(errs):7.2f} (n={len(errs)})")

    print("\nRefined feature 3D positions:")
    for i, f in enumerate(feat_in):
        xyz = feats_out[i]
        plausible = (-200 <= xyz[0] <= 1100) and (-200 <= xyz[1] <= 2100) and (-400 <= xyz[2] <= 200)
        tag = "[in]" if plausible else "[out]"
        per_view = ", ".join(f"{l}:{e:.1f}" for l in labels for e in [per1[l][i] if i < len(per1[l]) else None] if e is not None and np.isfinite(e))
        print(f"  {f['name']:8s} ({xyz[0]:+7.0f},{xyz[1]:+7.0f},{xyz[2]:+6.0f}) {tag}")

    # Save refined poses
    print("\nSaved refined poses:")
    for label in labels:
        pn = poses_out[label]
        C = -pn["R"].T @ pn["t"]
        cx_p, cy_p = cx_cy[label]
        zc = pn["R"][2]
        pitch = float(np.degrees(np.arcsin(np.clip(zc[2], -1, 1))))
        yaw = float(np.degrees(np.arctan2(zc[1], zc[0])))
        # Compute roll via the same convention
        down = np.array([0.0, 0.0, -1.0])
        xnr = np.cross(down, zc); xnr /= np.linalg.norm(xnr) + 1e-9
        ynr = np.cross(zc, xnr); ynr /= np.linalg.norm(ynr) + 1e-9
        xa = np.array([pn["R"][0][0], pn["R"][1][0], pn["R"][2][0]])
        roll = float(np.degrees(np.arctan2(np.dot(xa, ynr), np.dot(xa, xnr))))
        refined = {
            "label": label, "session": 1,
            "method": f"bundle_adjust_v2_round2_clack60s",
            "K": [[float(pn["fx"]), 0, cx_p], [0, float(pn["fx"]), cy_p], [0, 0, 1]],
            "R": [list(map(float, row)) for row in pn["R"]],
            "t_mm": list(map(float, pn["t"])),
            "camera_center_world_mm": list(map(float, C)),
            "euler_deg": {"yaw": yaw, "pitch": pitch, "roll": roll},
            "fx_px": float(pn["fx"]),
            "dist_coeffs": {"k1": 0, "k2": 0},
            "notes": [
                f"BA from {args.features}, {n_features} features, {len(labels)} cameras.",
                f"Prior: {'yes' if label in priors else 'no (solved fresh)'}.",
                f"Mean reproj after BA: {np.mean([e for e in per1[label] if np.isfinite(e)]):.2f} px",
            ],
        }
        out = REPO / "calib" / f"pose_{label}_refined.json"
        out.write_text(json.dumps(refined, indent=2))
        prev = f"{priors[label]['fx']:.0f}" if label in priors else "—"
        print(f"  {out.relative_to(REPO)}  fx {prev}→{pn['fx']:.0f}  C={C.tolist()}")


if __name__ == "__main__":
    main()
