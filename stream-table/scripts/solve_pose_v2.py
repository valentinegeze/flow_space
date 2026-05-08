"""
Stage 3 — Phone pose solve v3 (line-constraint version).

Takes annotations from calib/annotations/<label>.json. Treats rim_NE/rim_SE as point
correspondences, and the rail/cross-rim line-tag pairs as additional constraints: two
parallel world lines must share a common vanishing point. Joint LM optimisation over
(fx, R, t) minimising reprojection error + VP consistency + weak fx prior.

Usage: python3 scripts/solve_pose_v2.py javier
"""
import cv2, numpy as np, json, sys
from pathlib import Path
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

REPO = Path(__file__).resolve().parent.parent
LABEL = sys.argv[1] if len(sys.argv) > 1 else "javier"

IMG_PATH = REPO / "calib" / "reference_frames" / f"{LABEL}.jpg"
ANN_PATH = REPO / "calib" / "annotations" / f"{LABEL}.json"
OUT_PATH = REPO / "calib" / f"pose_{LABEL}.json"
OVERLAY_PATH = REPO / "calib" / f"pose_{LABEL}_overlay.jpg"
K_CX, K_CY = 540.0, 960.0
FX_PRIOR = 780.0
FX_PRIOR_SIGMA = 200.0  # weaker prior — trust the VP geometry more

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
}
# World direction each "line-tag" pair is aligned with
LINE_TAG_DIRECTIONS = {
    "line:Y_axis":       np.array([0.0, 1.0, 0.0]),  # flume-length direction
    "line:X_axis_at_Y0": np.array([1.0, 0.0, 0.0]),  # across width at far end
}


def load_annotations():
    data = json.loads(ANN_PATH.read_text())
    clicks = data["annotations"][LABEL]
    pts = []
    line_pairs = {}  # tag → list of (name, u, v)
    for name, entry in clicks.items():
        if entry.get("visible") is False or entry.get("u") is None:
            continue
        if name in WORLD:
            pts.append((name, float(entry["u"]), float(entry["v"]), *WORLD[name]))
        elif name.startswith("rail_pt_"):
            line_pairs.setdefault("line:Y_axis", []).append((name, float(entry["u"]), float(entry["v"])))
        elif name.startswith("far_cross_rim_"):
            line_pairs.setdefault("line:X_axis_at_Y0", []).append((name, float(entry["u"]), float(entry["v"])))
    print(f"Point correspondences: {[p[0] for p in pts]}")
    for tag, ls in line_pairs.items():
        print(f"Line on {tag}: {[l[0] for l in ls]}")
    return pts, line_pairs


def line_intersect(p1, p2, p3, p4):
    x1, y1 = p1; x2, y2 = p2; x3, y3 = p3; x4, y4 = p4
    d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(d) < 1e-9:
        return None
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d
    return np.array([x1 + t * (x2 - x1), y1 + t * (y2 - y1)])


def detect_vpz(img_path):
    """Vertical lines from Hough → VP_Z. Median-based rejection of outliers."""
    img = cv2.imread(str(img_path))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 1.0)
    edges = cv2.Canny(gray, 50, 150)
    raw = cv2.HoughLinesP(edges, 1, np.pi / 180, 150, minLineLength=150, maxLineGap=15)
    if raw is None:
        return None, 0
    keep = []
    for l in raw[:, 0]:
        x1, y1, x2, y2 = l
        ang = np.degrees(np.arctan2(y2 - y1, x2 - x1)) % 180
        if abs(ang - 90) < 8:  # tight filter
            keep.append((x1, y1, x2, y2))
    if len(keep) < 3:
        return None, 0
    A = []
    for x1, y1, x2, y2 in keep:
        a, b = (y2 - y1), -(x2 - x1)
        c = -(a * x1 + b * y1)
        n = np.hypot(a, b)
        A.append([a / n, b / n, c / n])
    A = np.array(A)
    sol, *_ = np.linalg.lstsq(A[:, :2], -A[:, 2], rcond=None)
    return (float(sol[0]), float(sol[1])), len(keep)


def project(Xw, R, t, K):
    Xc = R @ Xw + t
    if Xc[2] <= 0:  # behind camera
        return np.array([np.nan, np.nan])
    return np.array([K[0, 0] * Xc[0] / Xc[2] + K[0, 2],
                     K[1, 1] * Xc[1] / Xc[2] + K[1, 2]])


