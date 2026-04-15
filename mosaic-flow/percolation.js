/**
 * percolation.js — Three-panel percolation explorer.
 *
 * Left:   mosaic map with cluster coloring, contour/soil overlays, scale slider
 * Center: order parameter φ, threshold slider, S-curve chart, mode toggle
 * Right:  tree-to-tree network graph, wind compass, edge filter
 * Bottom: timeline scrubber with play/pause/reset
 *
 * Imports existing physics modules (fire.js, flow.js, patches.js, etc.)
 * All panels share a single state object.
 */

import { PATCH_TYPES, PATCH_PARAMS } from './patches.js';
import { stepFire, createFireState, resetFireState, igniteAt, FIRE, hasActiveFire, buildParamsCache } from './fire.js';
import { stepFlow, getElevation, flowWeights } from './flow.js';
import { generateMockNLCDGrid, nlcdToPatchIndex, PATCH_KEYS } from './nlcd-mapper.js';
import { exportFireToSharedState, sharedState } from './sharedState.js';

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════
const COLS = 64, ROWS = 64;
const PHI_STAR = 0.59;
const patchKeys = Object.keys(PATCH_PARAMS);

// Land-use base colors (parsed once)
const PATCH_COLORS = {};
for (const [k, v] of Object.entries(PATCH_PARAMS)) {
  const h = v.color.replace('#', '');
  PATCH_COLORS[k] = [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

// Category labels for legend
const LAND_USE_LABELS = {
  grass: 'Grassland', forest: 'Forest', wetland: 'Wetland',
  bare: 'Bare/Rock', urban: 'Urban', corridor: 'Shrubland', water: 'Water',
};

// Which land use types count as flammable / permeable per mode
function isFlammable(patchKey) {
  const fl = PATCH_PARAMS[patchKey]?.fuelLoad ?? 0;
  return fl > 0;
}
function isPermeable(patchKey) {
  // In flood mode: anything that isn't urban or bare rock transmits water
  return !['urban'].includes(patchKey);
}

// ════════════════════════════════════════════════════════════════════════════
// Shared State
// ════════════════════════════════════════════════════════════════════════════
const state = {
  // Grid data
  patchGrid: null,          // Uint8Array[COLS*ROWS]
  elevations: null,         // Float32Array
  depths: null,             // Float32Array
  fluxes: null,             // Float32Array
  fireState: null,

  // Controls
  timestep: 0,
  maxTimestep: 0,
  mode: 'fire',             // 'fire' | 'flood' | 'both'
  flammabilityThreshold: 0.1,
  scaleSlider: 0,           // 0 = landscape, 1 = granular
  zoomTarget: { r: 32, c: 32 },
  windDirection: 225,       // degrees FROM
  windSpeed: 2.5,
  minEdgeWeight: 0.1,
  playing: false,
  showContours: false,
  showSoil: false,

  // Computed (updated by recompute functions)
  clusterIds: null,         // Int32Array — cluster label per cell
  clusterSizes: null,       // Map<id, count>
  giantClusterId: -1,
  giantClusterSize: 0,
  phi: 0,
  flammableCount: 0,
  cellIsActive: null,       // Uint8Array — 1 if cell participates in current mode

  // Simulation snapshots: [{cellState: Uint8Array, depths: Float32Array}]
  snapshots: [],
  // Cached per-timestep cluster data: [{clusterIds, giantClusterId, phi}]
  clusterCache: [],

  // Timeline event markers
  phiCrossTimestep: -1,     // first timestep φ > PHI_STAR
  spanningTimestep: -1,     // first timestep fire/flood front reaches opposite edge

  // Empirical data points [{phi, spreadExtent}]
  empiricalPoints: [],

  // Stream table imported overlay data (loaded via JSON file picker)
  streamTableData: null,

  // Dirty flags for selective recomputation
  _dirty: { clusters: true, graph: true, timeline: true },
};

// ════════════════════════════════════════════════════════════════════════════
// Fire Worker + Params Cache
// ════════════════════════════════════════════════════════════════════════════
const _fireWorker = new Worker('./fire-worker.js', { type: 'module' });
let _fireWorkerBusy = false;
let _cachedParams = null;

function invalidateParamsCache() {
  _cachedParams = buildParamsCache(state.patchGrid, patchKeys, PATCH_PARAMS, COLS, ROWS);
}

// ════════════════════════════════════════════════════════════════════════════
// Grid Initialization
// ════════════════════════════════════════════════════════════════════════════
function initGrid() {
  // Generate a mock NLCD landscape and convert to patch indices
  const nlcd = generateMockNLCDGrid(COLS, ROWS, Math.floor(Math.random() * 10000));
  state.patchGrid = new Uint8Array(COLS * ROWS);
  for (let i = 0; i < nlcd.length; i++) {
    state.patchGrid[i] = nlcdToPatchIndex(nlcd[i]);
  }

  state.elevations = new Float32Array(COLS * ROWS);
  // Generate rolling hills topography
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      state.elevations[r * COLS + c] =
        0.3 * Math.sin(r * 0.12) * Math.cos(c * 0.08) +
        0.15 * Math.sin(r * 0.05 + c * 0.07) +
        0.05 * (ROWS - r) / ROWS;
    }
  }

  state.depths = new Float32Array(COLS * ROWS);
  state.fluxes = new Float32Array(COLS * ROWS * 2);
  state.fireState = createFireState(COLS, ROWS);
  _elevMinMax = null; // invalidate elevation cache
  invalidateParamsCache();

  // Reset simulation
  state.timestep = 0;
  state.maxTimestep = 0;
  state.snapshots = [];
  state.clusterCache = [];
  state.empiricalPoints = [];
  state.phiCrossTimestep = -1;
  state.spanningTimestep = -1;
  state.playing = false;

  recomputeClusters();
  findGiantClusterCenter();
}

// ════════════════════════════════════════════════════════════════════════════
// Union-Find for Connected Components
// ════════════════════════════════════════════════════════════════════════════
class UnionFind {
  constructor(n) {
    this.parent = new Int32Array(n);
    this.rank = new Uint8Array(n);
    this.size = new Int32Array(n);
    for (let i = 0; i < n; i++) { this.parent[i] = i; this.size[i] = 1; }
  }
  find(x) {
    while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; }
    return x;
  }
  union(a, b) {
    a = this.find(a); b = this.find(b);
    if (a === b) return;
    if (this.rank[a] < this.rank[b]) [a, b] = [b, a];
    this.parent[b] = a;
    this.size[a] += this.size[b];
    if (this.rank[a] === this.rank[b]) this.rank[a]++;
  }
}

const DIRS8 = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

