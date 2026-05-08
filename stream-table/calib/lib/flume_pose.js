// Pure-math core for the flume-pose solver: DLT homography from coplanar
// landmark correspondences plus Faugeras-style [R|t] decomposition. Extracted
// verbatim from kinect_align.html so that batch tooling, sanity tests, and the
// browser tool can all rely on the exact same arithmetic.
//
// All matrices are 3×3, row-major flat arrays of length 9.
// Pose convention (OpenCV): X_cam = R · X_world + t, with X right / Y down / Z forward.

// =============================================================================
// Linear algebra primitives
// =============================================================================
export function mulMM(A, B, n = 3, m = 3, p = 3) {
  const C = new Array(n * p).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) {
    let s = 0;
    for (let k = 0; k < m; k++) s += A[i * m + k] * B[k * p + j];
    C[i * p + j] = s;
  }
  return C;
}

export function mulMV(M, v, rows = 3, cols = 3) {
  const out = new Array(rows).fill(0);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    out[i] += M[i * cols + j] * v[j];
  }
  return out;
}

export function transpose3(M) {
  return [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];
}

export function inv3(M) {
  const a = M[0], b = M[1], c = M[2], d = M[3], e = M[4], f = M[5], g = M[6], h = M[7], i = M[8];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-15) return null;
  const inv = 1 / det;
  return [
    (e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    (f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    (d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
}

export function vec3Norm(v) {
  const n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
}

export function vec3Cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function vec3Sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }

// =============================================================================
// Single Gram-Schmidt + cross-product orthogonalization for a 3×3 rotation
// matrix that's drifted slightly off-orthonormal during homography decomposition.
// =============================================================================
export function orthonormalize3(R) {
  const r1 = vec3Norm([R[0], R[3], R[6]]);
  let r2_raw = [R[1], R[4], R[7]];
  const dot = r1[0] * r2_raw[0] + r1[1] * r2_raw[1] + r1[2] * r2_raw[2];
  r2_raw = [r2_raw[0] - dot * r1[0], r2_raw[1] - dot * r1[1], r2_raw[2] - dot * r1[2]];
  const r2 = vec3Norm(r2_raw);
  const r3 = vec3Cross(r1, r2);
  return [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]];
}

// =============================================================================
// Jacobi eigendecomposition of an n×n symmetric matrix. Used to find the
// 9-vector null-space direction of A in homographyDLT.
// =============================================================================
export function jacobiEigen(M, n) {
  const A = M.slice();
  const V = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  const maxSweeps = 50;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i * n + j] * A[i * n + j];
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = A[p * n + q];
      if (Math.abs(apq) < 1e-20) continue;
      const app = A[p * n + p], aqq = A[q * n + q];
      const theta = (aqq - app) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(1 + t * t);
      const s = t * c;
      A[p * n + p] = app - t * apq;
      A[q * n + q] = aqq + t * apq;
      A[p * n + q] = 0; A[q * n + p] = 0;
      for (let i = 0; i < n; i++) {
        if (i === p || i === q) continue;
        const aip = A[i * n + p], aiq = A[i * n + q];
        A[i * n + p] = c * aip - s * aiq; A[p * n + i] = A[i * n + p];
        A[i * n + q] = s * aip + c * aiq; A[q * n + i] = A[i * n + q];
      }
      for (let i = 0; i < n; i++) {
        const vip = V[i * n + p], viq = V[i * n + q];
        V[i * n + p] = c * vip - s * viq;
        V[i * n + q] = s * vip + c * viq;
      }
    }
  }
  const eigenvalues = new Array(n);
  for (let i = 0; i < n; i++) eigenvalues[i] = A[i * n + i];
  return { eigenvalues, eigenvectors: V };
}

// =============================================================================
// 4-point planar homography via DLT.
//   worldXY: array of [X, Y] on the Z=0 plane (mm)
//   imageUV: array of [u, v] in the image (px)
// Returns 9-element row-major H such that  λ·[u,v,1]ᵀ = H·[X,Y,1]ᵀ.
// =============================================================================
export function homographyDLT(worldXY, imageUV) {
  const A = [];
  for (let i = 0; i < worldXY.length; i++) {
    const [X, Y] = worldXY[i];
    const [u, v] = imageUV[i];
    A.push([-X, -Y, -1,  0,  0,  0,  u * X, u * Y, u]);
    A.push([ 0,  0,  0, -X, -Y, -1,  v * X, v * Y, v]);
  }
  const AtA = new Array(81).fill(0);
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    let s = 0;
    for (let i = 0; i < A.length; i++) s += A[i][r] * A[i][c];
    AtA[r * 9 + c] = s;
  }
  const { eigenvalues, eigenvectors } = jacobiEigen(AtA, 9);
  let minIdx = 0;
  for (let i = 1; i < 9; i++) if (eigenvalues[i] < eigenvalues[minIdx]) minIdx = i;
  const h = new Array(9);
  for (let i = 0; i < 9; i++) h[i] = eigenvectors[i * 9 + minIdx];
  if (Math.abs(h[8]) > 1e-12) for (let i = 0; i < 9; i++) h[i] /= h[8];
  return h;
}