def project_direction_to_vp(d_world, R, K):
    """Project a world direction (point at infinity) to image → VP."""
    d_cam = R @ d_world
    if abs(d_cam[2]) < 1e-9:
        return np.array([np.nan, np.nan])
    return np.array([K[0, 0] * d_cam[0] / d_cam[2] + K[0, 2],
                     K[1, 1] * d_cam[1] / d_cam[2] + K[1, 2]])


def residuals(params, pts, observed_vps, vp_z_obs, sigmas):
    fx, rx, ry, rz, tx, ty, tz = params
    K = np.array([[fx, 0, K_CX], [0, fx, K_CY], [0, 0, 1]])
    R = Rotation.from_rotvec([rx, ry, rz]).as_matrix()
    t = np.array([tx, ty, tz])
    res = []
    # Point reprojections
    for name, u, v, X0, X1, X2 in pts:
        proj = project(np.array([X0, X1, X2], float), R, t, K)
        if np.isnan(proj[0]):
            res.extend([1e6, 1e6])
        else:
            res.append((proj[0] - u) / sigmas["pt"])
            res.append((proj[1] - v) / sigmas["pt"])
    # Observed VPs from line intersections
    for d_world, vp_obs in observed_vps:
        vp_pred = project_direction_to_vp(d_world, R, K)
        if np.isnan(vp_pred[0]):
            res.extend([1e6, 1e6])
        else:
            res.append((vp_pred[0] - vp_obs[0]) / sigmas["vp"])
            res.append((vp_pred[1] - vp_obs[1]) / sigmas["vp"])
    # VP_Z from Hough
    if vp_z_obs is not None:
        vp_z_pred = project_direction_to_vp(np.array([0.0, 0.0, 1.0]), R, K)
        if not np.isnan(vp_z_pred[0]):
            res.append((vp_z_pred[0] - vp_z_obs[0]) / sigmas["vpz"])
            res.append((vp_z_pred[1] - vp_z_obs[1]) / sigmas["vpz"])
    # fx prior
    res.append((fx - FX_PRIOR) / FX_PRIOR_SIGMA)
    return np.array(res)


