/**
 * Connectivity metrics for land mosaic.
 * - computeConnectivity: flow-weighted connectivity based on actual water/sediment movement.
 * - computePhiConnectivity: structural percolation φ via 4-connected union-find.
 */

// ── Union-Find (disjoint-set) ────────────────────────────────────────────────

class UnionFind {
  constructor(n) {
    this.parent = new Int32Array(n);
    this.rank   = new Uint8Array(n);
    this.size   = new Int32Array(n);
    for (let i = 0; i < n; i++) { this.parent[i] = i; this.size[i] = 1; }
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]; // path halving
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    a = this.find(a);
    b = this.find(b);
    if (a === b) return;
    if (this.rank[a] < this.rank[b]) { const t = a; a = b; b = t; }
    this.parent[b] = a;
    this.size[a] += this.size[b];
    if (this.rank[a] === this.rank[b]) this.rank[a]++;
  }
}

// 4-connectivity: right, down only (union is symmetric, so we only need two directions)
const DIRS4 = [[0, 1], [1, 0]];

/**
 * Compute the percolation order parameter φ for structural connectivity.
 *
 * Runs a 4-connected (von Neumann neighborhood) union-find over all cells
 * whose patch type is in `flammableKeys`.  4-connectivity gives the standard
 * site-percolation critical threshold φ* ≈ 0.593 on a square lattice.
 *
 * @param {Uint8Array}  patchGrid      Flat grid of patch-type indices
 * @param {string[]}    patchKeys      Ordered array of patch key strings (index → key)
 * @param {string[]}    flammableKeys  Which patch keys count as "active" (flammable/permeable)
 * @param {number}      cols           Grid width
 * @param {number}      rows           Grid height
 * @returns {{ phi: number, giantClusterSize: number, clusterMap: Int32Array }}
 *   phi              = giantClusterSize / (cols * rows)
 *   giantClusterSize = cell count of the largest connected component
 *   clusterMap       = per-cell cluster ID:
 *                        -1  → not in flammableKeys
 *                         0  → member of the giant cluster
 *                        >0  → smaller cluster (unique positive integer)
 */
export function computePhiConnectivity(patchGrid, patchKeys, flammableKeys, cols, rows) {
  const n = cols * rows;
  const flammableSet = new Set(flammableKeys);

  // Mark active cells
  const active = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (flammableSet.has(patchKeys[patchGrid[i]])) active[i] = 1;
  }

  // Union-find over active cells (4-connectivity)
  const uf = new UnionFind(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (!active[idx]) continue;
      for (const [dr, dc] of DIRS4) {
        const nr = r + dr, nc = c + dc;
        if (nr >= rows || nc >= cols) continue;
        const nidx = nr * cols + nc;
        if (active[nidx]) uf.union(idx, nidx);
      }
    }
  }

  // Identify the giant cluster
  let giantRoot = -1, giantSize = 0;
  for (let i = 0; i < n; i++) {
    if (!active[i]) continue;
    const root = uf.find(i);
    if (uf.size[root] > giantSize) {
      giantSize = uf.size[root];
      giantRoot = root;
    }
  }

  // Build clusterMap: -1 = inactive, 0 = giant, 1+ = smaller clusters
  const clusterMap = new Int32Array(n).fill(-1);
  const rootToId = new Map();
  let nextId = 1;

  for (let i = 0; i < n; i++) {
    if (!active[i]) continue;
    const root = uf.find(i);
    if (root === giantRoot) {
      clusterMap[i] = 0;
    } else {
      if (!rootToId.has(root)) rootToId.set(root, nextId++);
      clusterMap[i] = rootToId.get(root);
    }
  }

  return {
    phi: n > 0 ? giantSize / n : 0,
    giantClusterSize: giantSize,
    clusterMap,
  };
}

/**
 * Water-side percolation order parameter.
 *
 * Same union-find as computePhiConnectivity, but cells are "active" when their
 * water depth exceeds a threshold. φ_water = giantClusterSize / (cols * rows)
 * indicates whether ponded/flowing water has organized into a system-spanning
 * connected network or remains in isolated patches.
 *
 * @param {Float32Array} depths   Per-cell water depth (m)
 * @param {number}       cols
 * @param {number}       rows
 * @param {number}       depthThreshold  Minimum depth (m) to count as wet
 * @returns {{ phi: number, giantClusterSize: number, activeCells: number }}
 */
export function computePhiFlow(depths, cols, rows, depthThreshold = 1e-4) {
  const n = cols * rows;
  const active = new Uint8Array(n);
  let activeCells = 0;
  for (let i = 0; i < n; i++) {
    if (depths[i] > depthThreshold) { active[i] = 1; activeCells++; }
  }

  const uf = new UnionFind(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (!active[idx]) continue;
      for (const [dr, dc] of DIRS4) {
        const nr = r + dr, nc = c + dc;
        if (nr >= rows || nc >= cols) continue;
        const nidx = nr * cols + nc;
        if (active[nidx]) uf.union(idx, nidx);
      }
    }
  }

  let giantSize = 0;
  for (let i = 0; i < n; i++) {
    if (!active[i]) continue;
    const s = uf.size[uf.find(i)];
    if (s > giantSize) giantSize = s;
  }

  return {
    phi: n > 0 ? giantSize / n : 0,
    giantClusterSize: giantSize,
    activeCells,
  };
}

// ── Flow-weighted connectivity ───────────────────────────────────────────────

/**
 * Compute connectivity index and per-cell drainage contribution.
 *
 * Returns:
 *   connectivity    — ratio of cells with significant flow to total active cells (scalar 0–1)
 *   drainageContrib — Float32Array of normalized flux per cell; each value is that cell's
 *                     share of total landscape flux. High values mark the drainage network.
 *
 * This replaces the old scalar-only return so callers can render a spatial heatmap
 * showing which patches sit on the main flow paths, not just whether the landscape
 * is "connected" in aggregate.
 */
export function computeConnectivity(depths, fluxes, cols, rows) {
  let flowingCells = 0;
  let totalActive = 0;
  let totalFlux = 0;
  const drainageContrib = new Float32Array(cols * rows);

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j;
      const h = depths[idx];
      const vx = fluxes[idx * 2];
      const vy = fluxes[idx * 2 + 1];
      const v = Math.sqrt(vx * vx + vy * vy);
      const flux = v * Math.max(h, 0);

      drainageContrib[idx] = flux;
      totalFlux += flux;

      if (h > 0.0001 || v > 0.0001) {
        totalActive++;
        if (v > 0.001) flowingCells++;
      }
    }
  }

  if (totalFlux > 0) {
    for (let k = 0; k < drainageContrib.length; k++) {
      drainageContrib[k] /= totalFlux;
    }
  }

  return {
    connectivity: totalActive === 0 ? 0 : flowingCells / totalActive,
    drainageContrib,
  };
}
