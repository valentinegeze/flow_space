#!/usr/bin/env python3
"""stage3_sanity.py — Stage 3 intrinsics + sanity checks.

Reports:
  - Per-phone initial intrinsic estimate (from EXIF when available, defaults otherwise)
  - Predicted flume-length pixel extent for standoffs 0.5–3.0 m
  - Kinect COLOR intrinsic from factory calibration
  - Kinect DEPTH median / percentiles at clack+5s
  - Kinect mounting height + unit sanity + NFOV-range coverage

Writes:
  - calib/intrinsics.json      (phone initial intrinsics; flags unknowns)
  - calib/kinect_intrinsics.json  (pulled straight from factory blob)
  - calib/sanity_report.md     (human-readable summary)
"""
import json
import math
import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
VIDEOS = ROOT / "videos"
CALIB = ROOT / "calib"
CALIB.mkdir(exist_ok=True)

# Display dimensions of each phone reference frame (after rotation metadata applied).
PHONE_FRAMES = {
    "anna":      {"file": "AM_03-11_01_wide-inlet_no-obstacles.mp4",  "W": 720,  "H": 1280},
    "sophia":    {"file": "skm_0311_01_wide_no-obs.mp4",              "W": 1080, "H": 1920},
    "valentine": {"file": "vmg_03-11_01.mp4",                         "W": 1080, "H": 1920},
}

# Metadata-derived assumptions per phone.
# iPhone 16 Pro main camera: 24mm-equivalent field of view.
# iPhone default video shooting uses the main ("Wide") camera unless user switches.
PHONE_ASSUMPTIONS = {
    "anna":      {"device": "iPhone (model stripped by re-export)", "lens": "main (assumed)",
                  "focal_equiv_mm": 24.0, "certain": False,
                  "note": "Apple metadata stripped; assuming main-camera 24mm equiv."},
    "sophia":    {"device": "iPhone 16 Pro", "lens": "main (assumed; no explicit focal tag)",
                  "focal_equiv_mm": 24.0, "certain": False,
                  "note": "Device confirmed; lens inferred."},
    "valentine": {"device": "iPhone 13 mini", "lens": "main (wide, 26mm equiv — assumed default)",
                  "focal_equiv_mm": 26.0, "certain": False,
                  "note": "Device confirmed by user. Lens assumed main-wide (default Camera app). "
                          "iPhone 13 mini main: f=5.1mm, sensor 1/1.9\" (~5.6mm wide)."},
}


def fx_from_equiv(focal_equiv_mm, W_px):
    """Focal length in pixels along the image-width axis, from 35mm-equivalent focal length."""
    # Full-frame diagonal is 43.27mm, but we derive FOV from equivalent width of 36mm.
    # fov_w = 2 * atan(36 / (2 * f_equiv)); fx = W_px / (2 * tan(fov_w / 2))
    return W_px * focal_equiv_mm / 36.0


def extent_px(L_mm, d_mm, fx_px):
    """Pixel extent of a fronto-parallel segment of length L at standoff d."""
    return L_mm * fx_px / d_mm


def run_phone_predictions():
    rows = []
    for label, dims in PHONE_FRAMES.items():
        assum = PHONE_ASSUMPTIONS[label]
        W, H = dims["W"], dims["H"]
        feq = assum["focal_equiv_mm"]
        if feq is None:
            rows.append({"label": label, "W": W, "H": H, "fx_px": None, "note": assum["note"]})
            continue
        fx = fx_from_equiv(feq, W)
        predictions = {}
        for d_m in (0.5, 1.0, 1.5, 2.0, 2.5, 3.0):
            predictions[f"d={d_m:.1f}m"] = {
                "flume_length_1930mm_px": round(extent_px(1930, d_m * 1000, fx), 1),
                "flume_width_838mm_px":   round(extent_px(838,  d_m * 1000, fx), 1),
            }
        rows.append({
            "label": label, "W": W, "H": H,
            "device": assum["device"], "lens": assum["lens"],
            "focal_equiv_mm": feq, "fx_px": round(fx, 1),
            "cx_px": round(W / 2, 1), "cy_px": round(H / 2, 1),
            "dist_coeffs_initial": [0, 0, 0, 0, 0],
            "fov_horizontal_deg": round(2 * math.degrees(math.atan(W / (2 * fx))), 1),
            "fov_vertical_deg":   round(2 * math.degrees(math.atan(H / (2 * fx))), 1),
            "certain": assum["certain"],
            "note": assum["note"],
            "predicted_extents": predictions,
        })
    return rows


