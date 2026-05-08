"""
Stage 3 — Academic-exercise pose solve for javier session 1 from landmarks.

Method:
  1. Detect VP_Y (flume-length) automatically from Hough lines on sediment stripes.
  2. Compute VP_X (flume-width) by intersecting two hand-specified cross-rim lines.
  3. Recover fx from VP orthogonality (image-of-absolute-conic constraint), since VP_X and
     VP_Y correspond to orthogonal world directions.
  4. Build rotation R from the two VPs plus right-handed cross product.
  5. Solve translation t via least-squares linear system using the two visible rim corners
     (rim_NE, rim_SE) as 3D↔2D point correspondences.
  6. Report reprojection residuals on the point correspondences and compare solved fx to the
     EXIF-derived prior.

Hand-specified landmarks were estimated visually from the t=30 s reference frame and are
approximate; user should click refined positions via calib/annotate.html for a precise solve.
"""
import cv2, numpy as np, json, sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
IMG_PATH = REPO / "calib" / "reference_frames" / "javier.jpg"
OUT_PATH = REPO / "calib" / "pose_javier.json"
OVERLAY_PATH = REPO / "calib" / "pose_javier_overlay.jpg"

# Principal point: image centre
K_CX, K_CY = 540.0, 960.0
# EXIF-derived prior (26mm-equiv, iPhone main wide) — see calib/intrinsics.json
FX_PRIOR = 780.0

# Hand-specified landmark pixels (estimates; refine via annotate.html)
RIM_NE_PIX = (350, 230)      # world (838, 0, 0)
RIM_SE_PIX = (580, 1700)     # world (838, 1930, 0)
# Two points on the far cross-rim (Y=0, Z=0, varying X) — gives one image line along world X
FAR_CROSS_RIM_PTS = [(50, 100), (350, 230)]
# Two points on the near cross-rim (Y=1930, Z=0, varying X)
NEAR_CROSS_RIM_PTS = [(100, 1700), (580, 1700)]

POINT_CORRESPONDENCES = [
    ("rim_NE", RIM_NE_PIX[0], RIM_NE_PIX[1], 838.0, 0.0, 0.0),
    ("rim_SE", RIM_SE_PIX[0], RIM_SE_PIX[1], 838.0, 1930.0, 0.0),
]


def detect_vp_y(img_path: Path):
    """Detect VP_Y (flume-length) by Hough-clustering long near-vertical lines in the
    sediment region and computing their common intersection via least squares."""
    img = cv2.imread(str(img_path))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 1.0)
    edges = cv2.Canny(gray, 50, 150)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, 200,
                            minLineLength=500, maxLineGap=20)
    if lines is None:
        raise RuntimeError("No Hough lines detected; lower thresholds.")
    # Keep long, near-vertical lines whose midpoint sits in the sediment region (u < 500)
    keep = []
    for l in lines[:, 0]:
        x1, y1, x2, y2 = l
        ang = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        umid = (x1 + x2) / 2
        if abs(abs(ang) - 90) < 12 and umid < 500:
            keep.append((x1, y1, x2, y2))
    if len(keep) < 3:
        raise RuntimeError(f"Only {len(keep)} valid sediment stripes found; need ≥3.")
    # Line ax+by+c=0, normalize so a^2+b^2=1
    A = []
    for x1, y1, x2, y2 in keep:
        a, b = (y2 - y1), -(x2 - x1)
        c = -(a * x1 + b * y1)
        n = np.hypot(a, b)
        A.append([a / n, b / n, c / n])
    A = np.array(A, float)
    # Solve A @ [u, v, 1]^T ≈ 0 by least-squares: minimize ||A[:, :2] [u,v] + A[:, 2]||
    sol, *_ = np.linalg.lstsq(A[:, :2], -A[:, 2], rcond=None)
    return float(sol[0]), float(sol[1]), len(keep)


def vp_from_two_lines(pts_pairs):
    """Intersection of two 2D lines defined by pairs of endpoints."""
    eqs = []
    for (p1, p2) in pts_pairs:
        a = p2[1] - p1[1]
        b = p1[0] - p2[0]
        c = -(a * p1[0] + b * p1[1])
        eqs.append([a, b, c])
    eqs = np.array(eqs, float)
    sol, *_ = np.linalg.lstsq(eqs[:, :2], -eqs[:, 2], rcond=None)
    return float(sol[0]), float(sol[1])


