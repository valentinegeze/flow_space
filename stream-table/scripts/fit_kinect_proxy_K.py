#!/usr/bin/env python3
"""
fit_kinect_proxy_K.py
=====================
Empirically fit the Kinect color-PROXY intrinsic [fx, fy, cx, cy] from
depth-anchored 3D points + 2D proxy clicks.

This is a one-time offline calibration. Output is a JSON file that
pair_tune.html (and other tools) can load instead of the buggy
scaled-from-factory derivation.

Pipeline
--------
1. Load factory intrinsics (color native + depth native + extrinsics).
   Azure Kinect convention: each camera's Rt is FROM that camera TO depth
   (depth is reference). So X_depth = R_color * X_color + T_color, and we
   invert to get depth -> color.
2. Load a Kinect depth frame at the same moment as the color proxy.
3. Build a sparse depth map registered to the COLOR NATIVE frame (4096x3072):
   project every depth pixel into color-native via the extrinsics, with
   z-buffering.
4. For each cross-feature with a Kinect proxy click:
   For each rotation hypothesis (CW, CCW):
     a. Map proxy click -> native color pixel via the
        crop->scale->rotate chain (inverted).
     b. Look up depth at that native pixel via bilinear interp.
     c. Lift to 3D in native color frame using K_color_native.
     d. Apply 90-deg-about-Z rotation to express in proxy camera frame.
5. Fit K_proxy = [fx, fy, cx, cy] via Levenberg-Marquardt against
   (proxy_pixel, 3D_in_proxy_frame) pairs, separately for each rotation.
6. Pick rotation with lower residuals; save K + diagnostics.

Usage
-----
  python scripts/fit_kinect_proxy_K.py \\
      --depth data/depth/clack_60s.png \\
      --features calib/cross_features_merged.json \\
      --intrinsics calib/kinect_intrinsics.json \\
      --out calib/kinect_proxy_intrinsics_fitted.json

Notes
-----
- Depth file must be at the same moment as kinect.jpg (clack+60s in this
  project). Use whatever script you used to extract the proxy frame, but
  on the depth track.
- Depth file format: PNG-16 (uint16, mm) or .npy (uint16/float, mm), shape
  must match factory depth (1024x1024 for the Azure Kinect WFOV mode).
- The proxy<->native pixel mapping is parameterized by --crop-top-bottom
  and --scale. Defaults assume crop top/bottom 384px (4:3 -> 16:9) then
  uniform scale by 1920/4096. If your extraction used different params,
  pass them.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt
from scipy.optimize import least_squares


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------

def load_factory_intrinsics(path):
    with open(path) as f:
        kintr = json.load(f)
    color = next(c for c in kintr['cameras']
                 if 'PhotoVideo' in c.get('purpose', ''))
    depth = next(c for c in kintr['cameras']
                 if 'Depth' in c.get('purpose', ''))

    K_color = np.array([[color['fx_px'], 0, color['cx_px']],
                        [0, color['fy_px'], color['cy_px']],
                        [0, 0, 1]], dtype=np.float64)
    K_depth = np.array([[depth['fx_px'], 0, depth['cx_px']],
                        [0, depth['fy_px'], depth['cy_px']],
                        [0, 0, 1]], dtype=np.float64)

    # Azure Kinect: each camera's Rt is FROM that camera TO depth (depth is
    # reference). Color's Rt: X_depth = R_c2d @ X_color + T_c2d.
    # Invert to get depth -> color.
    R_c2d = np.array(color['Rt']['R'], dtype=np.float64).reshape(3, 3)
    t_c2d_mm = np.array(color['Rt']['T'], dtype=np.float64) * 1000.0  # m -> mm
    R_d2c = R_c2d.T
    t_d2c_mm = -R_c2d.T @ t_c2d_mm

    return {
        'K_color': K_color, 'K_depth': K_depth,
        'W_color': color['W_px'], 'H_color': color['H_px'],
        'W_depth': depth['W_px'], 'H_depth': depth['H_px'],
        'R_d2c': R_d2c, 't_d2c_mm': t_d2c_mm,
        'R_c2d': R_c2d, 't_c2d_mm': t_c2d_mm,
    }


def load_depth_frame(path):
    """Load depth as a numpy array in mm units (no shape enforcement)."""
    p = Path(path)
    if p.suffix.lower() in ('.png', '.tif', '.tiff'):
        arr = np.array(Image.open(path))
    elif p.suffix.lower() == '.npy':
        arr = np.load(path)
    else:
        raise ValueError(f"Unsupported depth extension: {p.suffix}")
    return arr.astype(np.float32)


def adapt_depth_K_for_actual_resolution(intr, actual_shape):
    """
    The factory K_depth in kinect_intrinsics.json is for 1024×1024 (WFOV unbinned).
    The recording in this project is 640×576 (NFOV unbinned), which Microsoft's
    convention treats as a centered crop of the WFOV sensor — so fx/fy are unchanged
    and cx/cy shift by (W_factory - W_actual)/2 in each axis.

    This is approximate — NFOV and WFOV technically use different optical paths —
    but it's accurate enough for our purposes (per scripts/kinect_depth_pointcloud.py).
    """
    H_a, W_a = actual_shape
    H_f, W_f = intr['H_depth'], intr['W_depth']
    if (H_a, W_a) == (H_f, W_f):
        return  # nothing to do
    dx = (W_f - W_a) / 2.0
    dy = (H_f - H_a) / 2.0
    K_old = intr['K_depth'].copy()
    intr['K_depth'][0, 2] -= dx
    intr['K_depth'][1, 2] -= dy
    intr['W_depth'] = W_a
    intr['H_depth'] = H_a
    print(f"  depth shape {W_a}x{H_a} ≠ factory {W_f}x{H_f} — assuming NFOV-as-WFOV-crop;")
    print(f"  shifted depth principal point by (-{dx:.1f}, -{dy:.1f}) px:")
    print(f"     was: cx={K_old[0,2]:.1f}, cy={K_old[1,2]:.1f}")
    print(f"     now: cx={intr['K_depth'][0,2]:.1f}, cy={intr['K_depth'][1,2]:.1f}")


# ---------------------------------------------------------------------------
# Depth registration
# ---------------------------------------------------------------------------

def build_depth_in_color_native(depth_mm, intr):
    """
    Project every valid depth pixel into the color-native image plane.
    Returns float32 H_color x W_color array, NaN where unmapped.
    Z-buffered (closer wins).
    """
    H_d, W_d = depth_mm.shape
    H_c, W_c = intr['H_color'], intr['W_color']

    u_d, v_d = np.meshgrid(np.arange(W_d), np.arange(H_d))
    u_d = u_d.astype(np.float32).ravel()
    v_d = v_d.astype(np.float32).ravel()
    z_d = depth_mm.ravel()

    # Drop invalid (Kinect uses 0 for "no return"; also drop unreasonably close)
    valid = z_d > 100.0
    u_d, v_d, z_d = u_d[valid], v_d[valid], z_d[valid]

    K_d = intr['K_depth']
    K_c = intr['K_color']
    R = intr['R_d2c']
    t = intr['t_d2c_mm']

    # Lift to 3D in depth frame
    X_d = (u_d - K_d[0, 2]) * z_d / K_d[0, 0]
    Y_d = (v_d - K_d[1, 2]) * z_d / K_d[1, 1]
    Z_d = z_d
    P_d = np.stack([X_d, Y_d, Z_d], axis=0)  # 3 x N

    # Transform to color frame
    P_c = R @ P_d + t.reshape(3, 1)
    Xc, Yc, Zc = P_c[0], P_c[1], P_c[2]

    # Project into color native
    in_front = Zc > 50.0
    Xc, Yc, Zc = Xc[in_front], Yc[in_front], Zc[in_front]
    u_c = K_c[0, 0] * Xc / Zc + K_c[0, 2]
    v_c = K_c[1, 1] * Yc / Zc + K_c[1, 2]

    u_i = np.round(u_c).astype(int)
    v_i = np.round(v_c).astype(int)
    in_bounds = (u_i >= 0) & (u_i < W_c) & (v_i >= 0) & (v_i < H_c)
    u_i, v_i, Zc = u_i[in_bounds], v_i[in_bounds], Zc[in_bounds]

    # Z-buffer: write farther first, closer last (so closer wins)
    order = np.argsort(-Zc)
    u_i, v_i, Zc = u_i[order], v_i[order], Zc[order]

    depth_color = np.full((H_c, W_c), np.nan, dtype=np.float32)
    depth_color[v_i, u_i] = Zc

    n_valid = int(np.sum(~np.isnan(depth_color)))
    print(f"  sparse depth-in-color-native: {n_valid} valid px "
          f"({100.0 * n_valid / (H_c * W_c):.2f}%)")
    return depth_color


def fill_depth_holes_nearest(depth_color, max_radius_px):
    """
    The sparse depth-in-color projection leaves most pixels NaN because the depth
    grid is far coarser than the color grid (640x576 → 4096x3072 ≈ 1:6 mapping).
    Fill each NaN pixel with the value of the nearest valid pixel, but only if that
    nearest valid pixel is within `max_radius_px`. This yields a dense local
    interpolation without wildly extrapolating beyond the depth field of view.
    """
    valid = ~np.isnan(depth_color)
    if not valid.any():
        return depth_color
    dist, idx = distance_transform_edt(~valid, return_indices=True)
    nearest = depth_color[tuple(idx)]
    filled = np.where(dist <= max_radius_px, nearest, np.nan)
    n_filled = int(np.sum(~np.isnan(filled)))
    H_c, W_c = depth_color.shape
    print(f"  filled depth-in-color-native (radius ≤{max_radius_px}px): "
          f"{n_filled} valid px ({100.0 * n_filled / (H_c * W_c):.2f}%)")
    return filled


# ---------------------------------------------------------------------------
# Proxy <-> native pixel mapping
# ---------------------------------------------------------------------------

def proxy_to_native(u_p, v_p, rotation, crop_top_bottom, scale):
    """
    Invert the proxy extraction chain:
      native (4096x3072) --crop top/bottom--> 4096x(3072-2*crop)
                         --scale uniform---->  scaled
                         --rotate 90---------> proxy (1080x1920)
    Returns (u_native, v_native) in continuous coords.
    """
    if rotation == 'cw':
        # Forward CW (image): (u_s, v_s) -> (H_s - v_s, u_s) where H_s = 1080.
        # Inverse: u_s = v_p, v_s = H_s - u_p.
        H_s = 1080.0
        u_s = v_p
        v_s = H_s - u_p
    elif rotation == 'ccw':
        # Forward CCW (image): (u_s, v_s) -> (v_s, W_s - u_s) where W_s = 1920.
        # Inverse: u_s = W_s - v_p, v_s = u_p.
        W_s = 1920.0
        u_s = W_s - v_p
        v_s = u_p
    else:
        raise ValueError(f"rotation must be 'cw' or 'ccw', got {rotation!r}")

    # Inverse uniform scale
    u_c = u_s / scale
    v_c = v_s / scale

    # Inverse top/bottom crop
    u_n = u_c
    v_n = v_c + crop_top_bottom
    return u_n, v_n


def lookup_depth_bilinear(depth_color, u, v):
    """Bilinear interp; falls back to mean of available neighbors."""
    H, W = depth_color.shape
    if not (0 <= u < W - 1 and 0 <= v < H - 1):
        return np.nan
    u0, v0 = int(np.floor(u)), int(np.floor(v))
    du, dv = u - u0, v - v0
    z00 = depth_color[v0, u0]
    z01 = depth_color[v0, u0 + 1]
    z10 = depth_color[v0 + 1, u0]
    z11 = depth_color[v0 + 1, u0 + 1]
    if any(np.isnan(z) for z in (z00, z01, z10, z11)):
        avail = [z for z in (z00, z01, z10, z11) if not np.isnan(z)]
        return float(np.mean(avail)) if avail else np.nan
    return float(((1 - du) * (1 - dv) * z00 + du * (1 - dv) * z01 +
                  (1 - du) * dv * z10 + du * dv * z11))


# ---------------------------------------------------------------------------
# 3D lift + camera-frame rotation
# ---------------------------------------------------------------------------

def lift_to_3d(u_n, v_n, z_mm, K_color):
    """Native pixel + depth -> 3D in native color frame (mm)."""
    X = (u_n - K_color[0, 2]) * z_mm / K_color[0, 0]
    Y = (v_n - K_color[1, 2]) * z_mm / K_color[1, 1]
    return np.array([X, Y, z_mm])


def rotate_3d_for_image_rotation(P_native, rotation):
    """
    The 90-degree image rotation about the optical axis corresponds to a
    90-deg rotation of the camera frame about Z. Worked out from
    u_p = H - v_n, v_p = u_n (CW) and substituting into the projection
    equations:
      CW : X_proxy = -Y_native, Y_proxy =  X_native, Z_proxy = Z_native
      CCW: X_proxy =  Y_native, Y_proxy = -X_native, Z_proxy = Z_native
    """
    X, Y, Z = P_native
    if rotation == 'cw':
        return np.array([-Y, X, Z])
    elif rotation == 'ccw':
        return np.array([Y, -X, Z])
    else:
        raise ValueError(f"rotation must be 'cw' or 'ccw', got {rotation!r}")


# ---------------------------------------------------------------------------
# K fit
# ---------------------------------------------------------------------------

def fit_K_proxy(observations, K0=None):
    """
    observations: list of dicts with 'uv_proxy' (2,) and 'P_proxy_mm' (3,).
    Returns dict with K, residuals, etc.
    """
    if K0 is None:
        K0 = [900.0, 900.0, 540.0, 960.0]  # Option A guess

    uvs = np.array([o['uv_proxy'] for o in observations], dtype=np.float64)
    Ps = np.array([o['P_proxy_mm'] for o in observations], dtype=np.float64)

    def residuals(K):
        fx, fy, cx, cy = K
        u_pred = fx * Ps[:, 0] / Ps[:, 2] + cx
        v_pred = fy * Ps[:, 1] / Ps[:, 2] + cy
        return np.concatenate([uvs[:, 0] - u_pred, uvs[:, 1] - v_pred])

    result = least_squares(residuals, K0, method='lm')
    r = residuals(result.x)
    n = len(observations)
    per_feat = np.sqrt(r[:n] ** 2 + r[n:] ** 2)
    return {
        'K': result.x.tolist(),  # [fx, fy, cx, cy]
        'mean_residual_px': float(np.mean(per_feat)),
        'max_residual_px': float(np.max(per_feat)),
        'per_feature_residual_px': per_feat.tolist(),
        'converged': bool(result.success),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--depth', required=True,
                    help='Kinect depth frame at clack+60s (PNG-16 mm or .npy)')
    ap.add_argument('--features', default='calib/cross_features_merged.json')
    ap.add_argument('--intrinsics', default='calib/kinect_intrinsics.json')
    ap.add_argument('--proxy-w', type=int, default=1080)
    ap.add_argument('--proxy-h', type=int, default=1920)
    ap.add_argument('--crop-top-bottom', type=int, default=384,
                    help='Pixels cropped from top AND bottom of native (default 384, '
                         'taking 4096x3072 -> 4096x2304 = 16:9)')
    ap.add_argument('--scale', type=float, default=None,
                    help='Uniform scale from cropped-native to scaled '
                         '(default = proxy_h / native_w = 1920/4096 = 0.46875)')
    ap.add_argument('--rotation', choices=['cw', 'ccw', 'auto'], default='auto')
    ap.add_argument('--fill-radius-px', type=int, default=8,
                    help='Max color-pixel radius for nearest-neighbor depth-hole fill '
                         '(default 8). Increase if click pixels still land on NaN gaps.')
    ap.add_argument('--out', default='calib/kinect_proxy_intrinsics_fitted.json')
    args = ap.parse_args()

    # ---- Load ----
    print("Loading factory intrinsics...")
    intr = load_factory_intrinsics(args.intrinsics)
    print(f"  color native {intr['W_color']}x{intr['H_color']}  "
          f"K=[{intr['K_color'][0,0]:.1f}, {intr['K_color'][1,1]:.1f}, "
          f"{intr['K_color'][0,2]:.1f}, {intr['K_color'][1,2]:.1f}]")
    print(f"  depth native {intr['W_depth']}x{intr['H_depth']}  "
          f"K=[{intr['K_depth'][0,0]:.1f}, {intr['K_depth'][1,1]:.1f}, "
          f"{intr['K_depth'][0,2]:.1f}, {intr['K_depth'][1,2]:.1f}]")
    print(f"  depth->color t (mm): "
          f"[{intr['t_d2c_mm'][0]:+.1f}, {intr['t_d2c_mm'][1]:+.1f}, "
          f"{intr['t_d2c_mm'][2]:+.1f}]  "
          f"(should be ~30mm in X for the Azure Kinect side-by-side layout)")

    if args.scale is None:
        args.scale = args.proxy_h / intr['W_color']
        print(f"  default scale {args.scale:.5f} (proxy_h/native_w)")

    print("Loading depth frame...")
    depth_mm = load_depth_frame(args.depth)
    adapt_depth_K_for_actual_resolution(intr, depth_mm.shape)
    valid = depth_mm > 0
    if valid.sum() == 0:
        print("ERROR: depth frame is empty.")
        sys.exit(1)
    print(f"  depth range {depth_mm[valid].min():.0f}-{depth_mm[valid].max():.0f} mm  "
          f"({valid.sum()} valid px)")

    print("Building depth-in-color-native registration...")
    depth_color = build_depth_in_color_native(depth_mm, intr)
    depth_color = fill_depth_holes_nearest(depth_color, args.fill_radius_px)

    print("Loading features...")
    with open(args.features) as f:
        feats = json.load(f)
    kfeats = []
    for ft in feats['features']:
        if 'kinect' in ft['clicks_per_phone']:
            u, v = ft['clicks_per_phone']['kinect']
            kfeats.append({'name': ft['name'], 'u_proxy': float(u), 'v_proxy': float(v)})
    print(f"  {len(kfeats)} features have Kinect clicks")

    # ---- Try each rotation hypothesis ----
    rotations = ['cw', 'ccw'] if args.rotation == 'auto' else [args.rotation]
    results = {}

    for rot in rotations:
        print(f"\n=== Rotation hypothesis: {rot.upper()} ===")
        observations = []
        per_feature = []
        for f in kfeats:
            u_n, v_n = proxy_to_native(f['u_proxy'], f['v_proxy'],
                                       rot, args.crop_top_bottom, args.scale)
            z = lookup_depth_bilinear(depth_color, u_n, v_n)
            ok = not np.isnan(z)
            entry = {
                'name': f['name'],
                'proxy_pixel': [f['u_proxy'], f['v_proxy']],
                'native_pixel': [u_n, v_n],
                'depth_mm': float(z) if ok else None,
            }
            if not ok:
                print(f"  {f['name']:8s} proxy=({f['u_proxy']:6.1f},{f['v_proxy']:6.1f}) "
                      f"-> native=({u_n:6.1f},{v_n:6.1f}) -> NO DEPTH (skip)")
                per_feature.append(entry)
                continue
            P_native = lift_to_3d(u_n, v_n, z, intr['K_color'])
            P_proxy = rotate_3d_for_image_rotation(P_native, rot)
            entry['P_native_mm'] = P_native.tolist()
            entry['P_proxy_mm'] = P_proxy.tolist()
            per_feature.append(entry)
            observations.append({
                'name': f['name'],
                'uv_proxy': [f['u_proxy'], f['v_proxy']],
                'P_proxy_mm': P_proxy.tolist(),
            })
            print(f"  {f['name']:8s} proxy=({f['u_proxy']:6.1f},{f['v_proxy']:6.1f}) "
                  f"-> native=({u_n:6.1f},{v_n:6.1f}) -> depth={z:5.0f}mm")

        if len(observations) < 4:
            print(f"  only {len(observations)} valid observations, need >=4. skipping.")
            continue

        fit = fit_K_proxy(observations)
        K = fit['K']
        print(f"\n  fitted K: fx={K[0]:.1f}  fy={K[1]:.1f}  "
              f"cx={K[2]:.1f}  cy={K[3]:.1f}")
        print(f"  residuals: mean={fit['mean_residual_px']:.2f}px  "
              f"max={fit['max_residual_px']:.2f}px")

        results[rot] = {'fit': fit, 'observations': observations, 'per_feature': per_feature}

    if not results:
        print("\nNo viable fits.")
        sys.exit(1)

    # ---- Pick best, save ----
    best_rot = min(results, key=lambda r: results[r]['fit']['mean_residual_px'])
    best = results[best_rot]
    K = best['fit']['K']

    print(f"\n=== Best: {best_rot.upper()} ===")
    print(f"  fx={K[0]:.1f}  fy={K[1]:.1f}  cx={K[2]:.1f}  cy={K[3]:.1f}")
    print(f"  mean residual {best['fit']['mean_residual_px']:.2f}px  "
          f"max {best['fit']['max_residual_px']:.2f}px")

    out = {
        'fx': K[0], 'fy': K[1], 'cx': K[2], 'cy': K[3],
        'W': args.proxy_w, 'H': args.proxy_h,
        'rotation_from_native': best_rot,
        'crop_top_bottom_native_px': args.crop_top_bottom,
        'scale_cropped_to_scaled': args.scale,
        'mean_residual_px': best['fit']['mean_residual_px'],
        'max_residual_px': best['fit']['max_residual_px'],
        'per_feature': best['per_feature'],
        'method': 'depth_anchored_K_fit',
        'notes': [
            'Empirically fitted Kinect color-proxy intrinsic.',
            '3D anchors come from depth, lifted via factory color<->depth registration.',
            'This K is for the proxy frame (W x H portrait); load it in pair_tune.html '
            'in place of the buggy non-uniform scaling of the factory color intrinsic.',
            f'Used {len(best["observations"])}/{len(kfeats)} cross-features.',
        ],
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(out, f, indent=2)
    print(f"\nWrote {args.out}")

    # ---- Sanity ----
    print("\nSanity vs Option A guess:")
    print(f"  Option A: fx~910 fy~910 cx~540 cy~960 (square pixels, image center)")
    print(f"  Fitted:   fx={K[0]:.0f} fy={K[1]:.0f} cx={K[2]:.0f} cy={K[3]:.0f}")
    if abs(K[0] - K[1]) > 50:
        print(f"  NOTE: |fx - fy| = {abs(K[0]-K[1]):.1f}px > 50. Either the proxy")
        print( "        genuinely has non-square pixels (non-uniform scaling somewhere)")
        print( "        or --crop-top-bottom is wrong. Try other values, e.g. 0, 256, 512.")
    if best['fit']['max_residual_px'] > 30:
        print(f"  NOTE: max residual {best['fit']['max_residual_px']:.1f}px is large.")
        print( "        Likely click error (~5-10px expected) OR a wrong crop/rotation.")
        print( "        Inspect per-feature residuals in the JSON; one bad click can bias all 4 params.")


if __name__ == '__main__':
    main()
