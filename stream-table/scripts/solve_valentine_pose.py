"""
Pose solve for valentine session 1 (v2 — no VP_Z dependency).

Setup:
  - rib_W_upper (0, 343, 0) and rib_E_upper (838, 343, 0): 2 full point correspondences.
  - rail_pt_A, rail_pt_B: 2 points on the X=838 long rim (world X=838, Z=0 known, Y unknown).
    Treated as partial-3D point correspondences; Y values are nuisance parameters.
  - Weak Gaussian prior on fx.
Joint LM optimisation over (fx, rvec, t, Y_A, Y_B).
Multi-start over physically-reasonable camera positions.
"""
import cv2, numpy as np, json
from pathlib import Path
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

REPO = Path(__file__).resolve().parent.parent
LABEL = "valentine"
IMG_PATH = REPO / "calib" / "reference_frames" / f"{LABEL}.jpg"
ANN_PATH = REPO / "calib" / "annotations" / f"{LABEL}.json"
OUT_PATH = REPO / "calib" / f"pose_{LABEL}.json"
OVERLAY_PATH = REPO / "calib" / f"pose_{LABEL}_overlay.jpg"
CX, CY = 540.0, 960.0
FX_PRIOR = 780.0
FX_PRIOR_SIGMA = 150.0
X_LONGRIM = 838.0  # user clicks are on X=838 long rim

WORLD = {
    "rim_NW":         (0,   0,    0),
    "rim_NE":         (838, 0,    0),
    "rim_SW":         (0,   1930, 0),
    "rim_SE":         (838, 1930, 0),
    "rib_W_upper":    (0,   343,  0),
    "rib_E_upper":    (838, 343,  0),
    "rib_W_lower":    (0,   1588, 0),
    "standpipe_base": (419, 1900, 0),
    "edu_midpoint":   (419, 30,   127),
}


def load_clicks():
    d = json.loads(ANN_PATH.read_text())["annotations"][LABEL]
    return {k: np.array([v["u"], v["v"]]) for k, v in d.items() if v.get("visible") and "u" in v}


def project(Xw, R, t, K):
    Xc = R @ Xw + t
    if Xc[2] <= 0: return np.array([np.nan, np.nan])
    return np.array([K[0, 0] * Xc[0] / Xc[2] + K[0, 2],
                     K[1, 1] * Xc[1] / Xc[2] + K[1, 2]])


def residuals(params, clicks):
    fx, rx, ry, rz, tx, ty, tz, Y_A, Y_B = params
    K = np.array([[fx, 0, CX], [0, fx, CY], [0, 0, 1]])
    R = Rotation.from_rotvec([rx, ry, rz]).as_matrix()
    t = np.array([tx, ty, tz])
    res = []
    # rib point reprojections (full 3D)
    for name in ["rib_W_upper", "rib_E_upper"]:
        Xw = np.array(WORLD[name], float)
        p = project(Xw, R, t, K)
        u, v = clicks[name]
        if np.isnan(p[0]):
            res.extend([1e4, 1e4])
        else:
            res.append((p[0] - u) / 1.0)
            res.append((p[1] - v) / 1.0)
    # rail point A with partial 3D (X=X_LONGRIM, Y=Y_A, Z=0)
    XwA = np.array([X_LONGRIM, Y_A, 0.0])
    pA = project(XwA, R, t, K)
    uA, vA = clicks["rail_pt_A"]
    if np.isnan(pA[0]):
        res.extend([1e4, 1e4])
    else:
        res.append((pA[0] - uA) / 2.0)
        res.append((pA[1] - vA) / 2.0)
    # rail point B
    XwB = np.array([X_LONGRIM, Y_B, 0.0])
    pB = project(XwB, R, t, K)
    uB, vB = clicks["rail_pt_B"]
    if np.isnan(pB[0]):
        res.extend([1e4, 1e4])
    else:
        res.append((pB[0] - uB) / 2.0)
        res.append((pB[1] - vB) / 2.0)
    # fx prior
    res.append((fx - FX_PRIOR) / FX_PRIOR_SIGMA)
    return np.array(res)


