"""
Closed-form pose solve from 2 VPs + 2 point correspondences.

Given:
  - rim_NE, rim_SE image pixels (known world coords on the X=838, Z=0 line)
  - A pair of points on a Y-parallel world line (rail) → VP_Y by intersection with rim line
  - A set of Z-parallel world lines (from Hough auto-detection of image verticals) → VP_Z

The math:
  1. Orthogonality of world Y and Z directions → fx from (K⁻¹·VP_Y)·(K⁻¹·VP_Z) = 0
  2. R[:,1] = (K⁻¹·VP_Y) normalised     (with correct sign)
  3. R[:,2] = (K⁻¹·VP_Z) normalised     (with correct sign)
  4. R[:,0] = R[:,1] × R[:,2]            (right-hand rule → det R = +1)
  5. With R, K fixed, 2 point correspondences give 4 linear equations in t (3 unknowns).
  6. Each VP has a sign ambiguity (K⁻¹·VP could represent +axis or -axis). Try all 4 sign
     combinations and pick the one where the camera lands in a physically valid region.
"""
import cv2, numpy as np, json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LABEL = "javier"

IMG_PATH = REPO / "calib" / "reference_frames" / f"{LABEL}.jpg"
ANN_PATH = REPO / "calib" / "annotations" / f"{LABEL}.json"
OUT_PATH = REPO / "calib" / f"pose_{LABEL}.json"
OVERLAY_PATH = REPO / "calib" / f"pose_{LABEL}_overlay.jpg"
CX, CY = 540.0, 960.0

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


def load_clicks():
    data = json.loads(ANN_PATH.read_text())
    c = data["annotations"][LABEL]
    return {k: (v["u"], v["v"]) for k, v in c.items() if v.get("visible") and v.get("u") is not None}


def line_intersect(p1, p2, p3, p4):
    x1, y1 = p1; x2, y2 = p2; x3, y3 = p3; x4, y4 = p4
    d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(d) < 1e-9: return None
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d
    return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))


def detect_vpz():
    img = cv2.imread(str(IMG_PATH))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 1.0)
    edges = cv2.Canny(gray, 50, 150)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, 150, minLineLength=150, maxLineGap=15)
    if lines is None:
        return None
    A = []
    for l in lines[:, 0]:
        x1, y1, x2, y2 = l
        ang = np.degrees(np.arctan2(y2 - y1, x2 - x1)) % 180
        if abs(ang - 90) < 6:
            a, b = (y2 - y1), -(x2 - x1)
            c = -(a * x1 + b * y1)
            n = np.hypot(a, b)
            A.append([a / n, b / n, c / n])
    if len(A) < 3: return None
    A = np.array(A)
    sol, *_ = np.linalg.lstsq(A[:, :2], -A[:, 2], rcond=None)
    return (float(sol[0]), float(sol[1]), len(A))


def solve_fx(vpy, vpz):
    """fx from VP orthogonality. Returns None if dot product positive (imaginary fx)."""
    dp = (vpy[0] - CX) * (vpz[0] - CX) + (vpy[1] - CY) * (vpz[1] - CY)
    if dp >= 0:
        return None
    return float(np.sqrt(-dp))


def build_R_from_vps(vpy, vpz, fx, sy, sz):
    """Build rotation matrix from two VPs, with sign choices sy,sz ∈ {-1,+1}."""
    K = np.array([[fx, 0, CX], [0, fx, CY], [0, 0, 1]])
    Kinv = np.linalg.inv(K)
    ry = Kinv @ np.array([vpy[0], vpy[1], 1.0])
    ry = sy * ry / np.linalg.norm(ry)
    rz = Kinv @ np.array([vpz[0], vpz[1], 1.0])
    rz = sz * rz / np.linalg.norm(rz)
    # Orthogonalise rz against ry
    rz = rz - np.dot(rz, ry) * ry
    rz /= np.linalg.norm(rz)
    rx = np.cross(ry, rz)
    rx /= np.linalg.norm(rx)
    R = np.column_stack([rx, ry, rz])
    assert abs(np.linalg.det(R) - 1.0) < 1e-3, f"det R = {np.linalg.det(R)}"
    return R