// =============================================================================
// Recover camera pose (R, t) from a planar-landmark homography H and intrinsic K.
// H = K · [r1 r2 t]; solve for r1, r2, t up to common scale, then enforce
// orthogonality of the first two rotation columns.
// Returns { R, t } in OpenCV convention, or null if K is singular.
// =============================================================================
export function poseFromHomography(H, K) {
  const Kinv = inv3(K);
  if (!Kinv) return null;
  const M = mulMM(Kinv, H);
  const m1 = [M[0], M[3], M[6]];
  const m2 = [M[1], M[4], M[7]];
  const m3 = [M[2], M[5], M[8]];
  const lambda = (Math.sqrt(m1[0] * m1[0] + m1[1] * m1[1] + m1[2] * m1[2]) +
                  Math.sqrt(m2[0] * m2[0] + m2[1] * m2[1] + m2[2] * m2[2])) / 2;
  let sign = 1;
  if (m3[2] < 0) sign = -1;
  const r1 = vec3Norm([sign * m1[0] / lambda, sign * m1[1] / lambda, sign * m1[2] / lambda]);
  let r2_raw = [sign * m2[0] / lambda, sign * m2[1] / lambda, sign * m2[2] / lambda];
  const dot = r1[0] * r2_raw[0] + r1[1] * r2_raw[1] + r1[2] * r2_raw[2];
  r2_raw = [r2_raw[0] - dot * r1[0], r2_raw[1] - dot * r1[1], r2_raw[2] - dot * r1[2]];
  const r2 = vec3Norm(r2_raw);
  const r3 = vec3Cross(r1, r2);
  const t = [sign * m3[0] / lambda, sign * m3[1] / lambda, sign * m3[2] / lambda];
  const R = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]];
  return { R, t };
}

// =============================================================================
// Projection: pinhole project a world point through (pose, K).
// Returns null if the point lies behind the camera.
// =============================================================================
export function projectWorld(P, pose, K) {
  const pc = mulMV(pose.R, P);
  pc[0] += pose.t[0]; pc[1] += pose.t[1]; pc[2] += pose.t[2];
  if (pc[2] <= 1e-3) return null;
  const u = K[0] * pc[0] / pc[2] + K[2];
  const v = K[4] * pc[1] / pc[2] + K[5];
  return [u, v];
}

// Camera center in world frame: C = -Rᵀ · t.
export function cameraCenter(pose) {
  const Rt = transpose3(pose.R);
  return mulMV(Rt, [-pose.t[0], -pose.t[1], -pose.t[2]]);
}

// Optical-axis unit vector in world frame — the world-space direction the camera
// is pointing at. From X_cam = R·X_world + t, the cam-local +Z axis (the look
// direction) corresponds to a world direction d such that R·d = (0,0,1)ᵀ, so
// d = Rᵀ·(0,0,1)ᵀ, which is the third *row* of R: [R[6], R[7], R[8]].
export function opticalAxis(pose) {
  return vec3Norm([pose.R[6], pose.R[7], pose.R[8]]);
}

// Reprojection RMS error over a set of correspondences.
export function reprojectionRMSE(pose, K, worldPoints3D, imagePoints) {
  let sumSq = 0, n = 0;
  for (let i = 0; i < worldPoints3D.length; i++) {
    const proj = projectWorld(worldPoints3D[i], pose, K);
    if (!proj) continue;
    const dx = proj[0] - imagePoints[i][0];
    const dy = proj[1] - imagePoints[i][1];
    sumSq += dx * dx + dy * dy;
    n++;
  }
  return n > 0 ? Math.sqrt(sumSq / n) : null;
}

// =============================================================================
// High-level convenience: take coplanar (X, Y, Z=0) ↔ (u, v) correspondences
// and an intrinsic K; return { pose, rms_px, n_points } or null on failure.
// This is what batch tooling and kinect_align.html both call.
// =============================================================================
export function solvePoseFromPlanarLandmarks({ worldXY, imageUV, K }) {
  if (worldXY.length < 4) return null;
  const H = homographyDLT(worldXY, imageUV);
  const pose = poseFromHomography(H, K);
  if (!pose) return null;
  pose.R = orthonormalize3(pose.R);
  const worldPoints3D = worldXY.map(([X, Y]) => [X, Y, 0]);
  const rms_px = reprojectionRMSE(pose, K, worldPoints3D, imageUV);
  return { pose, rms_px, n_points: worldXY.length };
}
