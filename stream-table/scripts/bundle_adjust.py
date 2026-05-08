"""Bundle-adjust 3 phone poses + feature 3D positions to minimise reprojection error
across cross-view feature clicks.

Usage:
  python3 scripts/bundle_adjust.py                      # uses calib/cross_features.json
  python3 scripts/bundle_adjust.py path/to/features.json
  python3 scripts/bundle_adjust.py --bed-prior           # add soft Z=0 prior on features

Outputs:
  calib/pose_<label>_refined.json  — refined pose per phone
  calib/bundle_adjust_report.md    — before/after residual summary
"""
import json, sys, argparse
import numpy as np
from pathlib import Path
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pose_utils import load_pose

REPO = Path(__file__).resolve().parent.parent
PHONES = ["valentine", "sophia", "javier"]

# Expected camera roll per phone, in degrees. Valentine and sophia were shot portrait
# (roll=0); javier was shot landscape but stored portrait, needing a 90°-CCW correction
# which corresponds to roll = -90° in the yaw/pitch/roll convention of pose_tune.html.
EXPECTED_ROLL_DEG = {
    "valentine": 0.0,
    "sophia": 0.0,
    "javier": -90.0,
}
ROLL_SIGMA_DEG = 2.0  # tight — we believe the orientation per user confirmation


def roll_from_R(R):
    """Extract roll in degrees from the world→camera rotation matrix R, matching the
    pose_tune.html convention (yaw around world Z, pitch, roll around optical axis)."""
    zc = R[2]  # third row = z_cam expressed in world coords
    down = np.array([0.0, 0.0, -1.0])
    x_noroll = np.cross(down, zc)
    n = np.linalg.norm(x_noroll)
    if n < 1e-9:
        return 0.0  # degenerate (pitch = ±90°)
    x_noroll /= n
    y_noroll = np.cross(zc, x_noroll)
    y_noroll /= np.linalg.norm(y_noroll)
    x_actual = np.array([R[0][0], R[1][0], R[2][0]])  # first column of R
    cos_r = np.dot(x_actual, x_noroll)
    sin_r = np.dot(x_actual, y_noroll)
    return float(np.degrees(np.arctan2(sin_r, cos_r)))


def project_simple(fx, R, t, Xw, cx, cy):
    Xc = R @ Xw + t
    if Xc[2] <= 1e-6:
        return np.array([np.nan, np.nan])
    return np.array([fx * Xc[0] / Xc[2] + cx, fx * Xc[1] / Xc[2] + cy])


def pack(poses_prior, features):
    """Flatten 3 poses + N features to a single vector."""
    params = []
    for label in PHONES:
        p = poses_prior[label]
        fx = p["K"][0][0]
        R = np.asarray(p["R"], float)
        t = np.asarray(p["t_mm"], float)
        rvec = Rotation.from_matrix(R).as_rotvec()
        params.extend([fx, *rvec, *t])
    for xyz in features:
        params.extend(xyz)
    return np.array(params, float)


def unpack(params, n_features):
    poses = {}
    i = 0
    for label in PHONES:
        fx = params[i]; i += 1
        rvec = params[i:i+3]; i += 3
        t = params[i:i+3]; i += 3
        R = Rotation.from_rotvec(rvec).as_matrix()
        poses[label] = {"fx": fx, "R": R, "t": np.asarray(t)}
    features = []
    for _ in range(n_features):
        features.append(np.asarray(params[i:i+3])); i += 3
    return poses, features


def residuals(params, observations, n_features, priors, sigmas, bed_prior=False):
    poses, features = unpack(params, n_features)
    res = []
    # Reprojection residuals
    for (phone_idx, feat_idx, u, v, cx, cy) in observations:
        label = PHONES[phone_idx]
        p = poses[label]
        proj = project_simple(p["fx"], p["R"], p["t"], features[feat_idx], cx, cy)
        if np.isnan(proj[0]):
            res.extend([1e3, 1e3])
        else:
            res.append((proj[0] - u) / sigmas["reproj"])
            res.append((proj[1] - v) / sigmas["reproj"])
    # Pose priors (anchor near current solution so gauge is fixed)
    for label in PHONES:
        p_curr = poses[label]
        p_pri = priors[label]
        res.append((p_curr["fx"] - p_pri["fx"]) / sigmas["fx"])
        rvec_curr = Rotation.from_matrix(p_curr["R"]).as_rotvec()
        for j in range(3):
            res.append((rvec_curr[j] - p_pri["rvec"][j]) / sigmas["rvec"])
            res.append((p_curr["t"][j] - p_pri["t"][j]) / sigmas["t"])
    # Optional bed prior: pull features toward Z=0
    if bed_prior:
        for f in features:
            res.append(f[2] / sigmas["bed"])
    # Roll constraint: pin each phone's roll to its expected value (deg)
    for label in PHONES:
        if label not in EXPECTED_ROLL_DEG:
            continue
        roll_actual = roll_from_R(poses[label]["R"])
        # Handle wrap-around: compare angular distance (-180..180)
        target = EXPECTED_ROLL_DEG[label]
        delta = roll_actual - target
        while delta > 180: delta -= 360
        while delta < -180: delta += 360
        res.append(delta / ROLL_SIGMA_DEG)
    return np.asarray(res)