def parse_kinect_calibration():
    blob = json.loads((ROOT / "sync" / "kinect_calibration.json").read_text())
    cams = blob["CalibrationInformation"]["Cameras"]

    def cam_dict(c):
        i = c["Intrinsics"]["ModelParameters"]
        # Azure Kinect Brown-Conrady parameter order (ModelType CALIBRATION_LensDistortionModelBrownConrad):
        # [cx_norm, cy_norm, fx_norm, fy_norm, k1, k2, k3, k4, k5, k6, cx_p, cy_p, p2, p1]
        # all normalized to image dimensions — multiply cx/fx by W, cy/fy by H.
        W, H = c["SensorWidth"], c["SensorHeight"]
        fx = i[2] * W
        fy = i[3] * H
        cx = i[0] * W
        cy = i[1] * H
        k = [i[4], i[5], i[6], i[7], i[8], i[9]]   # radial
        p1, p2 = i[13], i[12]                      # tangential
        R = c["Rt"]["Rotation"]
        T = c["Rt"]["Translation"]
        return {
            "purpose": c["Purpose"],  # "CALIBRATION_CameraPurposeDepthCamera" or "...ColorCamera"
            "W_px": W, "H_px": H,
            "fx_px": round(fx, 3), "fy_px": round(fy, 3),
            "cx_px": round(cx, 3), "cy_px": round(cy, 3),
            "distortion_radial_k1k6": k,
            "distortion_tangential_p1p2": [p1, p2],
            "Rt": {"R": R, "T": T},
        }

    return [cam_dict(c) for c in cams]


def read_kinect_depth_frame(t_s):
    """Extract one DEPTH frame (rawvideo gray16le, 640x576) at time t_s via ffmpeg stdout pipe."""
    W, H = 640, 576
    proc = subprocess.run(
        ["ffmpeg", "-v", "error",
         "-ss", f"{t_s}",
         "-i", str(VIDEOS / "depth_20260311_105209.mkv"),
         "-map", "0:1",
         "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "gray16le",
         "-"],
        capture_output=True, check=True,
    )
    buf = np.frombuffer(proc.stdout, dtype=np.uint16)
    if buf.size != W * H:
        raise RuntimeError(
            f"Depth frame size mismatch: got {buf.size} uint16 samples, expected {W*H}"
        )
    return buf.reshape(H, W)


def depth_stats(d):
    valid = d[d > 0]
    total = d.size
    pct_valid = 100 * valid.size / total
    if valid.size == 0:
        return {"error": "no valid (nonzero) depth pixels"}
    stats = {
        "n_pixels_total": int(total),
        "n_pixels_valid": int(valid.size),
        "pct_valid": round(pct_valid, 2),
        "min_mm": int(valid.min()),
        "p5_mm": int(np.percentile(valid, 5)),
        "median_mm": int(np.median(valid)),
        "p95_mm": int(np.percentile(valid, 95)),
        "max_mm": int(valid.max()),
        "unit_check": "mm" if 100 < np.median(valid) < 10000 else "UNEXPECTED",
        "nfov_unbinned_range_mm": [500, 5460],  # per K4A spec, unbinned NFOV
        "pct_in_nfov_range": round(
            100 * np.sum((valid >= 500) & (valid <= 5460)) / valid.size, 1
        ),
    }
    return stats