function cellIsActiveForMode(patchKey, mode) {
  if (mode === 'fire') return isFlammable(patchKey);
  if (mode === 'flood') return isPermeable(patchKey);
  // 'both': active if flammable OR permeable
  return isFlammable(patchKey) || isPermeable(patchKey);
}

/**
 * Compute spread probability for a cell based on its fuel load and the threshold.
 * Cells with effective probability >= threshold count as "active" for clustering.
 */
function cellEffectiveProbability(idx) {
  const key = patchKeys[state.patchGrid[idx]];
  const params = PATCH_PARAMS[key];
  if (!params) return 0;

  if (state.mode === 'fire' || state.mode === 'both') {
    // fuelLoad is the base probability; continuity can raise it above 1
    // We use fuelLoad as the base metric for thresholding
    return params.fuelLoad ?? 0;
  }
  // Flood: use inverse of connectivity threshold as "permeability"
  const maxThresh = 1.5;
  return 1 - (params.connectivityThreshold ?? 0) / maxThresh;
}

function recomputeClusters() {
  const n = COLS * ROWS;
  const active = new Uint8Array(n);
  let activeCount = 0;

  // Determine which cells are active based on mode + threshold
  for (let i = 0; i < n; i++) {
    const key = patchKeys[state.patchGrid[i]];
    if (!cellIsActiveForMode(key, state.mode)) continue;
    const prob = cellEffectiveProbability(i);
    if (prob >= state.flammabilityThreshold) {
      active[i] = 1;
      activeCount++;
    }
  }

  state.cellIsActive = active;
  state.flammableCount = activeCount;

  // Union-Find on active cells
  const uf = new UnionFind(n);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      if (!active[idx]) continue;
      // 4-connectivity for correct percolation threshold φ* ≈ 0.59
      const DIRS4 = [[-1,0],[1,0],[0,-1],[0,1]];
      for (const [dr, dc] of DIRS4) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
        const nidx = nr * COLS + nc;
        if (active[nidx]) uf.union(idx, nidx);
      }
    }
  }

  // Build cluster IDs and find sizes
  const clusterIds = new Int32Array(n).fill(-1);
  const sizes = new Map();
  let giantId = -1, giantSize = 0;

  for (let i = 0; i < n; i++) {
    if (!active[i]) continue;
    const root = uf.find(i);
    clusterIds[i] = root;
    const sz = uf.size[root];
    sizes.set(root, sz);
    if (sz > giantSize) { giantSize = sz; giantId = root; }
  }

  state.clusterIds = clusterIds;
  state.clusterSizes = sizes;
  state.giantClusterId = giantId;
  state.giantClusterSize = giantSize;
  state.phi = n > 0 ? giantSize / n : 0;

  state._dirty.clusters = false;
  state._dirty.graph = true;
}

function findGiantClusterCenter() {
  if (state.giantClusterId < 0) return;
  let sumR = 0, sumC = 0, count = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (state.clusterIds[r * COLS + c] === state.giantClusterId) {
        sumR += r; sumC += c; count++;
      }
    }
  }
  if (count > 0) {
    state.zoomTarget = { r: Math.round(sumR / count), c: Math.round(sumC / count) };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Spread Probability Between Adjacent Cells (for graph edges)
// ════════════════════════════════════════════════════════════════════════════
function spreadProbability(r1, c1, r2, c2) {
  const idx1 = r1 * COLS + c1, idx2 = r2 * COLS + c2;
  const key1 = patchKeys[state.patchGrid[idx1]];
  const key2 = patchKeys[state.patchGrid[idx2]];
  const p1 = PATCH_PARAMS[key1], p2 = PATCH_PARAMS[key2];

  if (state.mode === 'fire' || state.mode === 'both') {
    const fuel = p2.fuelLoad ?? 0;
    if (fuel <= 0) return 0;
    const crownOut = p1.crownSpreadOut ?? 1;

    // Slope factor
    const dElev = state.elevations[idx2] - state.elevations[idx1];
    const slopeF = Math.max(0.2, 1 + dElev * 14);

    // Wind factor
    const rad = (state.windDirection * Math.PI) / 180;
    const wx = Math.sin(rad), wy = -Math.cos(rad);
    const dr = r2 - r1, dc = c2 - c1;
    const dist = Math.sqrt(dr * dr + dc * dc) || 1;
    const dot = (dc / dist) * wx + (dr / dist) * wy;
    const windF = Math.max(0.06, 1 + dot * state.windSpeed * 0.45);

    return Math.min(1, fuel * crownOut * slopeF * windF);
  }

  // Flood mode: use Manning-based flow likelihood
  const drop = state.elevations[idx1] - state.elevations[idx2];
  if (drop <= 0) return 0.05; // minimal uphill flow
  const gradient = drop / Math.sqrt((r2-r1)**2 + (c2-c1)**2 || 1);
  const n = (p1.manningN + p2.manningN) / 2;
  return Math.min(1, gradient * 10 / n);
}

// ════════════════════════════════════════════════════════════════════════════
// Vulnerability Score (for node sizing in graph)
// ════════════════════════════════════════════════════════════════════════════
let _elevMinMax = null;
function getElevMinMax() {
  if (_elevMinMax) return _elevMinMax;
  let minE = Infinity, maxE = -Infinity;
  for (let i = 0; i < state.elevations.length; i++) {
    if (state.elevations[i] < minE) minE = state.elevations[i];
    if (state.elevations[i] > maxE) maxE = state.elevations[i];
  }
  _elevMinMax = { minE, maxE };
  return _elevMinMax;
}

function vulnerabilityScore(r, c) {
  const idx = r * COLS + c;
  const key = patchKeys[state.patchGrid[idx]];
  const p = PATCH_PARAMS[key];

  const fuelComponent = (p.fuelLoad ?? 0) / 0.4;
  const erodComponent = p.erodibility ?? 0;

  const { minE, maxE } = getElevMinMax();
  const range = maxE - minE || 1;
  const elevNorm = 1 - (state.elevations[idx] - minE) / range;

  if (state.mode === 'fire') return Math.min(1, fuelComponent * 0.6 + erodComponent * 0.2 + elevNorm * 0.2);
  if (state.mode === 'flood') return Math.min(1, elevNorm * 0.5 + erodComponent * 0.3 + (1 - (p.infiltration/80)) * 0.2);
  return Math.min(1, fuelComponent * 0.3 + elevNorm * 0.3 + erodComponent * 0.2 + (1-(p.infiltration/80)) * 0.2);
}

// ════════════════════════════════════════════════════════════════════════════
// Simulation Engine
// ════════════════════════════════════════════════════════════════════════════
function takeSnapshot() {
  state.snapshots.push({
    cellState: new Uint8Array(state.fireState.cell),
    depths: new Float32Array(state.depths),
  });
  state.maxTimestep = state.snapshots.length - 1;
  const scrubber = document.getElementById('timeline-scrubber');
  if (scrubber) {
    scrubber.max = state.maxTimestep;
    scrubber.value = state.timestep;
  }
}

function resetSimulation() {
  resetFireState(state.fireState);
  state.depths.fill(0);
  state.fluxes.fill(0);
  state.timestep = 0;
  state.maxTimestep = 0;
  state.snapshots = [];
  state.clusterCache = [];
  state.empiricalPoints = [];
  state.phiCrossTimestep = -1;
  state.spanningTimestep = -1;
  state.playing = false;

  // Ignite from center of giant cluster — walk outward if target cell has no active neighbors
  if (state.giantClusterId >= 0) {
    let ir = state.zoomTarget.r, ic = state.zoomTarget.c;
    const hasActiveNeighbor = (r, c) => {
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && state.cellIsActive[nr * COLS + nc]) return true;
      }
      return false;
    };
    const idx0 = ir * COLS + ic;
    if (!state.cellIsActive[idx0] || !hasActiveNeighbor(ir, ic)) {
      // Spiral outward from center to find a viable cell
      let found = false;
      for (let radius = 1; radius < Math.max(ROWS, COLS) && !found; radius++) {
        for (let dr = -radius; dr <= radius && !found; dr++) {
          for (let dc = -radius; dc <= radius && !found; dc++) {
            if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
            const nr = state.zoomTarget.r + dr, nc = state.zoomTarget.c + dc;
            if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
            if (state.cellIsActive[nr * COLS + nc] && hasActiveNeighbor(nr, nc)) {
              ir = nr; ic = nc; found = true;
            }
          }
        }
      }
    }
    igniteAt(state.fireState, ir, ic,
             COLS, ROWS, state.patchGrid, patchKeys, PATCH_PARAMS);
  }
  takeSnapshot();
  detectEvents();
  renderAll();
}

