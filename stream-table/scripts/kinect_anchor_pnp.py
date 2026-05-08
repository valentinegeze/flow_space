"""Path 3 — per-phone PnP using Kinect as the world anchor.

Strategy
--------
For each feature the user clicked, we need a 3D point in a shared world frame. The Kinect's
click gives us that: unproject the Kinect color pixel to a 3D ray and intersect with an
assumed bed plane at Z = −kinect_standoff (≈ 770 mm below the Kinect). That gives the 3D
point in the Kinect color camera frame, which we'll use AS the world frame for this run.

Then each phone gets its own PnP solve using the 3D points + its pixel clicks → pose in
the Kinect-camera frame. Phone poses will all be in the same frame (the Kinect's), giving
cross-camera consistency.

Limitation
----------
Assumes clicked features are on the bed surface (≈770 mm below Kinect). Features on the rim
top or at other depths will have wrong 3D. Phase 2 will swap assumed depth for actual
Kinect depth-map lookup.

Usage
-----
  python3 scripts/kinect_anchor_pnp.py
"""
import cv2, json, sys
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO = Path(__file__).resolve().parent.parent

# ─── Kinect color intrinsics (scaled from factory 4096×3072 → 1920×1080) ────
# The factory cal is at 4096×3072. The recorded stream is 1920×1080, a crop/resize of that.
# K4A's 1920×1080 color mode is a cropped region of the 4096×3072 sensor; horizontal scale
# ≈ 1920/2560 = 0.75 (K4A crops to 2560×1440 then downsamples). This is approximate — we'll
# trust it for an initial solve.
# From kinect_intrinsics.json: at 4096×3072, fx=1940.2, fy=1939.9, cx=2051.4, cy=1544.8.
# For 1920×1080 (FHD): approximate fx' ≈ 910, cx' ≈ 960, cy' ≈ 540.
KINECT_COLOR_ORIG_W, KINECT_COLOR_ORIG_H = 1920, 1080  # stream resolution BEFORE our rotation
KINECT_COLOR_FX = 910.0  # approximate; TODO refine from factory blob + K4A calib
KINECT_COLOR_CX = 960.0
KINECT_COLOR_CY = 540.0

KINECT_ROT_CW_DEG = 90  # we rotated 90° CW on disk; need to undo for color-frame coords

# Assumed Kinect-to-bed standoff (mm). From probe/summary.md: median depth = 772 mm.
KINECT_TO_BED_MM = 772.0


def unrotate_kinect_click(u_rot, v_rot):
    """Undo the 90° CW rotation we applied to the saved Kinect frame.
    The stored file after rotation is 1080×1920 (new W × H). Original was 1920×1080.
    90° CW rotation: new_u = H_old - 1 - old_v, new_v = old_u. Inverting:
      old_u = new_v
      old_v = H_old - 1 - new_u = 1079 - new_u
    """
    old_u = v_rot
    old_v = KINECT_COLOR_ORIG_H - 1 - u_rot
    return float(old_u), float(old_v)


def kinect_click_to_3d(u_rot, v_rot, assumed_depth_mm=KINECT_TO_BED_MM):
    """Convert a clicked pixel in the rotated Kinect frame to a 3D point in the
    Kinect color-camera coordinate frame, assuming the clicked feature lies at
    the given depth (mm) from the camera."""
    old_u, old_v = unrotate_kinect_click(u_rot, v_rot)
    X = (old_u - KINECT_COLOR_CX) * assumed_depth_mm / KINECT_COLOR_FX
    Y = (old_v - KINECT_COLOR_CY) * assumed_depth_mm / KINECT_COLOR_FX
    Z = assumed_depth_mm
    return np.array([X, Y, Z])


def run_pnp_for_phone(label, world_pts, img_pts, dims, default_fx):
    """PnP solve; world_pts shape (N, 3), img_pts shape (N, 2). Returns R, t, fx (used) or None."""
    if len(world_pts) < 4:
        print(f"  [{label}] only {len(world_pts)} pts, skipping")
        return None
    W, H = dims
    fx = default_fx
    K = np.array([[fx, 0, W/2], [0, fx, H/2], [0, 0, 1]], dtype=np.float64)
    flag = cv2.SOLVEPNP_EPNP if len(world_pts) < 6 else cv2.SOLVEPNP_ITERATIVE
    ok, rvec, tvec = cv2.solvePnP(
        world_pts.astype(np.float64), img_pts.astype(np.float64),
        K, None, flags=flag)
    if not ok:
        print(f"  [{label}] PnP failed")
        return None
    R = cv2.Rodrigues(rvec)[0]
    t = tvec.flatten()
    return {"R": R, "t": t, "fx": fx, "K": K.tolist()}