def solve_fx_from_vps(vp_x, vp_y, cx, cy):
    """fx from orthogonality of the two world directions:
       (K^-1 V_X) . (K^-1 V_Y) = 0
       With fx=fy=f, cx,cy at centre:
         (u_X - cx)(u_Y - cx) + (v_X - cy)(v_Y - cy) + f^2 = 0
         f^2 = -[(u_X-cx)(u_Y-cx) + (v_X-cy)(v_Y-cy)]
    """
    dp = (vp_x[0] - cx) * (vp_y[0] - cx) + (vp_x[1] - cy) * (vp_y[1] - cy)
    return dp


def build_rotation(vp_x, vp_y, K):
    Kinv = np.linalg.inv(K)
    rx = Kinv @ np.array([vp_x[0], vp_x[1], 1.0])
    ry = Kinv @ np.array([vp_y[0], vp_y[1], 1.0])
    rx /= np.linalg.norm(rx)
    ry /= np.linalg.norm(ry)
    # Gram-Schmidt orthogonalisation (VPs aren't perfectly orthogonal in practice)
    ry = ry - np.dot(ry, rx) * rx
    ry /= np.linalg.norm(ry)
    rz = np.cross(rx, ry)
    R = np.column_stack([rx, ry, rz])
    # Enforce right-handed proper rotation
    if np.linalg.det(R) < 0:
        rz = -rz
        R = np.column_stack([rx, ry, rz])
    return R


def solve_translation(R, K, pts_img, pts_world):
    """Linear LS for t given R, K, and 3D↔2D point correspondences."""
    fx = K[0, 0]
    cx, cy = K[0, 2], K[1, 2]
    rows, rhs = [], []
    for (u, v), Xw in zip(pts_img, pts_world):
        r1, r2, r3 = R
        r1X, r2X, r3X = r1.dot(Xw), r2.dot(Xw), r3.dot(Xw)
        rows.append([fx, 0, -(u - cx)])
        rhs.append((u - cx) * r3X - fx * r1X)
        rows.append([0, fx, -(v - cy)])
        rhs.append((v - cy) * r3X - fx * r2X)
    A, b = np.array(rows, float), np.array(rhs, float)
    t, *_ = np.linalg.lstsq(A, b, rcond=None)
    return t


def project(X_w, R, t, K):
    Xc = R @ X_w + t
    pix = K @ Xc
    return pix[:2] / pix[2]