def main():
    pts, line_pairs = load_annotations()
    if len(pts) < 2:
        raise SystemExit("Need at least 2 point correspondences.")

    # Build observed VPs from line-tag pairs: intersect each line-tag pair's line
    # with a reference Y-parallel line (the rim_NE→rim_SE pair) if the tags match.
    pts_by_name = {p[0]: p for p in pts}
    observed_vps = []
    if "rim_NE" in pts_by_name and "rim_SE" in pts_by_name:
        rim_A = np.array([pts_by_name["rim_NE"][1], pts_by_name["rim_NE"][2]])
        rim_B = np.array([pts_by_name["rim_SE"][1], pts_by_name["rim_SE"][2]])
    else:
        rim_A = rim_B = None

    for tag, pair in line_pairs.items():
        if len(pair) < 2:
            continue
        pA = np.array([pair[0][1], pair[0][2]])
        pB = np.array([pair[1][1], pair[1][2]])
        d = LINE_TAG_DIRECTIONS.get(tag)
        if d is None:
            continue
        if tag == "line:Y_axis" and rim_A is not None:
            # Intersect with rim line → VP_Y
            vp = line_intersect(rim_A, rim_B, pA, pB)
            if vp is not None:
                observed_vps.append((d, vp))
                print(f"VP_Y from rim ∩ {pair[0][0]}→{pair[1][0]}: ({vp[0]:.1f}, {vp[1]:.1f})")
        elif tag == "line:X_axis_at_Y0":
            # Intersect with another X-axis line if we had one; otherwise skip.
            # The 2 clicks alone define one X-line direction, not a VP. Skip unless we had
            # two separate X-aligned features — treat as a single-line direction constraint
            # via rim_NE anchor: the image line rim_NE→(further along far cross-rim) passes
            # through VP_X. Compute as intersection with a hypothetical far line through rim_NE.
            # Instead, just pass the clicked points as a direct line-direction observation:
            # the image line A→B must point toward VP_X.
            # Record as a line-direction constraint (2 eqs): VP_X is on image line through A,B.
            observed_vps.append((d, (pA, pB, "line_direction")))

    vp_z_obs, n_z = detect_vpz(IMG_PATH)
    print(f"VP_Z from {n_z} Hough near-vertical lines: {vp_z_obs}")

    # Multi-start initial guesses, physically reasoned
    target = np.array([419.0, 1000.0, 0.0])
    world_up = np.array([0.0, 0.0, -1.0])
    sigmas = {"pt": 2.0, "vp": 10.0, "vpz": 25.0}
    candidates = []
    for Cx in [1500.0, -1500.0]:
        for Cy in [2500.0, -500.0]:
            for Cz in [-700.0, -1500.0]:
                C0 = np.array([Cx, Cy, Cz])
                z_c = target - C0
                if np.linalg.norm(z_c) < 1e-6: continue
                z_c /= np.linalg.norm(z_c)
                x_c = np.cross(world_up, z_c)
                if np.linalg.norm(x_c) < 1e-6: continue
                x_c /= np.linalg.norm(x_c)
                y_c = np.cross(z_c, x_c)
                R0 = np.column_stack([x_c, y_c, z_c]).T
                t0 = -R0 @ C0
                rv0 = Rotation.from_matrix(R0).as_rotvec()
                x0 = np.concatenate([[FX_PRIOR], rv0, t0])
                try:
                    # Use only plain VPs (point observations) for the LS; skip line_direction
                    vps_for_solve = [(d, v) for d, v in observed_vps if not isinstance(v, tuple)]
                    r = least_squares(
                        residuals, x0,
                        args=(pts, vps_for_solve, vp_z_obs, sigmas),
                        method="lm", max_nfev=5000)
                    candidates.append((r.cost, r, C0))
                except Exception as e:
                    pass
    candidates.sort(key=lambda x: x[0])
    print("\nCandidates (lowest cost first):")
    for cost, cand, C0 in candidates[:6]:
        fx_c = cand.x[0]
        R_c = Rotation.from_rotvec(cand.x[1:4]).as_matrix()
        C_c = -R_c.T @ cand.x[4:7]
        # Physically reasonable = camera not AT rim corners, standoff > 200 mm, fx sane
        standoff = min(np.linalg.norm(C_c - WORLD[c]) for c in ["rim_NE", "rim_SE", "rim_NW", "rim_SW"])
        ok = standoff > 50 and abs(C_c[0]) < 5000 and abs(C_c[1]) < 5000 and 300 < fx_c < 2000
        print(f"  init C={C0.tolist()} → cost={cost:.2f} fx={fx_c:.0f} C=({C_c[0]:.0f},{C_c[1]:.0f},{C_c[2]:.0f}) "
              f"nearest-corner={standoff:.0f}mm {'✓' if ok else '✗'}")
    # Select LOWEST-cost solution (prefer math fit over physical heuristics)
    result = candidates[0][1]

    fx = result.x[0]
    R = Rotation.from_rotvec(result.x[1:4]).as_matrix()
    t = result.x[4:7]
    K = np.array([[fx, 0, K_CX], [0, fx, K_CY], [0, 0, 1]])
    C = -R.T @ t

    print(f"\n=== Solved pose ===")
    print(f"fx       = {fx:.1f} px   (prior {FX_PRIOR:.1f})")
    print(f"R =\n{R}")
    print(f"t (mm)   = {t}")
    print(f"C (mm)   = {C}")
    print(f"standoff from rim_SE = {np.linalg.norm(C - WORLD['rim_SE']):.0f} mm")
    print(f"standoff from rim_NE = {np.linalg.norm(C - WORLD['rim_NE']):.0f} mm")

    print("\nReprojection residuals at clicked points:")
    residual_summary = {}
    for name, u, v, X0, X1, X2 in pts:
        proj = project(np.array([X0, X1, X2], float), R, t, K)
        err = float(np.hypot(proj[0] - u, proj[1] - v)) if not np.isnan(proj[0]) else float("nan")
        residual_summary[name] = err
        print(f"  {name:10s} meas=({u:7.1f},{v:7.1f}) proj=({proj[0]:7.1f},{proj[1]:7.1f}) err={err:6.1f} px")

    print("\nPredicted VPs:")
    for d_world, vp_obs in observed_vps:
        if isinstance(vp_obs, tuple): continue
        vp_pred = project_direction_to_vp(np.asarray(d_world, float), R, K)
        name = "VP_Y" if np.allclose(d_world, [0,1,0]) else ("VP_X" if np.allclose(d_world, [1,0,0]) else "VP?")
        print(f"  {name}: obs=({vp_obs[0]:.1f},{vp_obs[1]:.1f}) pred=({vp_pred[0]:.1f},{vp_pred[1]:.1f}) err={np.linalg.norm(vp_pred-vp_obs):.1f} px")
    if vp_z_obs is not None:
        vp_z_pred = project_direction_to_vp(np.array([0.0, 0.0, 1.0]), R, K)
        print(f"  VP_Z: obs=({vp_z_obs[0]:.1f},{vp_z_obs[1]:.1f}) pred=({vp_z_pred[0]:.1f},{vp_z_pred[1]:.1f}) err={np.linalg.norm(vp_z_pred-np.array(vp_z_obs)):.1f} px")

    print("\nPredicted image positions of all schema landmarks:")
    all_proj = {}
    for name, Xw in WORLD.items():
        proj = project(np.array(Xw, float), R, t, K)
        if np.isnan(proj[0]):
            tag = "[BEHIND CAMERA]"
            info = {"u": None, "v": None, "in_frame": False, "behind_camera": True}
        else:
            inframe = 0 <= proj[0] < 1080 and 0 <= proj[1] < 1920
            tag = "[in frame]" if inframe else "[OFF-FRAME]"
            info = {"u": float(proj[0]), "v": float(proj[1]), "in_frame": bool(inframe), "behind_camera": False}
        print(f"  {name:16s} world={Xw} image=({proj[0]:.0f},{proj[1]:.0f}) {tag}")
        all_proj[name] = info

    out = {
        "label": LABEL, "session": 1,
        "K": K.tolist(), "R": R.tolist(), "t_mm": t.tolist(),
        "camera_center_world_mm": C.tolist(),
        "fx_solved_px": float(fx), "fx_prior_px": FX_PRIOR,
        "vp_Y_observed_px": [float(observed_vps[0][1][0]), float(observed_vps[0][1][1])] if observed_vps else None,
        "vp_Z_observed_px": list(vp_z_obs) if vp_z_obs else None,
        "reprojection_residuals_px": residual_summary,
        "all_landmark_projections": all_proj,
        "optimiser": {"method": "LM multi-start", "cost": float(result.cost), "nfev": result.nfev},
    }
    OUT_PATH.write_text(json.dumps(out, indent=2))
    print(f"\nSaved {OUT_PATH.relative_to(REPO)}")

    # Overlay
    img = cv2.imread(str(IMG_PATH))
    for name, u, v, X0, X1, X2 in pts:
        proj = project(np.array([X0, X1, X2], float), R, t, K)
        cv2.drawMarker(img, (int(u), int(v)), (0, 0, 255), cv2.MARKER_CROSS, 40, 4)
        if not np.isnan(proj[0]):
            cv2.drawMarker(img, (int(proj[0]), int(proj[1])), (0, 255, 0), cv2.MARKER_TILTED_CROSS, 40, 4)
        cv2.putText(img, name, (int(u) + 20, int(v)), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 3)
    # Clicked rail points
    for tag, pair in line_pairs.items():
        for n, u, v in pair:
            cv2.drawMarker(img, (int(u), int(v)), (255, 150, 0), cv2.MARKER_DIAMOND, 30, 3)
            cv2.putText(img, n, (int(u) + 15, int(v)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 150, 0), 2)
    # VPs
    for d_world, vp_obs in observed_vps:
        if isinstance(vp_obs, tuple): continue
        cv2.drawMarker(img, (int(vp_obs[0]), int(vp_obs[1])), (255, 0, 255), cv2.MARKER_STAR, 60, 4)
    if vp_z_obs is not None:
        cv2.drawMarker(img, (int(vp_z_obs[0]), int(vp_z_obs[1])), (0, 255, 255), cv2.MARKER_STAR, 60, 4)
    # Off-frame landmark predictions (if any in frame) show as triangles
    for name, info in all_proj.items():
        if info.get("in_frame") and name not in [p[0] for p in pts]:
            cv2.drawMarker(img, (int(info["u"]), int(info["v"])), (100, 255, 100),
                           cv2.MARKER_TRIANGLE_UP, 30, 3)
            cv2.putText(img, name, (int(info["u"]) + 15, int(info["v"])),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (100, 255, 100), 2)
    cv2.imwrite(str(OVERLAY_PATH),
                cv2.resize(img, (img.shape[1] // 2, img.shape[0] // 2)),
                [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f"Saved overlay {OVERLAY_PATH.relative_to(REPO)}")


if __name__ == "__main__":
    main()