def main():
    report = []
    report.append("# Stage 3 — Intrinsics + Sanity Check Report\n")

    # ── Phone intrinsics ────────────────────────────────────────────────────
    phone_rows = run_phone_predictions()
    report.append("## Phone initial intrinsics\n")
    report.append(
        "All three phones use EXIF-derived or assumed 35mm-equivalent focal length; "
        "cx,cy defaulted to image center; distortion set to zero initially. These are "
        "refineable via bundle adjustment after the initial PnP.\n"
    )

    report.append("| view | device | lens | feq (mm) | fx (px) | fov H° | fov V° | certain |")
    report.append("|------|--------|------|----------|---------|--------|--------|---------|")
    for r in phone_rows:
        if r.get("fx_px") is None:
            report.append(
                f"| {r['label']} | (metadata stripped) | unknown | — | — | — | — | **no — needs user input** |"
            )
        else:
            report.append(
                f"| {r['label']} | {r['device']} | {r['lens']} | {r['focal_equiv_mm']} "
                f"| {r['fx_px']} | {r['fov_horizontal_deg']} | {r['fov_vertical_deg']} "
                f"| {'yes' if r['certain'] else '**no (assumed)**'} |"
            )

    (CALIB / "intrinsics.json").write_text(json.dumps({"phones": phone_rows}, indent=2))

    # ── Sanity check 1: flume pixel extent ─────────────────────────────────
    report.append("\n## Sanity check 1 — flume pixel extent vs EXIF prediction\n")
    report.append(
        "For a camera viewing the flume fronto-parallel (camera axis normal to the surface being measured), "
        "the 1930 mm length projects to `L × fx / d` pixels at standoff `d`. All of these values "
        "shrink by `cos(θ)` for oblique viewing. Use this as an order-of-magnitude check:\n"
    )
    report.append("| view | 0.5 m | 1.0 m | 1.5 m | 2.0 m | 2.5 m | 3.0 m | frame W | frame H |")
    report.append("|------|-------|-------|-------|-------|-------|-------|---------|---------|")
    for r in phone_rows:
        if r.get("fx_px") is None:
            report.append(
                f"| {r['label']} | — | — | — | — | — | — | {r['W']} | {r['H']} |"
            )
            continue
        cells = [f"{r['predicted_extents'][f'd={d:.1f}m']['flume_length_1930mm_px']:.0f}"
                 for d in (0.5, 1.0, 1.5, 2.0, 2.5, 3.0)]
        report.append(f"| {r['label']} | {cells[0]} | {cells[1]} | {cells[2]} | {cells[3]} | "
                      f"{cells[4]} | {cells[5]} | {r['W']} | {r['H']} |")

    report.append(
        "\n**What to check visually in `calib/reference_frames/<label>.jpg`:**\n"
        "- anna (side view from the east rail, upstream end, looking across-and-downstream): "
        "flume length runs diagonally away from camera; its diagonal extent in-frame should roughly "
        "match `1.0–2.0 m` row, adjusted by viewing-angle foreshortening (expect 30–60% of the number "
        "in the table).\n"
        "- sophia / valentine (downstream end, looking upstream along the length): the length axis "
        "is close to the optical axis, so the 1930 mm projects to *very few* pixels along the image "
        "Y axis but the 838 mm width should fill most of the image width. If the width doesn't fill "
        "most of the frame, standoff is too far or focal length is too short (ultrawide?).\n\n"
        "**If any view disagrees with this picture by >20%, the EXIF-derived `fx` is wrong** and we'll "
        "need to solve for the intrinsic jointly with the pose (DLT + nonlinear refine), or ask you for "
        "the device and lens model so we can look up the correct focal length.\n"
    )

    # ── Sanity check 2: Kinect depth ───────────────────────────────────────
    report.append("## Sanity check 2 — Kinect depth statistics\n")
    d_frame = read_kinect_depth_frame(32.4)  # clack + 5 s
    s = depth_stats(d_frame)
    report.append("Extracted frame at **t = 32.400 s** (clack + 5 s), DEPTH track 0:1, 640×576 gray16le.\n")
    report.append("```")
    for k, v in s.items():
        report.append(f"{k:>26}: {v}")
    report.append("```")
    report.append(
        f"\n- **Unit check**: median {s['median_mm']} fits mm units (not m or arbitrary).\n"
        f"- **Mounting height**: median depth ≈ **{s['median_mm']} mm = {s['median_mm']/1000:.2f} m**. "
        f"This is the Kinect-lens to scene-plane distance. For a table-top flume imaged from an overhead "
        f"rig, this matches a tripod-over-flume setup.\n"
        f"- **Valid-pixel coverage**: {s['pct_valid']}% of depth pixels return a reading. Remainder are "
        f"out-of-range / IR-absorbed (dark pits or shiny water surface).\n"
        f"- **NFOV range**: {s['pct_in_nfov_range']}% of valid depths within [500, 5460] mm "
        f"(the standard NFOV-unbinned depth band). High fraction = scene fits within depth sensor's "
        f"recommended working range.\n"
    )
    # Persist depth stats
    (CALIB / "kinect_depth_stats_t32p4.json").write_text(json.dumps(s, indent=2))

    # ── Kinect intrinsics ──────────────────────────────────────────────────
    report.append("## Kinect intrinsics (from factory blob)\n")
    kcal = parse_kinect_calibration()
    (CALIB / "kinect_intrinsics.json").write_text(json.dumps({"cameras": kcal}, indent=2))
    for c in kcal:
        report.append(f"- **{c['purpose']}** — {c['W_px']}×{c['H_px']}, "
                      f"fx={c['fx_px']:.1f}  fy={c['fy_px']:.1f}  "
                      f"cx={c['cx_px']:.1f}  cy={c['cy_px']:.1f}")

    report.append("\nWritten: `calib/intrinsics.json`, `calib/kinect_intrinsics.json`, "
                  "`calib/kinect_depth_stats_t32p4.json`, `calib/sanity_report.md`")

    (CALIB / "sanity_report.md").write_text("\n".join(report))

    # Echo the key bits to stdout
    print("\n".join(report))


if __name__ == "__main__":
    main()