def reproj_err(R, t, K, world_pts, img_pts):
    errs = []
    for Xw, (u_meas, v_meas) in zip(world_pts, img_pts):
        Xc = R @ Xw + t
        if Xc[2] <= 0:
            errs.append(float("inf")); continue
        u_proj = K[0][0] * Xc[0]/Xc[2] + K[0][2]
        v_proj = K[1][1] * Xc[1]/Xc[2] + K[1][2]
        errs.append(float(np.hypot(u_proj - u_meas, v_proj - v_meas)))
    return errs


PHONE_DIMS = {
    "anna":      (720, 1280),
    "valentine": (1080, 1920),
    "sophia":    (1080, 1920),
    "javier":    (1920, 1080),
}
PHONE_DEFAULT_FX = {
    "anna":      480.0,
    "valentine": 780.0,
    "sophia":    763.0,
    "javier":    1681.0,
}


def main():
    data = json.loads((REPO / "calib" / "cross_features_merged.json").read_text())
    feat_in = data["features"]
    print(f"{len(feat_in)} features from {data.get('moment', '?')}")

    # For each feature: compute 3D from Kinect click (in Kinect camera frame)
    feats_with_3d = []
    for f in feat_in:
        clicks = f["clicks_per_phone"]
        if "kinect" not in clicks:
            print(f"  [{f['name']}] no kinect click — skipping (can't anchor)")
            continue
        u, v = clicks["kinect"]
        X_kc = kinect_click_to_3d(u, v)
        feats_with_3d.append((f["name"], X_kc, clicks))
        print(f"  [{f['name']}] kinect ({u:.0f},{v:.0f}) → 3D (Kinect frame): ({X_kc[0]:+7.1f}, {X_kc[1]:+7.1f}, {X_kc[2]:+7.1f}) mm")

    if not feats_with_3d:
        raise SystemExit("No features with Kinect clicks. Cannot anchor.")

    print()
    # Per-phone PnP
    for label in ["anna", "valentine", "sophia", "javier"]:
        world_pts = []
        img_pts = []
        for name, X_kc, clicks in feats_with_3d:
            if label in clicks:
                world_pts.append(X_kc)
                img_pts.append(clicks[label])
        if not world_pts:
            print(f"[{label}] no clicks, skipping")
            continue
        world_pts = np.array(world_pts)
        img_pts = np.array(img_pts)
        pose = run_pnp_for_phone(label, world_pts, img_pts, PHONE_DIMS[label], PHONE_DEFAULT_FX[label])
        if pose is None:
            continue
        K = np.asarray(pose["K"])
        errs = reproj_err(pose["R"], pose["t"], K, world_pts, img_pts)
        C = -pose["R"].T @ pose["t"]
        print(f"[{label}] {len(world_pts)} pts, fx={pose['fx']:.0f}  "
              f"mean reproj={np.mean(errs):.1f} max={np.max(errs):.1f} px  "
              f"C_kinectFrame=({C[0]:+.0f}, {C[1]:+.0f}, {C[2]:+.0f}) mm")
        # Save
        out = {
            "label": label, "session": 1,
            "method": "kinect_anchored_pnp_path3_approximate_bed_depth",
            "K": [[float(pose["fx"]), 0, PHONE_DIMS[label][0]/2],
                  [0, float(pose["fx"]), PHONE_DIMS[label][1]/2],
                  [0, 0, 1]],
            "R": pose["R"].tolist(),
            "t_mm": pose["t"].tolist(),
            "camera_center_kinectFrame_mm": C.tolist(),
            "fx_px": float(pose["fx"]),
            "world_frame": "Kinect color camera (NOT flume frame)",
            "notes": [
                f"Anchored to Kinect via assumed bed depth = {KINECT_TO_BED_MM} mm from Kinect camera.",
                f"{len(world_pts)} features used. Mean reprojection error: {np.mean(errs):.1f} px, max {np.max(errs):.1f} px.",
                "This pose is in KINECT CAMERA FRAME, not the flume world frame.",
                "To convert to flume frame: need a rigid transform from Kinect frame → flume frame, "
                "computed from 3+ known world points (e.g. rim corners) with Kinect depth lookup.",
            ],
        }
        out_path = REPO / "calib" / f"pose_{label}_kinect_anchored.json"
        out_path.write_text(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