/** Post-step bookkeeping: snapshot, empirical data, event detection. */
function finishStep() {
  state.timestep++;
  takeSnapshot();

  // Record empirical point: what fraction of landscape is burned/flooded?
  let affected = 0;
  for (let i = 0; i < COLS * ROWS; i++) {
    if (state.fireState.cell[i] === FIRE.BURNING || state.fireState.cell[i] === FIRE.BURNED) affected++;
    if (state.depths[i] > 0.005) affected++;
  }
  const spreadExtent = affected / (COLS * ROWS);
  if (state.empiricalPoints.length === 0 ||
      Math.abs(spreadExtent - state.empiricalPoints[state.empiricalPoints.length-1].spreadExtent) > 0.005) {
    state.empiricalPoints.push({ phi: state.phi, spreadExtent });
  }

  detectEvents();
}

/**
 * Dispatch a fire step to the Web Worker (fire-only mode).
 * Returns true if dispatched, false if worker is busy.
 */
function dispatchFireWorker() {
  if (_fireWorkerBusy) return false;
  _fireWorkerBusy = true;
  const cellBuf = new Uint8Array(state.fireState.cell);
  const ageBuf = new Uint8Array(state.fireState.age);
  _fireWorker.postMessage({
    cell: cellBuf,
    age: ageBuf,
    embers: state.fireState.embers,
    patchGrid: state.patchGrid,
    patchKeys,
    patchParams: PATCH_PARAMS,
    elevations: state.elevations,
    windAngleDeg: state.windDirection,
    windSpeed: state.windSpeed,
    depths: state.depths,
    cols: COLS,
    rows: ROWS,
  }, [cellBuf.buffer, ageBuf.buffer]);
  return true;
}

// Wire up worker result handler
_fireWorker.onmessage = ({ data }) => {
  _fireWorkerBusy = false;
  state.fireState.cell = data.cell;
  state.fireState.age = data.age;
  state.fireState.embers = data.embers;
  state.fireState.burningCells.clear();
  for (let i = 0; i < data.cell.length; i++) {
    if (data.cell[i] === FIRE.BURNING) state.fireState.burningCells.add(i);
  }
  // Export burn severity if fire just completed
  if (state.fireState.burningCells.size === 0 && state.timestep > 0 &&
      sharedState.scenarioPhase !== 'fire-complete') {
    exportFireToSharedState(state.fireState, COLS, ROWS);
  }
  finishStep();
  // Render after worker result arrives
  renderMosaicMap();
  renderTimeline();
  if (_simTicksSinceFullRender >= 5) {
    _simTicksSinceFullRender = 0;
    renderCenterPanel();
    renderGraph();
  }
  _simTicksSinceFullRender++;
};

function stepSimulation() {
  // Fire-only mode: dispatch to worker (non-blocking)
  if (state.mode === 'fire') {
    dispatchFireWorker();
    return; // finishStep is called in onmessage handler
  }

  // Flood or both: run synchronously (flood is cheap, both needs sequential fire+flood)
  if (state.mode === 'fire' || state.mode === 'both') {
    stepFire(state.fireState, state.patchGrid, patchKeys, PATCH_PARAMS,
             state.elevations, state.windDirection, state.windSpeed,
             state.depths, COLS, ROWS, _cachedParams);
  }
  if (state.mode === 'flood' || state.mode === 'both') {
    const result = stepFlow(
      { depths: state.depths, patchGrid: state.patchGrid, elevations: state.elevations, cols: COLS, rows: ROWS },
      10, 1, { patchParams: PATCH_PARAMS, patchKeys }
    );
    state.depths = result.depths;
    state.fluxes = result.fluxes;
  }
  finishStep();
}

function detectEvents() {
  // Check φ crossing
  if (state.phiCrossTimestep < 0 && state.phi > PHI_STAR) {
    state.phiCrossTimestep = state.timestep;
  }

  // Check spanning: fire/flood reaches opposite edge from ignition
  if (state.spanningTimestep < 0) {
    const startR = state.zoomTarget.r;
    const targetR = startR < ROWS / 2 ? ROWS - 1 : 0;
    for (let c = 0; c < COLS; c++) {
      const idx = targetR * COLS + c;
      if (state.fireState.cell[idx] === FIRE.BURNING || state.fireState.cell[idx] === FIRE.BURNED ||
          state.depths[idx] > 0.01) {
        state.spanningTimestep = state.timestep;
        break;
      }
    }
  }
}

function restoreTimestep(t) {
  if (t < 0 || t >= state.snapshots.length) return;
  const snap = state.snapshots[t];
  state.fireState.cell = new Uint8Array(snap.cellState);
  state.depths = new Float32Array(snap.depths);
  state.timestep = t;
  // Rebuild burning set from restored cell state
  state.fireState.burningCells.clear();
  for (let i = 0; i < state.fireState.cell.length; i++) {
    if (state.fireState.cell[i] === FIRE.BURNING) state.fireState.burningCells.add(i);
  }
  const scrubber = document.getElementById('timeline-scrubber');
  if (scrubber) scrubber.value = state.timestep;
}