def main():
    clicks = load_clicks()
    print(f"Clicks: {list(clicks.keys())}")

    # Multi-start over physically-reasonable camera positions
    # Valentine = top-down-ish phone over the flume. Camera probably at some X in the flume
    # interior or just outside, elevated above rim.
    # World Z convention: standpipe_top=(...,60) suggests Z+ = UP from rim. So camera Z > 0.
    target = np.array([419.0, 1000.0, 0.0])
    world_down = np.array([0.0, 0.0, 1.0])  # camera "down" in world = gravity direction (roughly)
    candidates = []
    for Cx in [400.0, 1200.0, -400.0]:
        for Cy in [800.0, 2200.0, -300.0]:
            for Cz in [600.0, 1500.0]:
                C0 = np.array([Cx, Cy, Cz])
                z_cam = target - C0
                if np.linalg.norm(z_cam) < 1e-6: continue
                z_cam /= np.linalg.norm(z_cam)
                # Camera Y axis (down in image) roughly aligns with world +Y (far→near in image)
                y_cam_ref = np.array([0.0, 1.0, 0.0])
                x_cam = np.cross(y_cam_ref, z_cam)
                if np.linalg.norm(x_cam) < 1e-6: continue
                x_cam /= np.linalg.norm(x_cam)
                y_cam = np.cross(z_cam, x_cam)
                R0 = np.column_stack([x_cam, y_cam, z_cam]).T
                t0 = -R0 @ C0
                rv0 = Rotation.from_matrix(R0).as_rotvec()
                # Initial guesses for rail Y: mid-flume range
                x0 = np.concatenate([[FX_PRIOR], rv0, t0, [500.0, 1500.0]])
                try:
                    r = least_squares(residuals, x0, args=(clicks,), method="lm", max_nfev=5000)
                    candidates.append((r.cost, r, C0))
                except Exception:
                    continue

    candidates.sort(key=lambda x: x[0])
    print(f"\nTop candidates (by LS cost):")
    for cost, r, C0 in candidates[:6]:
        fx_c = r.x[0]
        R_c = Rotation.from_rotvec(r.x[1:4]).as_matrix()
        C_c = -R_c.T @ r.x[4:7]
        Y_A, Y_B = r.x[7], r.x[8]
        standoff = min(np.linalg.norm(C_c - np.array(WORLD[n])) for n in ["rim_NW","rim_NE","rim_SW","rim_SE"])
        print(f"  init C={C0.tolist()} → cost={cost:.3f} fx={fx_c:.0f} "
              f"C=({C_c[0]:+.0f},{C_c[1]:+.0f},{C_c[2]:+.0f}) "
              f"standoff={standoff:.0f} Y_A={Y_A:.0f} Y_B={Y_B:.0f}")

    # Pick lowest cost with plausible camera position (standoff < 5 m, Cz > 100)
    result = None
    for cost, cand, C0 in candidates:
        R_c = Rotation.from_rotvec(cand.x[1:4]).as_matrix()
        C_c = -R_c.T @ cand.x[4:7]
        standoff = min(np.linalg.norm(C_c - np.array(WORLD[n])) for n in ["rim_NW","rim_NE","rim_SW","rim_SE"])
        fx_c = cand.x[0]
        if standoff < 5000 and C_c[2] > 0 and 400 < fx_c < 1500:
            result = cand
            print(f"\n>>> Selected: init {C0.tolist()}, physically-plausible.")
            break
    if result is None:
        result = candidates[0][1]
        print("\n>>> WARNING: no physically-plausible match; using lowest-cost.")

    fx = result.x[0]
    R = Rotation.from_rotvec(result.x[1:4]).as_matrix()
    t = result.x[4:7]
    Y_A, Y_B = result.x[7], result.x[8]
    K = np.array([[fx, 0, CX], [0, fx, CY], [0, 0, 1]])
    C = -R.T @ t

    print(f"\n=== Pose ===")
    print(f"fx = {fx:.1f} (prior {FX_PRIOR})")
    print(f"R =\n{R}")
    print(f"t (mm) = {t}")
    print(f"C (mm) = {C}")
    print(f"Standoff from rim corners:")
    for n in ["rim_NW", "rim_NE", "rim_SW", "rim_SE"]:
        print(f"  |C - {n}| = {np.linalg.norm(C - np.array(WORLD[n])):.0f} mm")
    print(f"Recovered rail Y positions: Y_A={Y_A:.0f} Y_B={Y_B:.0f}")

    print("\nReprojection residuals:")
    for name in ["rib_W_upper", "rib_E_upper"]:
        u, v = clicks[name]
        Xw = np.array(WORLD[name], float)
        p = project(Xw, R, t, K)
        print(f"  {name}: meas=({u:.1f},{v:.1f}) proj=({p[0]:.1f},{p[1]:.1f}) err={np.hypot(p[0]-u,p[1]-v):.2f} px")
    # Rail projections using recovered Y
    pA = project(np.array([X_LONGRIM, Y_A, 0.0]), R, t, K)
    uA, vA = clicks["rail_pt_A"]
    print(f"  rail_pt_A: meas=({uA:.1f},{vA:.1f}) proj=({pA[0]:.1f},{pA[1]:.1f}) err={np.hypot(pA[0]-uA,pA[1]-vA):.2f} px")
    pB = project(np.array([X_LONGRIM, Y_B, 0.0]), R, t, K)
    uB, vB = clicks["rail_pt_B"]
    print(f"  rail_pt_B: meas=({uB:.1f},{vB:.1f}) proj=({pB[0]:.1f},{pB[1]:.1f}) err={np.hypot(pB[0]-uB,pB[1]-vB):.2f} px")

    print("\nPredicted projection of all schema landmarks:")
    proj_all = {}
    for name, Xw in WORLD.items():
        p = project(np.array(Xw, float), R, t, K)
        if np.isnan(p[0]):
            tag = "[BEHIND CAMERA]"
            proj_all[name] = {"u": None, "v": None, "in_frame": False, "behind_camera": True}
        else:
            infr = 0 <= p[0] < 1080 and 0 <= p[1] < 1920
            tag = "[in frame]" if infr else "[OFF-FRAME]"
            proj_all[name] = {"u": float(p[0]), "v": float(p[1]), "in_frame": bool(infr), "behind_camera": False}
        print(f"  {name:16s} world={Xw}  image=({p[0]:.0f},{p[1]:.0f}) {tag}")

    out = {
        "label": LABEL, "session": 1, "method": "LM_2pts+railLine+fxPrior+multistart",
        "K": K.tolist(), "R": R.tolist(), "t_mm": t.tolist(),
        "camera_center_world_mm": C.tolist(),
        "fx_px": float(fx), "rail_Y_A_mm": float(Y_A), "rail_Y_B_mm": float(Y_B),
        "reprojection_residuals_px": {
            "rib_W_upper": float(np.hypot(*(project(np.array(WORLD["rib_W_upper"], float), R, t, K) - clicks["rib_W_upper"]))),
            "rib_E_upper": float(np.hypot(*(project(np.array(WORLD["rib_E_upper"], float), R, t, K) - clicks["rib_E_upper"]))),
        },
        "all_landmark_projections": proj_all,
    }
    OUT_PATH.write_text(json.dumps(out, indent=2))
    print(f"\nSaved {OUT_PATH.relative_to(REPO)}")

    # Overlay
    img = cv2.imread(str(IMG_PATH))
    for name in ["rib_W_upper", "rib_E_upper"]:
        u, v = clicks[name]
        Xw = np.array(WORLD[name], float)
        p = project(Xw, R, t, K)
        cv2.drawMarker(img, (int(u), int(v)), (0, 0, 255), cv2.MARKER_CROSS, 40, 4)
        if not np.isnan(p[0]):
            cv2.drawMarker(img, (int(p[0]), int(p[1])), (0, 255, 0), cv2.MARKER_TILTED_CROSS, 40, 4)
        cv2.putText(img, name, (int(u) + 15, int(v)), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
    for name in ["rail_pt_A", "rail_pt_B"]:
        u, v = clicks[name]
        cv2.drawMarker(img, (int(u), int(v)), (255, 150, 0), cv2.MARKER_DIAMOND, 30, 3)
    # Predicted rim corners
    for name, info in proj_all.items():
        if info.get("in_frame") and name not in ("rib_W_upper", "rib_E_upper"):
            cv2.drawMarker(img, (int(info["u"]), int(info["v"])), (100, 255, 100),
                           cv2.MARKER_TRIANGLE_UP, 30, 3)
            cv2.putText(img, name, (int(info["u"]) + 10, int(info["v"])),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (100, 255, 100), 2)
    cv2.imwrite(str(OVERLAY_PATH),
                cv2.resize(img, (img.shape[1] // 2, img.shape[0] // 2)),
                [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f"Saved overlay {OVERLAY_PATH.relative_to(REPO)}")


if __name__ == "__main__":
    main()