def main():
    print(f"Loading {IMG_PATH}")
    vpy = detect_vp_y(IMG_PATH)
    print(f"VP_Y (sediment stripes, {vpy[2]} lines): ({vpy[0]:.0f}, {vpy[1]:.0f})")

    vpx = vp_from_two_lines([tuple(FAR_CROSS_RIM_PTS), tuple(NEAR_CROSS_RIM_PTS)])
    print(f"VP_X (cross-rim intersection): ({vpx[0]:.0f}, {vpx[1]:.0f})")

    dp = solve_fx_from_vps(vpx, (vpy[0], vpy[1]), K_CX, K_CY)
    print(f"VP orthogonality dot product (must be < 0 for real fx): {dp:.1f}")
    if dp < 0:
        fx = float(np.sqrt(-dp))
        fx_source = "orthogonality_of_VPs"
    else:
        fx = FX_PRIOR
        fx_source = "fallback_EXIF_prior"
    print(f"fx = {fx:.1f} px  (EXIF prior: {FX_PRIOR:.1f}, source: {fx_source})")

    K = np.array([[fx, 0, K_CX], [0, fx, K_CY], [0, 0, 1]], float)
    R = build_rotation(vpx, (vpy[0], vpy[1]), K)
    print(f"R:\n{R}")
    print(f"det(R) = {np.linalg.det(R):.6f}")

    pts_img = np.array([[p[1], p[2]] for p in POINT_CORRESPONDENCES], float)
    pts_world = np.array([[p[3], p[4], p[5]] for p in POINT_CORRESPONDENCES], float)
    t = solve_translation(R, K, pts_img, pts_world)
    print(f"t (camera translation, mm): {t}")

    C = -R.T @ t  # camera centre in world coords
    print(f"camera centre in world (mm): {C}")
    print(f"standoff |C - rim_SE| = {np.linalg.norm(C - [838, 1930, 0]):.1f} mm")
    print(f"standoff |C - rim_NE| = {np.linalg.norm(C - [838, 0, 0]):.1f} mm")

    print("\nReprojection residuals at control points:")
    residuals = []
    for name, u, v, Xw0, Xw1, Xw2 in POINT_CORRESPONDENCES:
        Xw = np.array([Xw0, Xw1, Xw2], float)
        proj = project(Xw, R, t, K)
        err = np.hypot(proj[0] - u, proj[1] - v)
        print(f"  {name}: meas=({u:>4d},{v:>4d})  proj=({proj[0]:>7.1f},{proj[1]:>7.1f})  err={err:>6.1f} px")
        residuals.append(float(err))

    # Sanity checks on the other 2 rim corners (rim_NW and rim_SW at X=0)
    print("\nPredicted image positions of off-frame far-side rim corners:")
    for name, Xw in [("rim_NW", [0, 0, 0]), ("rim_SW", [0, 1930, 0])]:
        proj = project(np.array(Xw, float), R, t, K)
        print(f"  {name} at world {Xw} -> image ({proj[0]:.0f}, {proj[1]:.0f}) " +
              ("[in frame]" if 0 <= proj[0] < 1080 and 0 <= proj[1] < 1920 else "[OFF-FRAME]"))

    # Output
    out = {
        "label": "javier",
        "session": 1,
        "K": K.tolist(),
        "R": R.tolist(),
        "t_mm": t.tolist(),
        "camera_center_world_mm": C.tolist(),
        "fx_solved_px": fx,
        "fx_source": fx_source,
        "fx_prior_px": FX_PRIOR,
        "vp_X_px": list(vpx),
        "vp_Y_px": [vpy[0], vpy[1]],
        "num_sediment_lines": vpy[2],
        "point_correspondences": [
            {"name": n, "u": u, "v": v, "X": X0, "Y": X1, "Z": X2, "residual_px": r}
            for ((n, u, v, X0, X1, X2), r) in zip(POINT_CORRESPONDENCES, residuals)
        ],
        "hand_clicked_lines": {
            "far_cross_rim_px":  FAR_CROSS_RIM_PTS,
            "near_cross_rim_px": NEAR_CROSS_RIM_PTS,
        },
        "notes": [
            "Landmark pixels were estimated visually from the t=30s frame by the author.",
            "Pixel accuracy is nominal (±10-20 px). Refined click via calib/annotate.html.",
            "Standpipe not used — session uses a linear outlet per filename.",
            "Only 2 rim corners are in-frame (rim_NE, rim_SE). The other 2 (rim_NW, rim_SW) at X=0 are cropped off-left.",
        ],
    }
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nSaved {OUT_PATH.relative_to(REPO)}")

    # Overlay visualisation
    img = cv2.imread(str(IMG_PATH))
    def draw_pt(u, v, color, label):
        cv2.drawMarker(img, (int(u), int(v)), color, cv2.MARKER_CROSS, 40, 4)
        cv2.putText(img, label, (int(u) + 20, int(v)), cv2.FONT_HERSHEY_SIMPLEX, 1.0, color, 3)
    # VPs
    draw_pt(vpx[0], vpx[1], (0, 255, 255), "VP_X")
    draw_pt(vpy[0], vpy[1], (255, 0, 255), "VP_Y")
    # Measured vs reprojected rim corners
    for n, u, v, X0, X1, X2 in POINT_CORRESPONDENCES:
        proj = project(np.array([X0, X1, X2], float), R, t, K)
        cv2.drawMarker(img, (int(u), int(v)), (0, 0, 255), cv2.MARKER_CROSS, 40, 4)
        cv2.drawMarker(img, (int(proj[0]), int(proj[1])), (0, 255, 0), cv2.MARKER_TILTED_CROSS, 40, 4)
        cv2.putText(img, f"{n} meas", (int(u) + 20, int(v)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 3)
    # Hand-specified rim lines
    for (p1, p2) in [FAR_CROSS_RIM_PTS, NEAR_CROSS_RIM_PTS]:
        cv2.line(img, tuple(map(int, p1)), tuple(map(int, p2)), (0, 255, 255), 3)
    cv2.imwrite(str(OVERLAY_PATH),
                cv2.resize(img, (img.shape[1] // 2, img.shape[0] // 2)),
                [cv2.IMWRITE_JPEG_QUALITY, 90])
    print(f"Saved overlay to {OVERLAY_PATH.relative_to(REPO)}")


if __name__ == "__main__":
    main()