// ════════════════════════════════════════════════════════════════════════════
// Color Utilities
// ════════════════════════════════════════════════════════════════════════════
function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
}

// Generate distinct cluster colors using golden angle hue spacing
const clusterColorCache = new Map();
function clusterColor(clusterId, isGiant) {
  if (isGiant) return [255, 140, 50]; // saturated highlight for giant cluster
  if (clusterColorCache.has(clusterId)) return clusterColorCache.get(clusterId);
  const hue = (clusterId * 137.508) % 360;
  const col = hslToRgb(hue, 25, 55); // muted
  clusterColorCache.set(clusterId, col);
  return col;
}

function desaturate(r, g, b, factor) {
  const lum = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
  return [
    Math.round(lum + (r - lum) * factor),
    Math.round(lum + (g - lum) * factor),
    Math.round(lum + (b - lum) * factor),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// Canvas References & Layout
// ════════════════════════════════════════════════════════════════════════════
let leftCanvas, leftCtx;
let chartCanvas, chartCtx;
let rightCanvas, rightCtx;
let animFrame = null;

// Reusable small canvas for scaled mosaic rendering (avoids per-pixel screen fill)
const _mosaicSmall = new OffscreenCanvas(COLS, ROWS);
const _mosaicSmallCtx = _mosaicSmall.getContext('2d');

function getCanvasRefs() {
  leftCanvas = document.getElementById('mosaic-canvas');
  leftCtx = leftCanvas.getContext('2d');
  chartCanvas = document.getElementById('scurve-canvas');
  chartCtx = chartCanvas.getContext('2d');
  rightCanvas = document.getElementById('graph-canvas');
  rightCtx = rightCanvas.getContext('2d');
}

// ════════════════════════════════════════════════════════════════════════════
// LEFT PANEL — Mosaic Map
// ════════════════════════════════════════════════════════════════════════════
function renderMosaicMap() {
  const canvas = leftCanvas;
  const ctx = leftCtx;
  const w = canvas.width, h = canvas.height;
  if (w === 0 || h === 0) return; // not sized yet
  ctx.clearRect(0, 0, w, h);

  // Compute visible region based on scale slider
  const scale = state.scaleSlider; // 0=full, 1=zoomed
  const viewRadius = Math.round(COLS / 2 * (1 - scale * 0.75)); // at max zoom, show ~16x16 region
  const minR = Math.max(0, state.zoomTarget.r - viewRadius);
  const maxR = Math.min(ROWS - 1, state.zoomTarget.r + viewRadius);
  const minC = Math.max(0, state.zoomTarget.c - viewRadius);
  const maxC = Math.min(COLS - 1, state.zoomTarget.c + viewRadius);
  const viewRows = maxR - minR + 1;
  const viewCols = maxC - minC + 1;

  const cellW = w / viewCols;
  const cellH = h / viewRows;

  // Scaled rendering: fill a small viewCols × viewRows ImageData (one pixel per cell)
  // then scale up with drawImage — avoids filling every screen pixel individually.
  const smallW = viewCols, smallH = viewRows;
  // Resize the offscreen canvas if the view region changed
  if (_mosaicSmall.width !== smallW || _mosaicSmall.height !== smallH) {
    _mosaicSmall.width = smallW;
    _mosaicSmall.height = smallH;
  }
  const imgData = _mosaicSmallCtx.createImageData(smallW, smallH);
  const data = imgData.data;

  // One pixel per cell
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const idx = r * COLS + c;
      const key = patchKeys[state.patchGrid[idx]];
      const baseCol = PATCH_COLORS[key] || [128, 128, 128];
      const clusterId = state.clusterIds[idx];
      const isActive = state.cellIsActive[idx];

      let cr, cg, cb;
      if (!isActive) {
        [cr, cg, cb] = desaturate(baseCol[0], baseCol[1], baseCol[2], 0.2);
      } else if (clusterId === state.giantClusterId) {
        const gc = clusterColor(clusterId, true);
        cr = Math.round(baseCol[0] * 0.35 + gc[0] * 0.65);
        cg = Math.round(baseCol[1] * 0.35 + gc[1] * 0.65);
        cb = Math.round(baseCol[2] * 0.35 + gc[2] * 0.65);
      } else {
        const cc = clusterColor(clusterId, false);
        cr = Math.round(baseCol[0] * 0.5 + cc[0] * 0.5);
        cg = Math.round(baseCol[1] * 0.5 + cc[1] * 0.5);
        cb = Math.round(baseCol[2] * 0.5 + cc[2] * 0.5);
      }

      // Fire/flood overlay from simulation
      const fireCell = state.fireState.cell[idx];
      if (fireCell === FIRE.BURNING) {
        cr = 245; cg = 100; cb = 20;
      } else if (fireCell === FIRE.BURNED) {
        cr = Math.round(cr * 0.3 + 38 * 0.7);
        cg = Math.round(cg * 0.3 + 26 * 0.7);
        cb = Math.round(cb * 0.3 + 20 * 0.7);
      }
      if (state.depths[idx] > 0.005) {
        const alpha = Math.min(0.8, state.depths[idx] * 50);
        cr = Math.round(cr * (1-alpha) + 70 * alpha);
        cg = Math.round(cg * (1-alpha) + 130 * alpha);
        cb = Math.round(cb * (1-alpha) + 210 * alpha);
      }

      // Single pixel assignment per cell
      const off = ((r - minR) * smallW + (c - minC)) * 4;
      data[off] = cr; data[off+1] = cg; data[off+2] = cb; data[off+3] = 255;
    }
  }

  // Put the small image and scale up with nearest-neighbor interpolation
  _mosaicSmallCtx.putImageData(imgData, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(_mosaicSmall, 0, 0, w, h);

  // ── Soil type overlay (hatch pattern) ──
  if (state.showSoil) {
    ctx.globalAlpha = 0.3;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const key = patchKeys[state.patchGrid[r * COLS + c]];
        const px = (c - minC) * cellW;
        const py = (r - minR) * cellH;

        // Different hatch patterns per soil/land type
        ctx.strokeStyle = PATCH_PARAMS[key].color;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        if (key === 'forest') {
          // Cross hatch
          ctx.moveTo(px, py); ctx.lineTo(px + cellW, py + cellH);
          ctx.moveTo(px + cellW, py); ctx.lineTo(px, py + cellH);
        } else if (key === 'wetland') {
          // Horizontal lines
          ctx.moveTo(px, py + cellH * 0.33); ctx.lineTo(px + cellW, py + cellH * 0.33);
          ctx.moveTo(px, py + cellH * 0.66); ctx.lineTo(px + cellW, py + cellH * 0.66);
        } else if (key === 'urban') {
          // Grid
          ctx.moveTo(px + cellW/2, py); ctx.lineTo(px + cellW/2, py + cellH);
          ctx.moveTo(px, py + cellH/2); ctx.lineTo(px + cellW, py + cellH/2);
        } else if (key === 'bare') {
          // Dots
          ctx.arc(px + cellW/2, py + cellH/2, cellW * 0.15, 0, Math.PI * 2);
        } else if (key === 'corridor') {
          // Diagonal
          ctx.moveTo(px, py + cellH); ctx.lineTo(px + cellW, py);
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ── Elevation contour overlay ──
  if (state.showContours) {
    // Marching squares contours
    const levels = 8;
    let minE = Infinity, maxE = -Infinity;
    for (let i = 0; i < state.elevations.length; i++) {
      if (state.elevations[i] < minE) minE = state.elevations[i];
      if (state.elevations[i] > maxE) maxE = state.elevations[i];
    }
    const range = maxE - minE || 1;

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 0.8;

    for (let level = 1; level < levels; level++) {
      const threshold = minE + (level / levels) * range;
      ctx.beginPath();
      for (let r = minR; r < maxR; r++) {
        for (let c = minC; c < maxC; c++) {
          const e00 = state.elevations[r * COLS + c];
          const e10 = state.elevations[(r+1) * COLS + c];
          const e01 = state.elevations[r * COLS + (c+1)];
          const e11 = state.elevations[(r+1) * COLS + (c+1)];

          // Simple marching squares: check which corners are above threshold
          const bits = ((e00 >= threshold) ? 1 : 0) | ((e01 >= threshold) ? 2 : 0) |
                       ((e11 >= threshold) ? 4 : 0) | ((e10 >= threshold) ? 8 : 0);
          if (bits === 0 || bits === 15) continue;

          const px = (c - minC) * cellW;
          const py = (r - minR) * cellH;

          // Interpolation helpers
          const lerp = (a, b) => (threshold - a) / (b - a || 1);
          const top    = px + lerp(e00, e01) * cellW;
          const bottom = px + lerp(e10, e11) * cellW;
          const left   = py + lerp(e00, e10) * cellH;
          const right  = py + lerp(e01, e11) * cellH;

          // Draw contour segments for common cases
          if (bits === 1 || bits === 14) { ctx.moveTo(top, py); ctx.lineTo(px, left); }
          else if (bits === 2 || bits === 13) { ctx.moveTo(top, py); ctx.lineTo(px + cellW, right); }
          else if (bits === 3 || bits === 12) { ctx.moveTo(px, left); ctx.lineTo(px + cellW, right); }
          else if (bits === 4 || bits === 11) { ctx.moveTo(px + cellW, right); ctx.lineTo(bottom, py + cellH); }
          else if (bits === 6 || bits === 9) { ctx.moveTo(top, py); ctx.lineTo(bottom, py + cellH); }
          else if (bits === 7 || bits === 8) { ctx.moveTo(px, left); ctx.lineTo(bottom, py + cellH); }
          else if (bits === 5) {
            ctx.moveTo(top, py); ctx.lineTo(px, left);
            ctx.moveTo(px + cellW, right); ctx.lineTo(bottom, py + cellH);
          } else if (bits === 10) {
            ctx.moveTo(top, py); ctx.lineTo(px + cellW, right);
            ctx.moveTo(px, left); ctx.lineTo(bottom, py + cellH);
          }
        }
      }
      ctx.stroke();
    }
  }

  // ── Grid lines when zoomed in ──
  if (scale > 0.3) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.5;
    for (let r = minR; r <= maxR + 1; r++) {
      const y = (r - minR) * cellH;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    for (let c = minC; c <= maxC + 1; c++) {
      const x = (c - minC) * cellW;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  }

  // ── Zoom target crosshair ──
  if (scale < 0.5) {
    const cx = (state.zoomTarget.c - minC + 0.5) * cellW;
    const cy = (state.zoomTarget.r - minR + 0.5) * cellH;
    ctx.strokeStyle = 'rgba(255,200,50,0.6)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(cellW, cellH) * 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Store view mapping for click handling
  leftCanvas._viewMinR = minR; leftCanvas._viewMinC = minC;
  leftCanvas._viewCellW = cellW; leftCanvas._viewCellH = cellH;
}

// ════════════════════════════════════════════════════════════════════════════
// CENTER PANEL — φ Display + S-Curve Chart
// ════════════════════════════════════════════════════════════════════════════
function renderCenterPanel() {
  // Update φ display
  const phiVal = document.getElementById('phi-value');
  const phiLabel = document.getElementById('phi-label');
  if (phiVal) phiVal.textContent = state.phi.toFixed(2);

  if (phiLabel) {
    if (state.phi > PHI_STAR) {
      phiLabel.textContent = 'above threshold — spread percolates';
      phiLabel.style.color = '#ff8844';
    } else {
      phiLabel.textContent = 'below threshold — spread stays local';
      phiLabel.style.color = '#5599dd';
    }
  }

  // Update threshold display
  const threshVal = document.getElementById('threshold-value');
  if (threshVal) threshVal.textContent = state.flammabilityThreshold.toFixed(2);

  renderSCurve();
}

function renderSCurve() {
  const ctx = chartCtx;
  const w = chartCanvas.width, h = chartCanvas.height;
  if (w === 0 || h === 0) return;
  ctx.clearRect(0, 0, w, h);

  const pad = { top: 20, right: 15, bottom: 35, left: 40 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  // Axes
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + plotH);
  ctx.lineTo(pad.left + plotW, pad.top + plotH);
  ctx.stroke();

  // Axis labels
  ctx.fillStyle = '#888';
  ctx.font = '10px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('φ (order parameter)', pad.left + plotW / 2, h - 3);
  ctx.save();
  ctx.translate(10, pad.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('spread extent', 0, 0);
  ctx.restore();

  // Tick marks
  ctx.fillStyle = '#666';
  ctx.font = '9px system-ui';
  ctx.textAlign = 'center';
  for (let i = 0; i <= 5; i++) {
    const v = i / 5;
    const x = pad.left + v * plotW;
    ctx.fillText(v.toFixed(1), x, pad.top + plotH + 14);
  }
  ctx.textAlign = 'right';
  for (let i = 0; i <= 5; i++) {
    const v = i / 5;
    const y = pad.top + plotH - v * plotH;
    ctx.fillText(v.toFixed(1), pad.left - 5, y + 3);
  }

  // Theoretical S-curve (sigmoid approximation of percolation transition)
  ctx.strokeStyle = 'rgba(120,180,255,0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 100; i++) {
    const phi = i / 100;
    // Percolation S-curve: spread ~ 0 below threshold, rises steeply at φ*, approaches 1
    const spread = 1 / (1 + Math.exp(-15 * (phi - PHI_STAR)));
    const x = pad.left + phi * plotW;
    const y = pad.top + plotH - spread * plotH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // φ* vertical dashed line
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = 'rgba(255,200,100,0.6)';
  ctx.lineWidth = 1;
  const xStar = pad.left + PHI_STAR * plotW;
  ctx.beginPath();
  ctx.moveTo(xStar, pad.top);
  ctx.lineTo(xStar, pad.top + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  // Label φ*
  ctx.fillStyle = '#cc9944';
  ctx.font = '9px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('φ*=' + PHI_STAR, xStar, pad.top - 5);

  // Empirical points
  if (state.empiricalPoints.length > 0) {
    ctx.fillStyle = 'rgba(255,120,80,0.8)';
    for (const pt of state.empiricalPoints) {
      const x = pad.left + Math.min(1, pt.phi) * plotW;
      const y = pad.top + plotH - Math.min(1, pt.spreadExtent) * plotH;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Stream table empirical overlay
  if (state.streamTableData) {
    const st = state.streamTableData;
    if (st.empiricalPoints) {
      ctx.fillStyle = 'rgba(240,100,60,0.85)';
      for (const pt of st.empiricalPoints) {
        const x = pad.left + Math.min(1, pt.phi) * plotW;
        const y = pad.top + plotH - Math.min(1, pt.spreadExtent) * plotH;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (st.phiStar != null) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(80,200,180,0.7)';
      ctx.lineWidth = 1;
      const xEmp = pad.left + Math.min(1, st.phiStar) * plotW;
      ctx.beginPath();
      ctx.moveTo(xEmp, pad.top);
      ctx.lineTo(xEmp, pad.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#50c8b4';
      ctx.font = '9px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('empirical \u03C6*=' + st.phiStar.toFixed(2), xEmp, pad.top + plotH + 26);
    }
  }

  // Current φ dot
  const currentSpread = 1 / (1 + Math.exp(-15 * (state.phi - PHI_STAR)));
  const dotX = pad.left + Math.min(1, state.phi) * plotW;
  const dotY = pad.top + plotH - currentSpread * plotH;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(dotX, dotY, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = state.phi > PHI_STAR ? '#ff8844' : '#5599dd';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// ════════════════════════════════════════════════════════════════════════════
// RIGHT PANEL — Tree-to-Tree Network Graph
// ════════════════════════════════════════════════════════════════════════════
let graphNodes = [];    // [{r, c, x, y, vx, vy, state, vulnerability}]
let graphEdges = [];    // [{i, j, weight}]

function buildGraph() {
  graphNodes = [];
  graphEdges = [];

  if (state.scaleSlider < 0.2) return; // Too zoomed out

  const radius = Math.max(3, Math.round(COLS / 2 * (1 - state.scaleSlider * 0.75)));
  const rMin = Math.max(0, state.zoomTarget.r - Math.min(8, radius));
  const rMax = Math.min(ROWS - 1, state.zoomTarget.r + Math.min(8, radius));
  const cMin = Math.max(0, state.zoomTarget.c - Math.min(8, radius));
  const cMax = Math.min(COLS - 1, state.zoomTarget.c + Math.min(8, radius));

  const nodeMap = new Map(); // "r,c" → index

  // Create nodes
  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      const key = `${r},${c}`;
      const idx = r * COLS + c;
      const pKey = patchKeys[state.patchGrid[idx]];
      const vuln = vulnerabilityScore(r, c);

      // Determine node state
      let nodeState = 'safe';
      const active = state.cellIsActive[idx];
      if (!active) nodeState = 'barrier';
      else if (state.fireState.cell[idx] === FIRE.BURNING) nodeState = 'burning';
      else if (state.fireState.cell[idx] === FIRE.BURNED) nodeState = 'barrier';
      else {
        // Check if adjacent to burning
        let adjBurning = false;
        for (const [dr, dc] of DIRS8) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
            if (state.fireState.cell[nr * COLS + nc] === FIRE.BURNING) { adjBurning = true; break; }
          }
        }
        if (adjBurning) nodeState = 'at-risk';
      }

      // Grid-positioned layout
      const gw = rightCanvas.width - 60;
      const gh = rightCanvas.height - 80;
      const cols = cMax - cMin + 1;
      const rows = rMax - rMin + 1;
      const x = 30 + ((c - cMin) / Math.max(1, cols - 1)) * gw;
      const y = 30 + ((r - rMin) / Math.max(1, rows - 1)) * gh;

      nodeMap.set(key, graphNodes.length);
      graphNodes.push({ r, c, x, y, vx: 0, vy: 0, state: nodeState, vulnerability: vuln, patchKey: pKey });
    }
  }

  // Create edges
  for (let ni = 0; ni < graphNodes.length; ni++) {
    const n = graphNodes[ni];
    for (const [dr, dc] of DIRS8) {
      const nr = n.r + dr, nc = n.c + dc;
      const key = `${nr},${nc}`;
      const nj = nodeMap.get(key);
      if (nj === undefined || nj <= ni) continue; // avoid duplicate edges

      const w = spreadProbability(n.r, n.c, nr, nc);
      if (w >= state.minEdgeWeight) {
        graphEdges.push({ i: ni, j: nj, weight: w });
      }
    }
  }

  state._dirty.graph = false;
}

function renderGraph() {
  const ctx = rightCtx;
  const w = rightCanvas.width, h = rightCanvas.height;
  if (w === 0 || h === 0) return;
  ctx.clearRect(0, 0, w, h);

  if (state.scaleSlider < 0.2) {
    // Show prompt
    ctx.fillStyle = '#666';
    ctx.font = '13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Zoom in on the left panel', w / 2, h / 2 - 10);
    ctx.fillText('to see tree-to-tree detail', w / 2, h / 2 + 10);
    return;
  }

  if (state._dirty.graph) buildGraph();

  // Draw edges
  for (const e of graphEdges) {
    const a = graphNodes[e.i], b = graphNodes[e.j];
    const alpha = 0.15 + e.weight * 0.6;
    ctx.strokeStyle = `rgba(150,180,220,${alpha.toFixed(2)})`;
    ctx.lineWidth = 0.5 + e.weight * 3;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // Draw nodes
  const stateColors = {
    burning: '#ee7733',
    'at-risk': '#ddaa33',
    safe: '#55aa55',
    barrier: '#666666',
  };

  for (let i = 0; i < graphNodes.length; i++) {
    const n = graphNodes[i];
    const radius = 3 + n.vulnerability * 6;
    const col = stateColors[n.state] || '#888';

    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
    ctx.fill();

    // Border
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  // ── Wind compass ──
  renderWindCompass(ctx, w - 35, 35, 22);

  // ── Tooltip for selected node ──
  if (state._selectedNode !== undefined && state._selectedNode < graphNodes.length) {
    renderNodeTooltip(ctx, graphNodes[state._selectedNode]);
  }
}

function renderWindCompass(ctx, cx, cy, r) {
  // Background circle
  ctx.fillStyle = 'rgba(20,20,30,0.7)';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Cardinal labels
  ctx.fillStyle = '#888';
  ctx.font = '8px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('N', cx, cy - r - 1);
  ctx.fillText('S', cx, cy + r + 8);
  ctx.fillText('E', cx + r + 6, cy + 3);
  ctx.fillText('W', cx - r - 6, cy + 3);

  // Wind arrow (points direction wind blows TOWARD, i.e., downwind)
  const rad = (state.windDirection * Math.PI) / 180;
  const dx = Math.sin(rad) * r * 0.8;
  const dy = -Math.cos(rad) * r * 0.8;

  ctx.strokeStyle = '#dd8833';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - dx * 0.3, cy - dy * 0.3);
  ctx.lineTo(cx + dx, cy + dy);
  ctx.stroke();

  // Arrowhead
  const angle = Math.atan2(dy, dx);
  ctx.fillStyle = '#dd8833';
  ctx.beginPath();
  ctx.moveTo(cx + dx, cy + dy);
  ctx.lineTo(cx + dx - 6 * Math.cos(angle - 0.4), cy + dy - 6 * Math.sin(angle - 0.4));
  ctx.lineTo(cx + dx - 6 * Math.cos(angle + 0.4), cy + dy - 6 * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();
}

function renderNodeTooltip(ctx, node) {
  const idx = node.r * COLS + node.c;
  const elev = state.elevations[idx].toFixed(3);
  const key = node.patchKey;
  const soilName = PATCH_PARAMS[key]?.name || key;

  // Compute neighbor probabilities
  const neighbors = [];
  for (const [dr, dc] of DIRS8) {
    const nr = node.r + dr, nc = node.c + dc;
    if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
    const prob = spreadProbability(node.r, node.c, nr, nc);
    if (prob > 0.01) neighbors.push({ dr, dc, prob });
  }

  const x = Math.min(node.x + 12, rightCanvas.width - 150);
  const y = Math.max(node.y - 10, 10);
  const lineH = 14;
  const lines = [
    `Soil: ${soilName}`,
    `Elevation: ${elev}`,
    `State: ${node.state}`,
    `Vuln: ${node.vulnerability.toFixed(2)}`,
    ...neighbors.slice(0, 4).map(n => `  → (${n.dr},${n.dc}): ${n.prob.toFixed(2)}`),
  ];

  ctx.fillStyle = 'rgba(15,15,25,0.9)';
  ctx.fillRect(x, y, 140, lines.length * lineH + 8);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(x, y, 140, lines.length * lineH + 8);

  ctx.fillStyle = '#ccc';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  lines.forEach((line, i) => {
    ctx.fillText(line, x + 6, y + 14 + i * lineH);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// BOTTOM BAR — Timeline
// ════════════════════════════════════════════════════════════════════════════
function renderTimeline() {
  const scrubber = document.getElementById('timeline-scrubber');
  const label = document.getElementById('timestep-label');
  if (scrubber) {
    scrubber.max = Math.max(0, state.maxTimestep);
    scrubber.value = state.timestep;
  }
  if (label) label.textContent = `t = ${state.timestep}`;

  // Event markers
  const markers = document.getElementById('timeline-markers');
  if (markers) {
    markers.innerHTML = '';
    const total = Math.max(1, state.maxTimestep);
    if (state.phiCrossTimestep >= 0) {
      const pct = (state.phiCrossTimestep / total * 100).toFixed(1);
      const m = document.createElement('div');
      m.className = 'timeline-marker phi-cross';
      m.style.left = pct + '%';
      m.title = `φ crosses φ* at t=${state.phiCrossTimestep}`;
      m.innerHTML = `<span class="marker-label">φ>φ*</span>`;
      markers.appendChild(m);
    }
    if (state.spanningTimestep >= 0) {
      const pct = (state.spanningTimestep / total * 100).toFixed(1);
      const m = document.createElement('div');
      m.className = 'timeline-marker spanning';
      m.style.left = pct + '%';
      m.title = `Spanning event at t=${state.spanningTimestep}`;
      m.innerHTML = `<span class="marker-label">span</span>`;
      markers.appendChild(m);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Render All
// ════════════════════════════════════════════════════════════════════════════
function renderAll() {
  _simTicksSinceFullRender = 0;
  renderMosaicMap();
  renderCenterPanel();
  renderGraph();
  renderTimeline();
}

// ════════════════════════════════════════════════════════════════════════════
// Animation Loop
// ════════════════════════════════════════════════════════════════════════════
let lastStepTime = 0;
let lastRenderTime = 0;
let _simTicksSinceFullRender = 0;
const STEP_INTERVAL = 80; // ms between sim steps (reduced from 150ms — worker is non-blocking)
const RENDER_INTERVAL = 33; // ~30fps cap

function animationLoop(timestamp) {
  animFrame = requestAnimationFrame(animationLoop);

  let stepped = false;
  if (state.playing && timestamp - lastStepTime >= STEP_INTERVAL) {
    lastStepTime = timestamp;

    // If we're at the end of recorded snapshots, advance the simulation
    if (state.timestep >= state.maxTimestep) {
      // Check if simulation should stop (no more active fire)
      if ((state.mode === 'fire' || state.mode === 'both') && !hasActiveFire(state.fireState) && state.timestep > 0) {
        state.playing = false;
        document.getElementById('play-btn').textContent = '▶';
        // Export burn severity to shared state on fire completion
        if (sharedState.scenarioPhase !== 'fire-complete') {
          exportFireToSharedState(state.fireState, COLS, ROWS);
        }
      } else {
        stepSimulation();
        // For fire-only mode, the worker handles render via onmessage.
        // For flood/both, step is synchronous so we render here.
        stepped = (state.mode !== 'fire');
      }
    } else {
      // Scrubbing through existing snapshots
      state.timestep++;
      restoreTimestep(state.timestep);
      stepped = true;
    }
  }

  // Throttle rendering to ~30fps (skip for fire-only — worker's onmessage renders)
  const shouldRender = stepped || (timestamp - lastRenderTime >= RENDER_INTERVAL);
  if (shouldRender && (stepped || (state.playing && state.mode !== 'fire'))) {
    lastRenderTime = timestamp;
    _simTicksSinceFullRender++;

    // During playback: only redraw mosaic + timeline per tick.
    // Full renderAll (center panel + graph) every 5 ticks — φ doesn't change during fire.
    renderMosaicMap();
    renderTimeline();
    if (_simTicksSinceFullRender >= 5 || !state.playing) {
      _simTicksSinceFullRender = 0;
      renderCenterPanel();
      renderGraph();
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Event Wiring
// ════════════════════════════════════════════════════════════════════════════
function wireEvents() {
  // ── Flammability threshold slider ──
  const threshSlider = document.getElementById('threshold-slider');
  threshSlider.addEventListener('input', () => {
    state.flammabilityThreshold = parseFloat(threshSlider.value);
    recomputeClusters();
    state._dirty.graph = true;
    renderAll();
  });

  // ── Scale slider ──
  const scaleSlider = document.getElementById('scale-slider');
  scaleSlider.addEventListener('input', () => {
    state.scaleSlider = parseFloat(scaleSlider.value);
    state._dirty.graph = true;
    renderAll();
  });

  // ── Mode toggle ──
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.dataset.mode;
      recomputeClusters();
      state._dirty.graph = true;
      renderAll();
    });
  });

  // ── Overlay toggles ──
  document.getElementById('toggle-contours').addEventListener('change', (e) => {
    state.showContours = e.target.checked;
    renderAll();
  });
  document.getElementById('toggle-soil').addEventListener('change', (e) => {
    state.showSoil = e.target.checked;
    renderAll();
  });

  // ── Min edge weight slider ──
  const edgeSlider = document.getElementById('edge-weight-slider');
  edgeSlider.addEventListener('input', () => {
    state.minEdgeWeight = parseFloat(edgeSlider.value);
    document.getElementById('edge-weight-value').textContent = state.minEdgeWeight.toFixed(2);
    state._dirty.graph = true;
    renderAll();
  });

  // ── Wind compass drag ──
  rightCanvas.addEventListener('mousedown', (e) => {
    const rect = rightCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Check if clicking on compass area
    const compassCx = rightCanvas.width - 35;
    const compassCy = 35;
    const dist = Math.sqrt((mx - compassCx)**2 + (my - compassCy)**2);
    if (dist < 30) {
      rightCanvas._draggingCompass = true;
      return;
    }

    // Check if clicking on a node
    for (let i = 0; i < graphNodes.length; i++) {
      const n = graphNodes[i];
      const d = Math.sqrt((mx - n.x)**2 + (my - n.y)**2);
      if (d < 3 + n.vulnerability * 6 + 2) {
        state._selectedNode = i;
        renderGraph();
        return;
      }
    }
    state._selectedNode = undefined;
    renderGraph();
  });

  rightCanvas.addEventListener('mousemove', (e) => {
    if (!rightCanvas._draggingCompass) return;
    const rect = rightCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const compassCx = rightCanvas.width - 35;
    const compassCy = 35;
    const angle = Math.atan2(mx - compassCx, -(my - compassCy));
    state.windDirection = ((angle * 180 / Math.PI) + 360) % 360;
    state._dirty.graph = true;
    renderAll();
  });

  document.addEventListener('mouseup', () => {
    rightCanvas._draggingCompass = false;
  });

  // ── Left panel click: set zoom target ──
  leftCanvas.addEventListener('click', (e) => {
    const rect = leftCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const scaleX = leftCanvas.width / rect.width;
    const scaleY = leftCanvas.height / rect.height;
    const c = Math.floor(mx * scaleX / leftCanvas._viewCellW + leftCanvas._viewMinC);
    const r = Math.floor(my * scaleY / leftCanvas._viewCellH + leftCanvas._viewMinR);
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
      state.zoomTarget = { r, c };
      state._dirty.graph = true;
      renderAll();
    }
  });

  // ── Playback controls ──
  document.getElementById('play-btn').addEventListener('click', () => {
    state.playing = !state.playing;
    document.getElementById('play-btn').textContent = state.playing ? '⏸' : '▶';
    if (state.playing && state.snapshots.length === 0) {
      // Initialize simulation on first play
      resetSimulation();
      state.playing = true;
      document.getElementById('play-btn').textContent = '⏸';
    }
  });

  document.getElementById('reset-btn').addEventListener('click', () => {
    resetSimulation();
    renderAll();
  });

  // ── Timeline scrubber ──
  const scrubber = document.getElementById('timeline-scrubber');
  scrubber.addEventListener('input', () => {
    const t = parseInt(scrubber.value);
    if (t >= 0 && t < state.snapshots.length) {
      state.playing = false;
      document.getElementById('play-btn').textContent = '▶';
      restoreTimestep(t);
      renderAll();
    }
  });

  // ── New landscape button ──
  document.getElementById('new-landscape-btn').addEventListener('click', () => {
    initGrid();
    resetSimulation();
    renderAll();
  });

  // ── Canvas resize ──
  function resizeCanvases() {
    const leftPanel = document.getElementById('left-panel');
    const rightPanel = document.getElementById('right-panel');
    const chartWrap = document.getElementById('scurve-wrap');

    if (leftPanel) {
      leftCanvas.width = leftPanel.clientWidth;
      leftCanvas.height = leftPanel.clientHeight - 50; // room for scale slider
    }
    if (chartWrap) {
      chartCanvas.width = chartWrap.clientWidth;
      chartCanvas.height = chartWrap.clientHeight;
    }
    if (rightPanel) {
      rightCanvas.width = rightPanel.clientWidth;
      rightCanvas.height = rightPanel.clientHeight - 50; // room for edge slider
    }
    state._dirty.graph = true;
    renderAll();
  }

  window.addEventListener('resize', resizeCanvases);
  // Initial sizing after layout settles
  requestAnimationFrame(() => { resizeCanvases(); renderAll(); });
}

// ════════════════════════════════════════════════════════════════════════════
// Stream Table Data Import
// ════════════════════════════════════════════════════════════════════════════
function wireStreamTableUpload() {
  const btn = document.getElementById('stream-table-upload-btn');
  const statusEl = document.getElementById('stream-table-status');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!Array.isArray(data.empiricalPoints)) throw new Error('Missing empiricalPoints array');
          state.streamTableData = data;
          if (statusEl) {
            statusEl.textContent = `Loaded ${data.empiricalPoints.length} points`;
            statusEl.style.color = '#50c8b4';
          }
          renderAll();
        } catch (err) {
          if (statusEl) { statusEl.textContent = 'Error: ' + err.message; statusEl.style.color = '#e55'; }
        }
      };
      reader.readAsText(file);
    });
    input.click();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Bootstrap
// ════════════════════════════════════════════════════════════════════════════
export function init() {
  getCanvasRefs();
  initGrid();
  wireEvents();
  wireStreamTableUpload();
  resetSimulation();
  renderAll();
  animFrame = requestAnimationFrame(animationLoop);
}