def compute_reproj_stats(params, observations, n_features):
    poses, features = unpack(params, n_features)
    per_phone = {label: [] for label in PHONES}
    per_feature = {}
    for (phone_idx, feat_idx, u, v, cx, cy) in observations:
        label = PHONES[phone_idx]
        p = poses[label]
        proj = project_simple(p["fx"], p["R"], p["t"], features[feat_idx], cx, cy)
        if np.isnan(proj[0]):
            err = float("inf")
        else:
            err = float(np.hypot(proj[0] - u, proj[1] - v))
        per_phone[label].append(err)
        per_feature.setdefault(feat_idx, []).append((label, err))
    return per_phone, per_feature, features, poses


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("features_json", nargs="?", default="calib/cross_features.json")
    ap.add_argument("--bed-prior", action="store_true",
                    help="add soft Z=0 prior on every feature (only if you believe features are on bed)")
    ap.add_argument("--reproj-sigma", type=float, default=2.0)
    ap.add_argument("--fx-sigma", type=float, default=80.0)
    ap.add_argument("--rvec-sigma", type=float, default=0.20, help="radians (~11°)")
    ap.add_argument("--t-sigma", type=float, default=500.0, help="mm")
    ap.add_argument("--bed-sigma", type=float, default=40.0, help="mm (only used with --bed-prior)")
    args = ap.parse_args()

    # Load
    data = json.loads((REPO / args.features_json).read_text() if not Path(args.features_json).is_absolute() else Path(args.features_json).read_text())
    feat_in = data["features"]
    n_features = len(feat_in)

    poses_prior = {label: load_pose(label) for label in PHONES}
    cx_cy = {label: (poses_prior[label]["K"][0][2], poses_prior[label]["K"][1][2]) for label in PHONES}

    # Priors (for anchor)
    priors = {}
    for label in PHONES:
        p = poses_prior[label]
        priors[label] = {
            "fx": float(p["fx_px"]),
            "rvec": Rotation.from_matrix(np.asarray(p["R"])).as_rotvec(),
            "t": np.asarray(p["t_mm"], float),
        }

    # Observations
    observations = []
    for feat_idx, f in enumerate(feat_in):
        for label, uv in f["clicks_per_phone"].items():
            if label not in PHONES: continue
            cx, cy = cx_cy[label]
            observations.append((PHONES.index(label), feat_idx, float(uv[0]), float(uv[1]), cx, cy))

    # Initial feature 3D guesses — try something in the flume at Z=0 rather than the wild DLT result
    init_features = []
    for f in feat_in:
        # Start near flume centre; optimiser will move them
        init_features.append([419.0, 965.0, 0.0])

    x0 = pack(poses_prior, init_features)
    sigmas = {
        "reproj": args.reproj_sigma,
        "fx": args.fx_sigma,
        "rvec": args.rvec_sigma,
        "t": args.t_sigma,
        "bed": args.bed_sigma,
    }

    print("=== Bundle adjustment ===")
    print(f"Phones: {PHONES}")
    print(f"Features: {[f['name'] for f in feat_in]}  (n={n_features})")
    print(f"Observations: {len(observations)} (2 eqs each → {2*len(observations)} reproj residuals)")
    print(f"Priors: fx σ={sigmas['fx']:.0f} px, rvec σ={sigmas['rvec']:.2f} rad, t σ={sigmas['t']:.0f} mm")
    if args.bed_prior:
        print(f"Bed prior: features pulled toward Z=0 with σ={sigmas['bed']:.0f} mm")

    # BEFORE stats — at original poses with wild DLT features
    x_before = pack(poses_prior, [f["world_xyz_mm"] for f in feat_in])
    pp_before, _, _, _ = compute_reproj_stats(x_before, observations, n_features)
    # Also: at the BA initial guess (features at centre)
    pp_init, _, _, _ = compute_reproj_stats(x0, observations, n_features)

    print("\nBefore BA — using reported world_xyz from the export:")
    for label in PHONES:
        errs = pp_before[label]
        if errs:
            print(f"  {label:10s}: mean={np.mean(errs):7.1f} px  max={np.max(errs):7.1f} px")

    # Optimise
    print("\nRunning LM optimisation…")
    result = least_squares(
        residuals, x0,
        args=(observations, n_features, priors, sigmas, args.bed_prior),
        method="lm", max_nfev=30000, xtol=1e-10, ftol=1e-10,
    )
    print(f"Converged: {result.message}  nfev={result.nfev}  cost={result.cost:.2f}")

    pp_after, pf_after, features_out, poses_out = compute_reproj_stats(result.x, observations, n_features)
    print("\nAfter BA:")
    for label in PHONES:
        errs = pp_after[label]
        if errs:
            print(f"  {label:10s}: mean={np.mean(errs):7.1f} px  max={np.max(errs):7.1f} px")

    print("\nRefined feature positions (world mm):")
    for i, f in enumerate(feat_in):
        xyz = features_out[i]
        plausible = (-200 <= xyz[0] <= 1100) and (-200 <= xyz[1] <= 2100) and (-400 <= xyz[2] <= 200)
        tag = "[IN flume bounds]" if plausible else "[outside]"
        per_view_err = ", ".join(f"{lbl}:{e:.0f}" for lbl, e in pf_after[i])
        print(f"  {f['name']:12s}  ({xyz[0]:+7.0f}, {xyz[1]:+7.0f}, {xyz[2]:+6.0f}) {tag}  residuals: {per_view_err}")

    # Save refined poses
    print("\nSaved refined poses:")
    for label in PHONES:
        p_new = poses_out[label]
        p_old = poses_prior[label]
        C_new = -p_new["R"].T @ p_new["t"]
        rvec_new = Rotation.from_matrix(p_new["R"]).as_rotvec()
        # Recover Euler close to HTML convention (for the pose_tune.html)
        # z_cam_world = R[:, 2] per our convention (camera-forward in world is the third ROW since rows are camera axes, but wait, we have R[2, :] rows — need to verify)
        # For pose_tune.html R is 3x3 world→cam. R[2, :] is the third row = z_cam expressed in world coords (camera forward in world).
        zc = p_new["R"][2]
        pitch = float(np.degrees(np.arcsin(zc[2])))
        yaw = float(np.degrees(np.arctan2(zc[1], zc[0])))
        # Roll: compare x_cam actual vs no-roll
        from_down = np.array([0.0, 0.0, -1.0])
        x_noroll = np.cross(from_down, zc); x_noroll /= np.linalg.norm(x_noroll)
        y_noroll = np.cross(zc, x_noroll); y_noroll /= np.linalg.norm(y_noroll)
        x_actual = np.array([p_new["R"][0][0], p_new["R"][1][0], p_new["R"][2][0]])
        roll = float(np.degrees(np.arctan2(np.dot(x_actual, y_noroll), np.dot(x_actual, x_noroll))))

        refined = dict(p_old)
        refined["K"] = [[float(p_new["fx"]), 0, p_old["K"][0][2]],
                        [0, float(p_new["fx"]), p_old["K"][1][2]],
                        [0, 0, 1]]
        refined["R"] = [list(map(float, row)) for row in p_new["R"]]
        refined["t_mm"] = list(map(float, p_new["t"]))
        refined["camera_center_world_mm"] = list(map(float, C_new))
        refined["fx_px"] = float(p_new["fx"])
        refined["euler_deg"] = {"yaw": yaw, "pitch": pitch, "roll": roll}
        refined["method"] = f"bundle_adjust_from_{p_old.get('method', 'prior')}"
        refined["notes"] = (p_old.get("notes") or []) + [
            f"Refined via bundle_adjust.py on {data.get('exported_at', '?')}: "
            f"mean reproj {np.mean(pp_after[label]):.1f} px (was {np.mean(pp_before[label]):.1f} px)"
        ]
        out = REPO / "calib" / f"pose_{label}_refined.json"
        out.write_text(json.dumps(refined, indent=2))
        print(f"  {out.relative_to(REPO)}  |  fx {p_old['K'][0][0]:.0f}→{p_new['fx']:.0f}  |  ΔC = {np.linalg.norm(C_new - np.asarray(p_old['camera_center_world_mm'])):.1f} mm")

    # Report file
    report = REPO / "calib" / "bundle_adjust_report.md"
    with open(report, "w") as fh:
        fh.write("# Bundle-adjust report\n\n")
        fh.write(f"Input: {args.features_json} ({n_features} features, {len(observations)} observations)\n\n")
        fh.write("## Per-phone reproj (mean / max, px)\n\n")
        fh.write("| Phone | Before | After | Δ |\n|---|---|---|---|\n")
        for label in PHONES:
            b = np.mean(pp_before[label]) if pp_before[label] else float("nan")
            a = np.mean(pp_after[label]) if pp_after[label] else float("nan")
            fh.write(f"| {label} | {b:.1f} | {a:.1f} | {b - a:+.1f} |\n")
        fh.write("\n## Refined feature positions\n\n| Feature | X | Y | Z | In flume bounds |\n|---|---|---|---|---|\n")
        for i, f in enumerate(feat_in):
            xyz = features_out[i]
            plausible = (-200 <= xyz[0] <= 1100) and (-200 <= xyz[1] <= 2100) and (-400 <= xyz[2] <= 200)
            fh.write(f"| {f['name']} | {xyz[0]:.0f} | {xyz[1]:.0f} | {xyz[2]:.0f} | {'yes' if plausible else 'no'} |\n")
    print(f"\nReport: {report.relative_to(REPO)}")


if __name__ == "__main__":
    main()