def solve_t(R, K, img_pts, world_pts):
    """Linear LS for t given (R, K) and 3D↔2D correspondences."""
    fx = K[0, 0]
    rows, rhs = [], []
    for (u, v), Xw in zip(img_pts, world_pts):
        r1, r2, r3 = R
        rows.append([fx, 0, -(u - CX)]); rhs.append((u - CX) * r3.dot(Xw) - fx * r1.dot(Xw))
        rows.append([0, fx, -(v - CY)]); rhs.append((v - CY) * r3.dot(Xw) - fx * r2.dot(Xw))
    t, *_ = np.linalg.lstsq(np.array(rows), np.array(rhs), rcond=None)
    return t


def project(Xw, R, t, K):
    Xc = R @ Xw + t
    if Xc[2] <= 0: return np.array([np.nan, np.nan])
    return np.array([K[0, 0] * Xc[0] / Xc[2] + K[0, 2],
                     K[1, 1] * Xc[1] / Xc[2] + K[1, 2]])


def main():
    clicks = load_clicks()
    print(f"Clicks: {list(clicks.keys())}")
    rim_NE = np.array(clicks["rim_NE"])
    rim_SE = np.array(clicks["rim_SE"])
    rA = np.array(clicks["rail_pt_A"])
    rB = np.array(clicks["rail_pt_B"])
    vpy = line_intersect(rim_NE, rim_SE, rA, rB)
    print(f"VP_Y (rim ∩ rail): ({vpy[0]:.1f}, {vpy[1]:.1f})")
    vpz_raw = detect_vpz()
    vpz = (vpz_raw[0], vpz_raw[1])
    print(f"VP_Z (Hough, {vpz_raw[2]} lines): ({vpz[0]:.1f}, {vpz[1]:.1f})")
    fx = solve_fx(vpy, vpz)
    if fx is None:
        raise SystemExit("Orthogonality failed — VPs not orthogonal at any real fx.")
    print(f"fx from orthogonality: {fx:.1f} px")
    K = np.array([[fx, 0, CX], [0, fx, CY], [0, 0, 1]])
    img_pts = [tuple(rim_NE), tuple(rim_SE)]
    world_pts = [np.array(WORLD["rim_NE"], float), np.array(WORLD["rim_SE"], float)]

    # Try all 4 sign combinations of the two VPs
    candidates = []
    for sy in (+1, -1):
        for sz in (+1, -1):
            R = build_R_from_vps(vpy, vpz, fx, sy, sz)
            t = solve_t(R, K, img_pts, world_pts)
            C = -R.T @ t
            # Reprojection error
            err = 0.0
            all_in_front = True
            for ip, Xw in zip(img_pts, world_pts):
                p = project(Xw, R, t, K)
                if np.isnan(p[0]):
                    all_in_front = False; err = float("inf"); break
                err += np.hypot(p[0] - ip[0], p[1] - ip[1])
            # Physical validity:
            #   camera outside flume X range (with 100 mm buffer), OR past end Y,
            #   AND above rim by at least 100 mm (Z+ = UP convention).
            outside_x = C[0] < -100 or C[0] > 938
            past_end_y = C[1] < -100 or C[1] > 2030
            above_rim = C[2] > 100
            valid = all_in_front and (outside_x or past_end_y) and above_rim
            candidates.append({
                "sy": sy, "sz": sz, "R": R, "t": t, "C": C,
                "reproj_err": err, "valid": valid,
                "all_in_front": all_in_front,
            })
            print(f"\n  sy={sy:+d} sz={sz:+d}  fx={fx:.0f}  "
                  f"C=({C[0]:+.0f}, {C[1]:+.0f}, {C[2]:+.0f})  reproj={err:.2f}  "
                  f"in_front={all_in_front}  valid={valid}")
    # Pick: valid with lowest err; else lowest err
    valids = [c for c in candidates if c["valid"]]
    if valids:
        best = min(valids, key=lambda c: c["reproj_err"])
        print(f"\nSelected physically-valid candidate: sy={best['sy']}, sz={best['sz']}")
    else:
        best = min(candidates, key=lambda c: c["reproj_err"])
        print(f"\nWARNING: no physically-valid sign combo; using lowest-err: sy={best['sy']}, sz={best['sz']}")
    R, t, C = best["R"], best["t"], best["C"]

    print(f"\n=== Pose ===")
    print(f"fx = {fx:.1f}")
    print(f"R =\n{R}")
    print(f"t  (mm) = {t}")
    print(f"C  (mm) = {C}  ← camera centre in world")
    print(f"standoff from rim_SE = {np.linalg.norm(C - np.array(WORLD['rim_SE'])):.0f} mm")
    print(f"standoff from rim_NE = {np.linalg.norm(C - np.array(WORLD['rim_NE'])):.0f} mm")

    print("\nReprojection residuals:")
    for ip, Xw in zip(img_pts, world_pts):
        p = project(np.array(Xw), R, t, K)
        print(f"  world {Xw.tolist()} meas {ip} proj ({p[0]:.1f},{p[1]:.1f}) err={np.hypot(p[0]-ip[0],p[1]-ip[1]):.2f} px")

    print("\nPredicted projection of all schema landmarks:")
    proj_all = {}
    for name, Xw in WORLD.items():
        p = project(np.array(Xw, float), R, t, K)
        if np.isnan(p[0]):
            proj_all[name] = {"u": None, "v": None, "in_frame": False, "behind_camera": True}
            print(f"  {name:16s} world={Xw} [BEHIND CAMERA]")
        else:
            infr = 0 <= p[0] < 1080 and 0 <= p[1] < 1920
            proj_all[name] = {"u": float(p[0]), "v": float(p[1]), "in_frame": bool(infr), "behind_camera": False}
            print(f"  {name:16s} world={Xw} image=({p[0]:.0f},{p[1]:.0f}) {'[in frame]' if infr else '[OFF-FRAME]'}")

    out = {
        "label": LABEL, "session": 1, "method": "closed_form_VPs+2pts",
        "K": K.tolist(), "R": R.tolist(), "t_mm": t.tolist(),
        "camera_center_world_mm": C.tolist(),
        "fx_px": fx, "vp_Y_px": list(vpy), "vp_Z_px": list(vpz),
        "sign_combo": {"sy": best["sy"], "sz": best["sz"]},
        "all_candidates_considered": [
            {k: (v.tolist() if hasattr(v, "tolist") else v) for k, v in c.items() if k != "R"}
            for c in candidates
        ],
        "all_landmark_projections": proj_all,
    }
    OUT_PATH.write_text(json.dumps(out, indent=2))
    print(f"\nSaved {OUT_PATH.relative_to(REPO)}")

    # Overlay
    img = cv2.imread(str(IMG_PATH))
    for name in ["rim_NE", "rim_SE"]:
        u, v = clicks[name]
        Xw = np.array(WORLD[name], float)
        p = project(Xw, R, t, K)
        cv2.drawMarker(img, (int(u), int(v)), (0, 0, 255), cv2.MARKER_CROSS, 40, 4)
        if not np.isnan(p[0]):
            cv2.drawMarker(img, (int(p[0]), int(p[1])), (0, 255, 0), cv2.MARKER_TILTED_CROSS, 40, 4)
        cv2.putText(img, name, (int(u) + 20, int(v)), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 3)
    for name, info in proj_all.items():
        if info.get("in_frame") and name not in ("rim_NE", "rim_SE"):
            cv2.drawMarker(img, (int(info["u"]), int(info["v"])), (100, 255, 100),
                           cv2.MARKER_TRIANGLE_UP, 30, 3)
            cv2.putText(img, name, (int(info["u"]) + 15, int(info["v"])),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (100, 255, 100), 2)
    cv2.drawMarker(img, (int(vpy[0]), int(vpy[1])), (255, 0, 255), cv2.MARKER_STAR, 60, 4)
    cv2.putText(img, "VP_Y", (int(vpy[0]) + 10, int(vpy[1])), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 0, 255), 3)
    cv2.drawMarker(img, (int(vpz[0]), int(vpz[1])), (0, 255, 255), cv2.MARKER_STAR, 60, 4)
    cv2.putText(img, "VP_Z", (int(vpz[0]) + 10, int(vpz[1])), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 255), 3)
    cv2.imwrite(str(OVERLAY_PATH),
                cv2.resize(img, (img.shape[1] // 2, img.shape[0] // 2)),
                [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f"Saved overlay {OVERLAY_PATH.relative_to(REPO)}")


if __name__ == "__main__":
    main()
