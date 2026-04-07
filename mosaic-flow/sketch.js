/**
 * Main sketch: land mosaic grid, physics loop, visualization.
 */

import { stepFlow, getElevation, flowWeights } from './flow.js';
import { PATCH_TYPES, PATCH_PARAMS, DEFAULT_MATRIX } from './patches.js';
import { createUI } from './ui.js';
import { computeConnectivity } from './connectivity.js';
import { spawnParticles, advectParticles } from './particles.js';
import { createLBMState, stepLBM } from './lbm.js';
import { createFireState, resetFireState, igniteAt, stepFire, FIRE } from './fire.js';
import { simState } from './state.js';
import { fetchSiteFeatures, rebuildGraph, PHI_STAR as SITE_PHI_STAR } from './site-features.js';
import { createPhiPanel, setPhiGrid, getClusterOverlay } from './phi-panel.js';

const COLS = 64;
const ROWS = 64;

let patchGrid;
let depths;
let elevations;
let fluxes;
let sedimentDepth;
let particles = [];
let sedimentCount = 0;
let connectivity = 0;
let drainageContrib = null;
let contributingArea = null;   // Uint8Array mask for right-click upstream highlight
let interventionMarkers = [];  // { framesAgo, patchKey } logged when user paints while running
let lbmState = null;
let fireState = null;
let waterSources = []; // Array<{i, j}> — persistent point sources
let floodRect = null;  // {r0,c0,r1,c1} during shift-drag preview; null otherwise
let fireTickAccum = 0; // accumulator for fire's independent tick rate
// chartHistory: ring buffer of { runoffRatio, meanStorage, etFraction, concentration }
let chartHistory = [];
let cellPx = 8;
let canvasW = 0;
let canvasH = 0;

// ── Network zoom state ───────────────────────────────────────────────────────
let networkZoom = null; // null = mosaic view; { centerR, centerC } = network view
const NETWORK_RADIUS = 6; // 12×12 neighborhood (radius 6 from center)
let networkMinEdgeWeight = 0.05;

// ── Cell selection + site features state ─────────────────────────────────────
let selectedCells = [];           // [{r, c}]
let _selDragStart = null;         // {r, c} during drag select
let _siteFeatureResult = null;    // { nodes, edges, phiLocal, giantSize, status }
let _siteFeatureNodes = null;     // raw nodes array (for edge rebuild on wind change)
let _siteFetching = false;
let _siteFetchError = false;
let _lastFetchKey = '';
let _lastWindAngle = -1;
let _lastWindSpeed = -1;


const patchKeys = Object.keys(PATCH_PARAMS);

/** Parse a 6-digit hex color string to [r, g, b]. */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Lerp a color toward its luminance (desaturate). factor=1 full color, 0=grayscale. */
function desaturate(r, g, b, factor) {
  const lum = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
  return [
    Math.round(lum + (r - lum) * factor),
    Math.round(lum + (g - lum) * factor),
    Math.round(lum + (b - lum) * factor),
  ];
}

/**
 * BFS upstream from (targetI, targetJ) through the elevation field.
 * Returns Uint8Array mask where 1 = cell drains to target.
 */
function computeContributingArea(targetI, targetJ) {
  const mask = new Uint8Array(COLS * ROWS);
  const queue = [[targetI, targetJ]];
  mask[targetI * COLS + targetJ] = 1;

  while (queue.length > 0) {
    const [ci, cj] = queue.shift();
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        if (di === 0 && dj === 0) continue;
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || ni >= ROWS || nj < 0 || nj >= COLS) continue;
        if (mask[ni * COLS + nj]) continue;
        // Does (ni, nj) route any flow into (ci, cj)?
        const weights = flowWeights(ni, nj, elevations, COLS, ROWS);
        if (weights.some(w => w.ni === ci && w.nj === cj)) {
          mask[ni * COLS + nj] = 1;
          queue.push([ni, nj]);
        }
      }
    }
  }
  return mask;
}

function initGrid() {
  patchGrid = new Uint8Array(COLS * ROWS);
  depths = new Float32Array(COLS * ROWS);
  fluxes = new Float32Array(COLS * ROWS * 2);
  sedimentDepth = new Float32Array(COLS * ROWS);

  const typeIndex = Object.keys(PATCH_PARAMS).indexOf(DEFAULT_MATRIX);
  for (let i = 0; i < ROWS; i++) {
    for (let j = 0; j < COLS; j++) {
      patchGrid[i * COLS + j] = typeIndex;
    }
  }

  updateElevations();
}

function resizeCanvas(p) {
  const w = (p && typeof p.windowWidth === 'number' && p.windowWidth > 0) ? p.windowWidth : window.innerWidth;
  const h = (p && typeof p.windowHeight === 'number' && p.windowHeight > 0) ? p.windowHeight : window.innerHeight;
  cellPx = Math.max(4, Math.floor(Math.min(w, h) / COLS));
  canvasW = COLS * cellPx;
  canvasH = ROWS * cellPx;
}

function updateElevations() {
  const ctrl = simState.controls;
  if (ctrl?.elevationMode === 'dem' && ctrl?.demElevations?.length === COLS * ROWS) {
    elevations = new Float32Array(ctrl.demElevations);
  } else {
    elevations = new Float32Array(COLS * ROWS);
    for (let i = 0; i < ROWS; i++) {
      for (let j = 0; j < COLS; j++) {
        elevations[i * COLS + j] = getElevation(
          i, j, COLS, ROWS,
          ctrl?.slopeAngle ?? 270,
          ctrl?.slopeMagnitude ?? 0.01
        );
      }
    }
  }
  contributingArea = null; // terrain changed, clear stale upstream mask
}

const sketch = (p) => {
  p.setup = () => {
    resizeCanvas(p);
    const canvas = p.createCanvas(canvasW, canvasH);
    canvas.parent('mosaic-container');
    // Prevent browser context menu so right-click can be used for contributing area
    canvas.elt.addEventListener('contextmenu', e => e.preventDefault());

    p.windowResized = () => {
      resizeCanvas(p);
      p.resizeCanvas(canvasW, canvasH);
    };

    initGrid();
    fireState = createFireState(COLS, ROWS);

    const { controls, updateMetrics } = createUI((msg, data) => {
      if (msg === 'reset') {
        depths.fill(0);
        sedimentDepth.fill(0);
        particles.length = 0;
        sedimentCount = 0;
        chartHistory = [];
        drainageContrib = null;
        interventionMarkers = [];
        lbmState = null;
        if (fireState) resetFireState(fireState);
        waterSources = [];
      } else if (msg === 'resetAll') {
        window.location.reload();
      } else if (msg === 'restore') {
        const wetlandIdx = patchKeys.indexOf('wetland');
        const forestIdx = patchKeys.indexOf('forest');
        for (let i = 0; i < ROWS * COLS; i++) {
          if (Math.random() < 0.15) patchGrid[i] = wetlandIdx;
          else if (Math.random() < 0.15) patchGrid[i] = forestIdx;
        }
      } else if (msg === 'randomize') {
        const numTypes = patchKeys.length;
        const matrixIdx = patchKeys.indexOf('grass');
        for (let i = 0; i < ROWS * COLS; i++) {
          patchGrid[i] = matrixIdx;
        }
        const numBlobs = 15 + Math.floor(Math.random() * 35);
        for (let b = 0; b < numBlobs; b++) {
          const cx = Math.floor(Math.random() * COLS);
          const cy = Math.floor(Math.random() * ROWS);
          const typeIdx = Math.floor(Math.random() * numTypes);
          const radius = 2 + Math.floor(Math.random() * 10);
          const rr = radius * radius;
          for (let i = Math.max(0, cy - radius); i <= Math.min(ROWS - 1, cy + radius); i++) {
            for (let j = Math.max(0, cx - radius); j <= Math.min(COLS - 1, cx + radius); j++) {
              const di = i - cy, dj = j - cx;
              if (di * di + dj * dj <= rr) {
                patchGrid[i * COLS + j] = typeIdx;
              }
            }
          }
        }
      } else if (msg === 'export') {
        const ctrl = simState.controls;
        const payload = {
          version: 1,
          cols: COLS,
          rows: ROWS,
          patchGrid: Array.from(patchGrid),
          elevations: ctrl?.demElevations ? Array.from(ctrl.demElevations) : undefined,
          exportedAt: new Date().toISOString(),
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `mosaic-scenario-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      } else if (msg === 'clear-fire') {
        if (fireState) resetFireState(fireState);
        fireTickAccum = 0;
      } else if (msg === 'clear-sources') {
        waterSources = [];
      } else if (msg === 'sim-fire') {
        depths.fill(0);
        fluxes.fill(0);
        sedimentDepth.fill(0);
        particles.length = 0;
        waterSources = [];
        floodRect = null;
        chartHistory = [];
        drainageContrib = null;
        connectivity = 0;
        lbmState = null;
        if (fireState) resetFireState(fireState);
        fireTickAccum = 0;
        updateElevations();
      } else if (msg === 'sim-water') {
        if (fireState) resetFireState(fireState);
        fireTickAccum = 0;
        updateElevations();
      } else if (msg === 'import' && data) {
        const grid = data.patchGrid;
        if (Array.isArray(grid) && grid.length === COLS * ROWS) {
          for (let i = 0; i < grid.length; i++) {
            const v = Math.floor(grid[i]);
            patchGrid[i] = Math.max(0, Math.min(v, patchKeys.length - 1));
          }
        }
        const ctrl = simState.controls;
        if (ctrl) {
          ctrl.elevationMode = 'dem';
          if (Array.isArray(data.elevations) && data.elevations.length === COLS * ROWS) {
            ctrl.demElevations = new Float32Array(data.elevations);
          } else {
            ctrl.demElevations = null;
          }
        }
        if (Array.isArray(grid) && grid.length !== COLS * ROWS) {
          console.warn('Import: invalid grid dimensions');
        }
        updateElevations();
      } else {
        updateElevations();
      }
      // Refresh phi panel whenever landscape or elevation changes
      setPhiGrid(patchGrid, COLS, ROWS);
    });

    simState.controls = controls;
    // Keep window.mosaicControls as a backward-compat alias for standalone builds
    window.mosaicControls = controls;
    updateElevations(); // apply initial DEM from controls

    // Phi panel
    createPhiPanel(document.getElementById('mosaic-container'));
    setPhiGrid(patchGrid, COLS, ROWS);

    const runLoop = () => {
      if (!controls.running) return;

      // Fire mode: only wildfire spread — no rainfall, flow, or sediment
      if (controls.simMode === 'fire') {
        const mult = Math.max(1, controls.speedMultiplier ?? 1);
        if (fireState) {
          for (let s = 0; s < mult; s++) {
            fireTickAccum += 1;
            if (fireTickAccum >= 1.5) {
              fireTickAccum -= 1.5;
              stepFire(
                fireState, patchGrid, patchKeys, PATCH_PARAMS,
                elevations,
                controls.windAngle ?? 225,
                controls.windSpeed ?? 2.5,
                depths, COLS, ROWS
              );
            }
          }
        }
        sedimentCount = 0;
        updateMetrics({ chartHistory, interventionMarkers, connectivity, sedimentCount });
        return;
      }

      // Water / flood mode: hydrology + sediment
      const mult = Math.max(1, controls.speedMultiplier ?? 1);
      let stepET = 0;
      let stepTotalOutflow = 0;
      for (let s = 0; s < mult; s++) {
        const result = stepFlow(
          { depths, patchGrid, elevations, cols: COLS, rows: ROWS },
          controls.rainfall,
          1,
          { patchParams: PATCH_PARAMS, patchKeys },
          sedimentDepth
        );
        depths = result.depths;
        fluxes = result.fluxes;
        stepET += result.totalET ?? 0;
        stepTotalOutflow += result.totalOutflow ?? 0;

        const connResult = computeConnectivity(depths, fluxes, COLS, ROWS);
        connectivity = connResult.connectivity;
        drainageContrib = connResult.drainageContrib;

        spawnParticles(depths, fluxes, patchGrid, COLS, ROWS, particles, 1, controls.sedimentMultiplier ?? 1);
        advectParticles(particles, depths, fluxes, COLS, ROWS, 1, sedimentDepth);
      }

      if (controls.useLBM) {
        if (!lbmState) lbmState = createLBMState(COLS, ROWS);
        stepLBM(lbmState, fluxes, depths, sedimentDepth, COLS, ROWS);
      }

      const rainfallVol = (controls.rainfall / 1000 / 3600) * mult * COLS * ROWS;
      const runoffRatio = rainfallVol > 0.0001 ? Math.min(1, stepTotalOutflow / rainfallVol) : 0;

      let depthSum = 0;
      for (let k = 0; k < depths.length; k++) depthSum += depths[k];
      const meanStorage = depthSum / (COLS * ROWS);

      const etFraction = rainfallVol > 0.0001 ? Math.min(1, stepET / rainfallVol) : 0;

      let concentration = 0;
      if (drainageContrib) {
        const dc = Array.from(drainageContrib).sort((a, b) => b - a);
        let cum = 0, count = 0;
        for (let k = 0; k < dc.length; k++) {
          cum += dc[k]; count++;
          if (cum >= 0.8) break;
        }
        concentration = 1 - count / (COLS * ROWS);
      }

      chartHistory.push({ runoffRatio, meanStorage, etFraction, concentration });
      if (chartHistory.length > 300) chartHistory.shift();

      for (const src of waterSources) {
        const rate = controls.waterSourceRate ?? 0.04;
        depths[src.i * COLS + src.j] += rate;
      }

      for (const m of interventionMarkers) m.framesAgo++;
      interventionMarkers = interventionMarkers.filter(m => m.framesAgo <= 300);

      sedimentCount = particles.length;

      updateMetrics({ chartHistory, interventionMarkers, connectivity, sedimentCount });
    };

    setInterval(runLoop, 100);
  };

  p.draw = () => {
    p.background(18, 18, 24);

    // ── Network zoom mode ──────────────────────────────────────────────────
    if (networkZoom) {
      drawNetworkView(p);
      return;
    }

    const viewMode = simState.controls?.viewMode ?? 'design';
    const fireSim = simState.controls?.simMode === 'fire';

    // ── Layer 1: Patches + water overlay ────────────────────────────────────
    for (let i = 0; i < ROWS; i++) {
      for (let j = 0; j < COLS; j++) {
        const idx = i * COLS + j;
        const patchIdx = patchGrid[idx];
        const params = PATCH_PARAMS[patchKeys[patchIdx]] || PATCH_PARAMS.grass;
        const [pr, pg, pb] = hexToRgb(params.color);

        if (viewMode === 'design') {
          p.fill(pr, pg, pb);
        } else if (viewMode === 'flow') {
          // Heavily desaturate so streamlines dominate
          const [dr, dg, db] = desaturate(pr, pg, pb, 0.25);
          p.fill(dr, dg, db, 180);
        } else if (viewMode === 'fuel') {
          // Fuel-risk heatmap: fuelLoad → color. Percolation threshold ≈ 0.41.
          // Below threshold: blue→green. Above: yellow→red.
          const fuel = params.fuelLoad ?? 0;
          const PC = 0.41;
          let fr, fg, fb;
          if (fuel <= 0) {
            fr = 40; fg = 100; fb = 200; // water / no fuel: deep blue
          } else if (fuel < PC) {
            const t = fuel / PC;
            fr = Math.round(30  + t * 200);   // 30→230
            fg = Math.round(120 + t * 130);   // 120→250
            fb = Math.round(200 - t * 200);   // 200→0
          } else {
            const t = (fuel - PC) / (1 - PC);
            fr = 255;
            fg = Math.round(250 - t * 250);   // 250→0
            fb = 0;
          }
          p.fill(fr, fg, fb);
        } else {
          // sediment mode: patches fade back
          const [dr, dg, db] = desaturate(pr, pg, pb, 0.5);
          p.fill(dr, dg, db, 120);
        }
        p.noStroke();
        p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);

        // Water: not shown in fire mode (hydrology is off)
        const h = depths[idx];
        if (!fireSim && h > 0.0005 && viewMode !== 'sediment') {
          const alpha = Math.min(255, 120 + Math.log1p(h * 3000) * 42);
          if (viewMode === 'design') {
            const wr = Math.round(80 * 0.7 + pr * 0.3);
            const wg = Math.round(130 * 0.7 + pg * 0.3);
            const wb = Math.round(200 * 0.7 + pb * 0.3);
            p.fill(wr, wg, wb, alpha);
          } else {
            p.fill(80, 130, 200, Math.round(alpha * 0.35));
          }
          p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
        }
      }
    }

    // ── Layer 1b: Phi cluster overlay (giant cluster = coral, others = muted) ──
    {
      const overlay = getClusterOverlay();
      if (overlay.clusterMap && viewMode === 'design') {
        p.noStroke();
        for (let i = 0; i < ROWS; i++) {
          for (let j = 0; j < COLS; j++) {
            const cid = overlay.clusterMap[i * COLS + j];
            if (cid === 0) {
              // Giant cluster: saturated coral tint
              p.fill(232, 89, 60, 55); // #E8593C at ~22% alpha
              p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
            } else if (cid > 0) {
              // Smaller clusters: muted gray
              p.fill(180, 180, 200, 30);
              p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
            }
          }
        }
      }
    }

    // ── Layer 2: Sediment deposits ───────────────────────────────────────────
    if (!fireSim && viewMode !== 'flow') {
      p.noStroke();
      for (let i = 0; i < ROWS; i++) {
        for (let j = 0; j < COLS; j++) {
          const sd = sedimentDepth[i * COLS + j];
          if (sd > 0) {
            const alpha = viewMode === 'sediment'
              ? Math.min(240, Math.log1p(sd) * 55)
              : Math.min(220, Math.log1p(sd) * 47);
            p.fill(139, 90, 43, alpha);
            p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
          }
        }
      }
    }

    // ── Layer 3: Drainage heatmap ────────────────────────────────────────────
    if (!fireSim && simState.controls?.showDrainageHeatmap && drainageContrib) {
      let maxDC = 0;
      for (let k = 0; k < drainageContrib.length; k++) {
        if (drainageContrib[k] > maxDC) maxDC = drainageContrib[k];
      }
      if (maxDC > 0) {
        p.noStroke();
        for (let i = 0; i < ROWS; i++) {
          for (let j = 0; j < COLS; j++) {
            const idx = i * COLS + j;
            const t = drainageContrib[idx] / maxDC;
            if (t > 0.02) {
              const alpha = Math.min(190, t * 220);
              p.fill(255, Math.round(200 * (1 - t)), 0, alpha);
              p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
            }
          }
        }
      }
    }

    // ── Layer 4: Streamlines (replaces per-cell arrows) ──────────────────────
    if (!fireSim && viewMode !== 'sediment') {
      drawStreamlines(p, viewMode);
    }

    // ── Layer 5: Contributing area highlight ─────────────────────────────────
    if (!fireSim && contributingArea) {
      p.noStroke();
      for (let i = 0; i < ROWS; i++) {
        for (let j = 0; j < COLS; j++) {
          if (contributingArea[i * COLS + j]) {
            p.fill(255, 230, 50, 65);
            p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
          }
        }
      }
      // Highlight the clicked cell itself
      // (the target is the brightest cell — it will be included in the mask)
    }

    // ── Layer 6: Particles or LBM density field ──────────────────────────────
    if (!fireSim && simState.controls?.useLBM && lbmState) {
      // LBM mode: render smooth density fields for water and sediment
      let maxW = 0, maxS = 0;
      for (let k = 0; k < lbmState.rhoWater.length; k++) {
        if (lbmState.rhoWater[k] > maxW) maxW = lbmState.rhoWater[k];
        if (lbmState.rhoSediment[k] > maxS) maxS = lbmState.rhoSediment[k];
      }
      p.noStroke();
      for (let i = 0; i < ROWS; i++) {
        for (let j = 0; j < COLS; j++) {
          const idx = i * COLS + j;
          if (maxW > 0) {
            const tw = lbmState.rhoWater[idx] / maxW;
            if (tw > 0.02) {
              p.fill(60, 140, 230, Math.min(200, Math.round(tw * 210)));
              p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
            }
          }
          if (maxS > 0) {
            const ts = lbmState.rhoSediment[idx] / maxS;
            if (ts > 0.02) {
              p.fill(160, 90, 30, Math.min(200, Math.round(ts * 210)));
              p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
            }
          }
        }
      }
    } else if (!fireSim && viewMode !== 'flow') {
      // Particle mode (default)
      for (const pt of particles) {
        if (pt.settled) continue;
        p.fill(pt.color[0], pt.color[1], pt.color[2], 255);
        p.noStroke();
        p.ellipse(pt.x * cellPx + cellPx / 2, pt.y * cellPx + cellPx / 2, 2, 2);
      }
    }

    // ── Layer 8: Fire visualization ──────────────────────────────────────────
    if (simState.controls?.simMode === 'fire' && fireState) {
      p.noStroke();
      const fc = p.frameCount;
      for (let i = 0; i < ROWS; i++) {
        for (let j = 0; j < COLS; j++) {
          const idx = i * COLS + j;
          const state = fireState.cell[idx];
          if (state === FIRE.BURNED) {
            p.fill(38, 26, 20, 210);
            p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
          } else if (state === FIRE.BURNING) {
            const pParams = PATCH_PARAMS[patchKeys[patchGrid[idx]]] || PATCH_PARAMS.grass;
            const burnLife = Math.max(1, pParams.burnDuration ?? 3);
            const intens = Math.min(1, (fireState.age[idx] + 0.5) / burnLife);
            const flicker = 0.6 + 0.4 * Math.sin(fc * 0.22 + idx * 0.051);
            const brightness = intens * flicker;
            // Outer orange layer
            p.fill(245, Math.floor(60 + brightness * 80), 5, Math.floor(150 + brightness * 85));
            p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
            // Inner bright core
            const cx = (j + 0.5) * cellPx;
            const cy = (i + 0.5) * cellPx;
            const r = cellPx * 0.45 * Math.max(0.15, brightness);
            p.fill(255, Math.floor(200 + brightness * 55), 40, Math.floor(brightness * 190));
            p.ellipse(cx, cy, r * 2, r * 2);
          }
        }
      }

      // Embers (age/life from fire.js — not .progress)
      p.noStroke();
      for (const e of fireState.embers) {
        const life = Math.max(1, e.life ?? 1);
        const t = Math.min(1, (e.age ?? 0) / life);
        const alpha = Math.floor((1 - t) * 230);
        p.fill(255, 140 + Math.floor(Math.sin(fc * 0.3 + e.x) * 30), 0, alpha);
        p.ellipse(e.x * cellPx, e.y * cellPx, 3.5, 3.5);
      }
    }

    // ── Layer 9: Water source markers ────────────────────────────────────────
    if (!fireSim && waterSources.length > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(p.frameCount * 0.14);
      for (const src of waterSources) {
        const cx = (src.j + 0.5) * cellPx;
        const cy = (src.i + 0.5) * cellPx;
        p.fill(100, 180, 255, Math.floor(160 + pulse * 80));
        p.noStroke();
        p.ellipse(cx, cy, cellPx * 0.7, cellPx * 0.7);
        p.noFill();
        p.stroke(100, 180, 255, Math.floor(80 + pulse * 120));
        p.strokeWeight(1.5);
        p.ellipse(cx, cy, cellPx * (1.4 + pulse * 0.6), cellPx * (1.4 + pulse * 0.6));
      }
      p.noStroke();
    }

    // ── Layer 10: Flood-area preview (shift+drag) — water mode only
    if (floodRect && !fireSim) {
      const { r0, c0, r1, c1 } = floodRect;
      const x0 = Math.min(c0, c1) * cellPx;
      const y0 = Math.min(r0, r1) * cellPx;
      const w  = (Math.abs(c1 - c0) + 1) * cellPx;
      const h  = (Math.abs(r1 - r0) + 1) * cellPx;
      p.fill(80, 160, 255, 55);
      p.stroke(100, 200, 255, 200);
      p.strokeWeight(1.5);
      p.rect(x0, y0, w, h);
      p.noStroke();
    }

    // ── Layer 7: Elevation contours ──────────────────────────────────────────
    if (simState.controls?.showElevationLines && elevations) {
      drawElevationContours(p);
    }

    // ── Brush cursor ─────────────────────────────────────────────────────────
    const brushRadius = (simState.controls?.brushSize ?? 3) * cellPx;
    if (p.mouseX >= 0 && p.mouseX < canvasW && p.mouseY >= 0 && p.mouseY < canvasH) {
      p.noFill();
      p.stroke(255, 255, 255, 120);
      p.strokeWeight(1);
      p.ellipse(p.mouseX, p.mouseY, brushRadius * 2, brushRadius * 2);
    }

    // ── Wind compass (fire mode only) ────────────────────────────────────────
    if (fireSim) {
      const wAngle = simState.controls?.windAngle ?? 225;
      const wSpeed = simState.controls?.windSpeed ?? 2.5;
      const cx = canvasW - 36, cy = canvasH - 36, cr = 22;
      // Background circle
      p.noStroke();
      p.fill(20, 20, 28, 180);
      p.ellipse(cx, cy, cr * 2 + 8, cr * 2 + 8);
      p.stroke(80, 80, 90);
      p.strokeWeight(1);
      p.noFill();
      p.ellipse(cx, cy, cr * 2, cr * 2);
      // Wind arrow: points in the direction wind is blowing TOWARD
      const rad2 = (wAngle * Math.PI) / 180;
      const wx2 = Math.sin(rad2), wy2 = -Math.cos(rad2);
      const len = cr * 0.72 * Math.min(1, wSpeed / 3.5 + 0.25);
      p.stroke(255, 160, 60, 200);
      p.strokeWeight(2);
      p.line(cx - wx2 * len * 0.55, cy - wy2 * len * 0.55, cx + wx2 * len, cy + wy2 * len);
      // Arrowhead
      const tipX = cx + wx2 * len, tipY = cy + wy2 * len;
      const px3 = -wy2, py3 = wx2;
      const al = 6, aw = 3.5;
      p.fill(255, 160, 60, 200);
      p.noStroke();
      p.triangle(
        tipX, tipY,
        tipX - wx2 * al + px3 * aw, tipY - wy2 * al + py3 * aw,
        tipX - wx2 * al - px3 * aw, tipY - wy2 * al - py3 * aw
      );
      // Speed label
      p.fill(200, 200, 200, 180);
      p.noStroke();
      p.textSize(9);
      p.textAlign(p.CENTER, p.CENTER);
      p.text(`${wSpeed.toFixed(1)}`, cx, cy + cr + 9);
    }

    // ── Help text ─────────────────────────────────────────────────────────────
    p.fill(140, 140, 140);
    p.textSize(Math.max(9, cellPx * 0.55));
    p.textAlign(p.LEFT, p.BOTTOM);
    p.noStroke();
    const toolHints = {
      paint: 'Left: paint \u00B7 Right: upstream \u00B7 Shift+drag: flood area',
      ignite: 'Click/drag to ignite \u00B7 Run to spread \u00B7 Paint: edit land cover',
      'water-source': 'Click to toggle water source \u00B7 Right: upstream',
    };
    const hint = toolHints[simState.controls?.activeTool ?? 'paint'] ?? '';
    p.text(hint, 8, canvasH - 8);
  };

  // ── Streamlines: seed-and-trace through flux field ────────────────────────
  function drawStreamlines(p, viewMode) {
    if (!fluxes) return;

    // Seeds: grid every 12 cells — gives ~25 starting points
    const seeds = [];
    for (let i = 6; i < ROWS; i += 12) {
      for (let j = 6; j < COLS; j += 12) {
        seeds.push([i + 0.5, j + 0.5]);
      }
    }

    const isFlow = viewMode === 'flow';
    // Animated dash parameters: phase shifts each frame so dashes appear to move downstream
    const dashLen = 8;
    const gapLen = 6;
    const period = dashLen + gapLen;
    const frameOffset = Math.floor(p.frameCount * 0.3) % period;

    p.noFill();

    for (const [sy, sx] of seeds) {
      let x = sx;
      let y = sy;
      const maxSteps = 350;
      const stepSize = 0.4;

      // Collect segments with per-point discharge for width encoding
      const pts = [{ x, y, discharge: 0 }];

      for (let step = 0; step < maxSteps; step++) {
        const j = Math.floor(x);
        const i = Math.floor(y);
        if (i < 0 || i >= ROWS || j < 0 || j >= COLS) break;

        const idx = i * COLS + j;
        const vx = fluxes[idx * 2];
        const vy = fluxes[idx * 2 + 1];
        const v = Math.sqrt(vx * vx + vy * vy);
        if (v < 0.0006) break;

        const h = depths ? depths[idx] : 0;
        pts[pts.length - 1].discharge = v * h;

        x += (vx / v) * stepSize;
        y += (vy / v) * stepSize;
        pts.push({ x, y, discharge: 0 });
      }

      if (pts.length < 2) continue;

      // Draw each segment as an animated dash — phase advances each frame so
      // dashes appear to travel downstream, making direction immediately readable
      for (let k = 1; k < pts.length; k++) {
        const prev = pts[k - 1];
        const curr = pts[k];
        const d = prev.discharge;
        // Log scale so thin=diffuse sheet, thick=concentrated channel
        const w = Math.min(7, 0.5 + Math.log1p(d * 25000) * 1.8);
        const alpha = isFlow ? Math.min(220, 80 + w * 20) : Math.min(90, 30 + w * 10);

        const phase = (k + frameOffset) % period;
        if (phase < dashLen) {
          p.stroke(100, 180, 255, alpha);
          p.strokeWeight(w);
          p.line(prev.x * cellPx, prev.y * cellPx, curr.x * cellPx, curr.y * cellPx);
        }
      }

      // Chevron arrowheads every 50 steps and at the streamline end
      const arrowInterval = 50;
      const arrowPositions = [];
      for (let k = arrowInterval; k < pts.length - 1; k += arrowInterval) arrowPositions.push(k);
      if (pts.length >= 3) arrowPositions.push(pts.length - 1);

      for (const k of arrowPositions) {
        if (k < 2) continue;
        const tip = pts[k];
        const ref = pts[k - 2]; // 2 steps back for a stable direction vector
        const d = pts[k - 1].discharge;
        const w = Math.min(5, 0.8 + Math.log1p(d * 25000) * 1.2);
        const alpha = isFlow ? 200 : 90;

        const dx = tip.x - ref.x;
        const dy = tip.y - ref.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = dx / len;
        const ny = dy / len;
        const px2 = -ny; // perpendicular
        const py2 = nx;

        const aLen = Math.max(5, w * 3);   // arrowhead length in px
        const aWid = Math.max(3, w * 1.5); // arrowhead half-width in px

        const tipX = tip.x * cellPx;
        const tipY = tip.y * cellPx;
        const bx = tipX - nx * aLen;
        const by = tipY - ny * aLen;

        p.stroke(160, 210, 255, alpha);
        p.strokeWeight(Math.max(0.8, w * 0.55));
        p.line(bx + px2 * aWid, by + py2 * aWid, tipX, tipY);
        p.line(bx - px2 * aWid, by - py2 * aWid, tipX, tipY);
      }
    }
  }

  function drawElevationContours(p) {
    if (!elevations) return;
    let minE = Infinity, maxE = -Infinity;
    for (let k = 0; k < elevations.length; k++) {
      const v = elevations[k];
      if (v < minE) minE = v;
      if (v > maxE) maxE = v;
    }
    const range = maxE - minE || 1;
    const numContours = 10;
    p.stroke(255, 255, 200, 100);
    p.strokeWeight(1);
    p.noFill();
    for (let c = 1; c < numContours; c++) {
      const level = minE + (range * c) / numContours;
      for (let i = 0; i < ROWS - 1; i++) {
        for (let j = 0; j < COLS - 1; j++) {
          const e00 = elevations[i * COLS + j];
          const e10 = elevations[(i + 1) * COLS + j];
          const e01 = elevations[i * COLS + (j + 1)];
          const e11 = elevations[(i + 1) * COLS + (j + 1)];
          const pts = [];
          if (e00 !== e10 && (e00 - level) * (e10 - level) <= 0) {
            const t = (level - e00) / (e10 - e00);
            pts.push([j * cellPx + cellPx / 2, (i + t) * cellPx]);
          }
          if (e00 !== e01 && (e00 - level) * (e01 - level) <= 0) {
            const t = (level - e00) / (e01 - e00);
            pts.push([(j + t) * cellPx, i * cellPx + cellPx / 2]);
          }
          if (e01 !== e11 && (e01 - level) * (e11 - level) <= 0) {
            const t = (level - e01) / (e11 - e01);
            pts.push([(j + 1) * cellPx, (i + t) * cellPx]);
          }
          if (e10 !== e11 && (e10 - level) * (e11 - level) <= 0) {
            const t = (level - e10) / (e11 - e10);
            pts.push([(j + t) * cellPx, (i + 1) * cellPx]);
          }
          if (pts.length >= 2) {
            p.line(pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
          }
        }
      }
    }
  }

  // ── Cell selection overlay ──
  drawSelectionOverlay(p);

  // ── Selection drag preview ──
  if (_selDragStart) {
    const j = Math.floor(p.mouseX / cellPx);
    const i = Math.floor(p.mouseY / cellPx);
    const r0 = Math.min(_selDragStart.r, i), r1 = Math.max(_selDragStart.r, i);
    const c0 = Math.min(_selDragStart.c, j), c1 = Math.max(_selDragStart.c, j);
    p.noFill();
    p.stroke(240, 100, 60, 120);
    p.strokeWeight(1);
    p.rect(c0 * cellPx, r0 * cellPx, (c1 - c0 + 1) * cellPx, (r1 - r0 + 1) * cellPx);
    p.noStroke();
  }

  p.doubleClicked = () => {
    if (p.mouseX < 0 || p.mouseX >= canvasW || p.mouseY < 0 || p.mouseY >= canvasH) return;
    if (networkZoom) return;
    const j = Math.floor(p.mouseX / cellPx);
    const i = Math.floor(p.mouseY / cellPx);
    if (i >= 0 && i < ROWS && j >= 0 && j < COLS) {
      // If cells are selected, zoom with those; otherwise select the double-clicked cell
      if (selectedCells.length === 0) toggleCellSelection(i, j, false);
      networkZoom = { centerR: i, centerC: j };
    }
  };

  p.keyPressed = () => {
    if (p.key === 'Escape' || p.key === 'Backspace') {
      if (networkZoom) { networkZoom = null; }
      else if (selectedCells.length > 0) { clearSelection(); }
    }
    if (!networkZoom) return;
    if (p.keyCode === p.LEFT_ARROW) {
      networkMinEdgeWeight = Math.max(0, networkMinEdgeWeight - 0.02);
    } else if (p.keyCode === p.RIGHT_ARROW) {
      networkMinEdgeWeight = Math.min(1, networkMinEdgeWeight + 0.02);
    }
  };

  p.mousePressed = () => {
    if (p.mouseX < 0 || p.mouseX >= canvasW || p.mouseY < 0 || p.mouseY >= canvasH) return;
    // "Back to mosaic" button in network mode
    if (networkZoom && p.mouseX < 128 && p.mouseY < 34) {
      networkZoom = null;
      return;
    }
    if (networkZoom) return; // no painting in network view
    if (p.mouseButton === p.RIGHT) {
      const j = Math.floor(p.mouseX / cellPx);
      const i = Math.floor(p.mouseY / cellPx);
      if (contributingArea) { contributingArea = null; }
      else { contributingArea = computeContributingArea(i, j); }
      return false;
    }

    const j = Math.floor(p.mouseX / cellPx);
    const i = Math.floor(p.mouseY / cellPx);
    if (i < 0 || i >= ROWS || j < 0 || j >= COLS) return;

    // Alt+click: cell selection
    if (p.keyIsDown(p.ALT)) {
      toggleCellSelection(i, j, p.keyIsDown(p.SHIFT));
      return;
    }
    // Alt+drag: rectangle selection
    // (handled in mouseDragged via _selDragStart)

    const activeTool = simState.controls?.activeTool ?? 'paint';
    if (activeTool === 'ignite') {
      if (fireState) igniteAt(fireState, i, j, COLS, ROWS, patchGrid, patchKeys, PATCH_PARAMS);
    } else if (activeTool === 'water-source') {
      const existing = waterSources.findIndex(s => s.i === i && s.j === j);
      if (existing >= 0) { waterSources.splice(existing, 1); }
      else { waterSources.push({ i, j }); }
    } else if (
      activeTool === 'paint' &&
      p.keyIsDown(p.SHIFT) &&
      simState.controls?.simMode !== 'fire'
    ) {
      floodRect = { r0: i, c0: j, r1: i, c1: j };
    } else {
      // Normal click on empty space clears selection
      if (selectedCells.length > 0) { clearSelection(); }
      paintAt(p.mouseX, p.mouseY);
    }
  };

  p.mouseDragged = () => {
    if (p.mouseX < 0 || p.mouseX >= canvasW || p.mouseY < 0 || p.mouseY >= canvasH) return;
    if (networkZoom) return;
    if (p.mouseButton === p.RIGHT) return;

    const j = Math.floor(p.mouseX / cellPx);
    const i = Math.floor(p.mouseY / cellPx);

    // Alt+drag: rectangle cell selection
    if (p.keyIsDown(p.ALT)) {
      if (!_selDragStart) {
        _selDragStart = { r: i, c: j };
      }
      return;
    }

    const activeTool = simState.controls?.activeTool ?? 'paint';
    if (activeTool === 'ignite') {
      if (fireState) igniteAt(fireState, i, j, COLS, ROWS, patchGrid, patchKeys, PATCH_PARAMS);
    } else if (floodRect) {
      floodRect.r1 = i;
      floodRect.c1 = j;
    } else {
      paintAt(p.mouseX, p.mouseY);
    }
  };

  p.mouseReleased = () => {
    // Complete rectangle cell selection
    if (_selDragStart) {
      const j = Math.floor(p.mouseX / cellPx);
      const i = Math.floor(p.mouseY / cellPx);
      selectCellRect(_selDragStart.r, _selDragStart.c, i, j);
      _selDragStart = null;
      return;
    }
    if (floodRect && simState.controls?.simMode !== 'fire') {
      const rMin = Math.min(floodRect.r0, floodRect.r1);
      const rMax = Math.max(floodRect.r0, floodRect.r1);
      const cMin = Math.min(floodRect.c0, floodRect.c1);
      const cMax = Math.max(floodRect.c0, floodRect.c1);
      for (let ri = rMin; ri <= rMax; ri++) {
        for (let ci = cMin; ci <= cMax; ci++) {
          if (ri >= 0 && ri < ROWS && ci >= 0 && ci < COLS) {
            depths[ri * COLS + ci] += 0.5;
          }
        }
      }
      floodRect = null;
    }
  };
};

function paintAt(x, y) {
  const j = Math.floor(x / cellPx);
  const i = Math.floor(y / cellPx);
  const radius = simState.controls?.brushSize ?? 3;
  const ctrl = simState.controls;

  if (i >= 0 && i < ROWS && j >= 0 && j < COLS) {
    const key = ctrl?.activePatch ?? PATCH_TYPES.GRASS;
    const idx = Object.keys(PATCH_PARAMS).indexOf(key);
    if (idx >= 0) {
      for (let di = -radius; di <= radius; di++) {
        for (let dj = -radius; dj <= radius; dj++) {
          const ni = i + di;
          const nj = j + dj;
          if (ni >= 0 && ni < ROWS && nj >= 0 && nj < COLS) {
            if (Math.sqrt(di * di + dj * dj) <= radius) {
              patchGrid[ni * COLS + nj] = idx;
            }
          }
        }
      }

      // Refresh phi panel when landscape changes
      setPhiGrid(patchGrid, COLS, ROWS);

      // Record intervention marker when simulation is running.
      // Debounce: only one marker per 3-frame window per patch type.
      if (ctrl?.running) {
        const recentSame = interventionMarkers.some(m => m.framesAgo < 3 && m.patchKey === key);
        if (!recentSame) {
          interventionMarkers.push({ framesAgo: 0, patchKey: key });
        }
      }
    }
  }
}

// ── Parcel Analysis integration ───────────────────────────────────────────────

function _loadParcelGrid(grid) {
  if (!(grid instanceof Uint8Array) || grid.length !== COLS * ROWS) return;
  patchGrid.set(grid);
  depths.fill(0);
  sedimentDepth.fill(0);
  particles.length = 0;
  chartHistory = [];
  drainageContrib = null;
  contributingArea = null;
  interventionMarkers = [];
  lbmState = null;
  sedimentCount = 0;
  updateElevations();
  setPhiGrid(patchGrid, COLS, ROWS);
}

function _renderSimToCanvas(canvas) {
  if (!patchGrid || !depths) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const cw = W / COLS;
  const ch = H / ROWS;
  ctx.clearRect(0, 0, W, H);

  for (let i = 0; i < ROWS; i++) {
    for (let j = 0; j < COLS; j++) {
      const idx = i * COLS + j;
      const params = PATCH_PARAMS[patchKeys[patchGrid[idx]]] || PATCH_PARAMS.grass;

      ctx.globalAlpha = 0.78;
      ctx.fillStyle = params.color;
      ctx.fillRect(j * cw, i * ch, cw + 0.5, ch + 0.5);

      const h = depths[idx];
      if (h > 0.0005) {
        ctx.globalAlpha = Math.min(0.88, 0.38 + Math.log1p(h * 3000) * 0.17);
        ctx.fillStyle = '#4e7ec4';
        ctx.fillRect(j * cw, i * ch, cw + 0.5, ch + 0.5);
      }

      const sd = sedimentDepth[idx];
      if (sd > 0.2) {
        ctx.globalAlpha = Math.min(0.7, Math.log1p(sd) * 0.22);
        ctx.fillStyle = '#8b5a2b';
        ctx.fillRect(j * cw, i * ch, cw + 0.5, ch + 0.5);
      }
    }
  }
  ctx.globalAlpha = 1;
}

// Publish to simState (importable) AND window (backward compat for standalone)
simState.loadParcelGrid = _loadParcelGrid;
simState.renderSimToCanvas = _renderSimToCanvas;
window.loadParcelGrid = _loadParcelGrid;
window.renderSimToCanvas = _renderSimToCanvas;

// ── Cell selection helpers ────────────────────────────────────────────────────

function toggleCellSelection(r, c, additive) {
  if (!additive) selectedCells = [];
  const idx = selectedCells.findIndex(s => s.r === r && s.c === c);
  if (idx >= 0) { selectedCells.splice(idx, 1); }
  else if (selectedCells.length < 16) { selectedCells.push({ r, c }); }
  onSelectionChanged();
}

function selectCellRect(r0, c0, r1, c1) {
  selectedCells = [];
  const rMin = Math.max(0, Math.min(r0, r1));
  const rMax = Math.min(ROWS - 1, Math.max(r0, r1));
  const cMin = Math.max(0, Math.min(c0, c1));
  const cMax = Math.min(COLS - 1, Math.max(c0, c1));
  for (let r = rMin; r <= rMax && selectedCells.length < 16; r++)
    for (let c = cMin; c <= cMax && selectedCells.length < 16; c++)
      selectedCells.push({ r, c });
  onSelectionChanged();
}

function clearSelection() {
  selectedCells = [];
  _siteFeatureResult = null;
  _siteFeatureNodes = null;
  _siteFetching = false;
  _siteFetchError = false;
}

function getSelectedBounds() {
  if (selectedCells.length === 0 || !simState.parcelBounds) return null;
  const pb = simState.parcelBounds;
  const latStep = (pb.north - pb.south) / ROWS;
  const lonStep = (pb.east - pb.west) / COLS;
  let rMin = ROWS, rMax = 0, cMin = COLS, cMax = 0;
  for (const { r, c } of selectedCells) {
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (c < cMin) cMin = c; if (c > cMax) cMax = c;
  }
  return {
    south: pb.south + rMin * latStep,
    north: pb.south + (rMax + 1) * latStep,
    west: pb.west + cMin * lonStep,
    east: pb.west + (cMax + 1) * lonStep,
  };
}

function onSelectionChanged() {
  const bounds = getSelectedBounds();
  if (!bounds) { _siteFeatureResult = null; return; }
  const key = `${bounds.south.toFixed(6)},${bounds.west.toFixed(6)},${bounds.north.toFixed(6)},${bounds.east.toFixed(6)}`;
  if (key === _lastFetchKey && _siteFeatureResult) return; // already fetched
  _lastFetchKey = key;
  triggerFetch(bounds);
}

async function triggerFetch(bounds) {
  _siteFetching = true;
  _siteFetchError = false;

  const timeout = setTimeout(() => { if (_siteFetching) _siteFetchError = true; }, 8000);

  try {
    const wAngle = simState.controls?.windAngle ?? 225;
    const wSpeed = simState.controls?.windSpeed ?? 2.5;
    _lastWindAngle = wAngle;
    _lastWindSpeed = wSpeed;

    const result = await fetchSiteFeatures({
      bounds, patchGrid, patchKeys, elevations, cols: COLS, rows: ROWS,
      windAngle: wAngle, windSpeed: wSpeed,
    });
    _siteFeatureResult = result;
    _siteFeatureNodes = result.nodes;
  } catch {
    _siteFetchError = true;
    _siteFeatureResult = null;
  } finally {
    clearTimeout(timeout);
    _siteFetching = false;
  }
}

function maybeRebuildEdges() {
  if (!_siteFeatureNodes || !_siteFeatureResult) return;
  const wAngle = simState.controls?.windAngle ?? 225;
  const wSpeed = simState.controls?.windSpeed ?? 2.5;
  if (wAngle === _lastWindAngle && wSpeed === _lastWindSpeed) return;
  _lastWindAngle = wAngle;
  _lastWindSpeed = wSpeed;
  const bounds = getSelectedBounds();
  if (!bounds) return;
  const { edges, phiLocal, giantSize } = rebuildGraph(_siteFeatureNodes, {
    windAngle: wAngle, windSpeed: wSpeed, elevations, bounds, cols: COLS, rows: ROWS,
  });
  _siteFeatureResult = { ..._siteFeatureResult, edges, phiLocal, giantSize };
}

// ── Selection overlay on mosaic ──────────────────────────────────────────────

function drawSelectionOverlay(p) {
  if (selectedCells.length === 0) return;
  p.noFill();
  p.stroke(240, 100, 60);
  p.strokeWeight(2);
  for (const { r, c } of selectedCells) {
    p.rect(c * cellPx, r * cellPx, cellPx, cellPx);
  }
  p.noStroke();

  // Label
  p.fill(40, 40, 55, 200);
  p.noStroke();
  p.rect(canvasW - 220, canvasH - 28, 210, 22, 4);
  p.fill(200, 200, 220);
  p.textSize(10);
  p.textAlign(p.RIGHT, p.CENTER);
  p.text(`${selectedCells.length} cell${selectedCells.length > 1 ? 's' : ''} selected \u2014 double-click to zoom`, canvasW - 16, canvasH - 17);
}

// ── Network zoom view (site-features-aware) ──────────────────────────────────

const DIRS8 = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

function drawNetworkView(p) {
  // Rebuild edges if wind changed
  maybeRebuildEdges();

  const sr = _siteFeatureResult;

  // If we have site features with real nodes, draw that graph
  if (sr && sr.nodes && sr.nodes.length > 0) {
    drawSiteFeatureGraph(p, sr);
  } else if (_siteFetching) {
    // Loading state
    p.fill(200, 200, 220);
    p.textSize(13);
    p.textAlign(p.CENTER, p.CENTER);
    p.text('Fetching trees and buildings...', canvasW / 2, canvasH / 2);
  } else if (_siteFetchError) {
    p.fill(180, 160, 160);
    p.textSize(12);
    p.textAlign(p.CENTER, p.CENTER);
    p.text('Could not fetch feature data for this area.', canvasW / 2, canvasH / 2 - 16);
    p.textSize(10);
    p.fill(140, 140, 150);
    p.text('OSM coverage may be sparse here. Showing synthetic graph.', canvasW / 2, canvasH / 2 + 4);
    // Fall through to synthetic graph
    drawSyntheticNetworkView(p);
  } else if (!simState.parcelBounds) {
    // No parcel drawn — use synthetic graph
    drawSyntheticNetworkView(p);
  } else {
    drawSyntheticNetworkView(p);
  }

  // "Back to mosaic" button (always visible)
  p.fill(40, 40, 55, 200);
  p.noStroke();
  p.rect(8, 8, 120, 26, 5);
  p.fill(200, 200, 220);
  p.textSize(11);
  p.textAlign(p.LEFT, p.CENTER);
  p.text('\u2190 back to mosaic', 16, 21);

  // Min edge weight (bottom-right)
  p.fill(120, 120, 140);
  p.textSize(9);
  p.textAlign(p.RIGHT, p.BOTTOM);
  p.text(`min edge: ${networkMinEdgeWeight.toFixed(2)}  [\u2190/\u2192]`, canvasW - 10, canvasH - 10);
}

function drawSiteFeatureGraph(p, sr) {
  const { nodes, edges, phiLocal } = sr;
  const bounds = getSelectedBounds();
  if (!bounds) return;

  const padX = 50, padY = 50;
  const plotW = canvasW - 2 * padX;
  const plotH = canvasH - 2 * padY;
  const latRange = bounds.north - bounds.south || 1e-6;
  const lonRange = bounds.east - bounds.west || 1e-6;

  // Map lat/lon to canvas
  function toScreen(lat, lon) {
    return {
      x: padX + ((lon - bounds.west) / lonRange) * plotW,
      y: padY + ((bounds.north - lat) / latRange) * plotH,
    };
  }

  // Draw edges
  for (const e of edges) {
    if (e.weight < networkMinEdgeWeight) continue;
    const a = toScreen(nodes[e.i].lat, nodes[e.i].lon);
    const b = toScreen(nodes[e.j].lat, nodes[e.j].lon);
    const alpha = Math.min(200, 40 + e.weight * 180);
    const w = 0.5 + e.weight * 3;
    p.stroke(180, 200, 230, alpha);
    p.strokeWeight(w);
    p.line(a.x, a.y, b.x, b.y);
  }

  // Draw nodes
  p.noStroke();
  for (const n of nodes) {
    const s = toScreen(n.lat, n.lon);
    if (n.type === 'tree') {
      const r = (n.crownRadius || 3) * 1.5;
      p.fill(110, 190, 110);
      p.ellipse(s.x, s.y, r * 2, r * 2);
      p.noFill();
      p.stroke(0, 0, 0, 40);
      p.strokeWeight(0.5);
      p.ellipse(s.x, s.y, r * 2, r * 2);
      p.noStroke();
    } else {
      // Building: rounded square, border = vulnerability
      const sz = 8;
      const vuln = n.vulnerability || 0.3;
      p.fill(200, 160, 120);
      p.rect(s.x - sz / 2, s.y - sz / 2, sz, sz, 2);
      p.noFill();
      p.stroke(240, 100, 60, 60 + vuln * 180);
      p.strokeWeight(0.5 + vuln * 2.5);
      p.rect(s.x - sz / 2, s.y - sz / 2, sz, sz, 2);
      p.noStroke();
    }
  }

  // Wind arrow (top-right)
  const wAngle = simState.controls?.windAngle ?? 225;
  const cx = canvasW - 30, cy = 45;
  const rad = (wAngle * Math.PI) / 180;
  const arrowLen = 16;
  const ax = cx + Math.sin(rad) * arrowLen, ay = cy - Math.cos(rad) * arrowLen;
  p.stroke(200, 180, 130, 180);
  p.strokeWeight(2);
  p.line(cx, cy, ax, ay);
  p.noStroke();
  p.fill(200, 180, 130);
  p.ellipse(ax, ay, 5, 5);
  p.fill(140, 140, 150);
  p.textSize(8);
  p.textAlign(p.CENTER, p.TOP);
  p.text('wind', cx, cy + 20);

  // Local φ (top-left, below back button)
  p.textAlign(p.LEFT, p.TOP);
  p.textSize(11);
  const phiColor = phiLocal > SITE_PHI_STAR ? [240, 130, 70] : [120, 180, 220];
  p.fill(...phiColor);
  p.text(`\u03C6 = ${phiLocal.toFixed(2)}`, 14, 44);
  if (phiLocal > SITE_PHI_STAR) {
    p.textSize(9);
    p.fill(240, 130, 70);
    p.text('\u2014 supercritical', 14, 58);
  }

  // Status badge
  p.textSize(8);
  p.fill(100, 100, 110);
  const statusLabel = sr.status === 'real' ? `${nodes.length} features (OSM)` :
    sr.status === 'synthetic' ? `${nodes.length} features (OSM + synthetic)` :
    `${nodes.length} features (synthetic)`;
  p.text(statusLabel, 14, 72);

  // Legend (bottom-left)
  p.textAlign(p.LEFT, p.TOP);
  p.textSize(9);
  let ly = canvasH - 60;
  p.fill(110, 190, 110);
  p.ellipse(18, ly + 5, 8, 8);
  p.fill(180, 180, 190);
  p.noStroke();
  p.text('tree', 28, ly);
  ly += 14;
  p.fill(200, 160, 120);
  p.rect(14, ly + 1, 8, 8, 2);
  p.fill(180, 180, 190);
  p.text('building', 28, ly);
}

/** Fallback: draw the old synthetic cell-based network when no parcel bounds exist. */
function drawSyntheticNetworkView(p) {
  const { centerR, centerC } = networkZoom;
  const rMin = Math.max(0, centerR - NETWORK_RADIUS);
  const rMax = Math.min(ROWS - 1, centerR + NETWORK_RADIUS);
  const cMin = Math.max(0, centerC - NETWORK_RADIUS);
  const cMax = Math.min(COLS - 1, centerC + NETWORK_RADIUS);
  const nCols = cMax - cMin + 1;
  const nRows = rMax - rMin + 1;

  const padX = 40, padY = 40;
  const spacingX = (canvasW - 2 * padX) / Math.max(1, nCols - 1);
  const spacingY = (canvasH - 2 * padY) / Math.max(1, nRows - 1);

  const NODE_COLORS = {
    burning: '#F0997B', atRisk: '#FAC775', safe: '#C0DD97', barrier: '#D3D1C7',
  };

  const nodes = [];
  const nodeIdx = new Map();
  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      const idx = r * COLS + c;
      const key = patchKeys[patchGrid[idx]];
      const params = PATCH_PARAMS[key];
      const fuel = params.fuelLoad ?? 0;
      let nodeState = 'barrier';
      if (fuel > 0) {
        if (fireState && fireState.cell[idx] === FIRE.BURNING) nodeState = 'burning';
        else if (fireState && fireState.cell[idx] === FIRE.BURNED) nodeState = 'barrier';
        else {
          let adj = false;
          if (fireState) {
            for (const [dr, dc] of DIRS8) {
              const nr = r + dr, nc = c + dc;
              if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && fireState.cell[nr * COLS + nc] === FIRE.BURNING) { adj = true; break; }
            }
          }
          nodeState = adj ? 'atRisk' : 'safe';
        }
      }
      const x = padX + (c - cMin) * spacingX;
      const y = padY + (r - rMin) * spacingY;
      nodeIdx.set(`${r},${c}`, nodes.length);
      nodes.push({ r, c, x, y, state: nodeState, fuel });
    }
  }

  // Edges
  for (let ni = 0; ni < nodes.length; ni++) {
    const a = nodes[ni];
    if (a.fuel <= 0) continue;
    for (const [dr, dc] of DIRS8) {
      const nj = nodeIdx.get(`${a.r + dr},${a.c + dc}`);
      if (nj === undefined || nj <= ni) continue;
      const b = nodes[nj];
      if (b.fuel <= 0) continue;
      // Simplified spread probability
      const fuel2 = PATCH_PARAMS[patchKeys[patchGrid[b.r * COLS + b.c]]]?.fuelLoad ?? 0;
      const prob = Math.min(1, fuel2 * 1.5);
      if (prob < networkMinEdgeWeight) continue;
      p.stroke(180, 200, 230, 40 + prob * 160);
      p.strokeWeight(0.5 + prob * 4);
      p.line(a.x, a.y, b.x, b.y);
    }
  }

  // Nodes
  p.noStroke();
  for (const n of nodes) {
    const radius = Math.max(4, 4 + n.fuel * 20);
    p.fill(NODE_COLORS[n.state] || NODE_COLORS.barrier);
    p.ellipse(n.x, n.y, radius * 2, radius * 2);
    p.noFill(); p.stroke(0, 0, 0, 60); p.strokeWeight(0.5);
    p.ellipse(n.x, n.y, radius * 2, radius * 2); p.noStroke();
  }

  // Legend
  p.textAlign(p.LEFT, p.TOP);
  p.textSize(9);
  let ly = 44;
  for (const [label, color] of [['burning','#F0997B'],['at-risk','#FAC775'],['safe','#C0DD97'],['barrier','#D3D1C7']]) {
    p.fill(color);
    p.ellipse(18, ly + 5, 8, 8);
    p.fill(180, 180, 190);
    p.noStroke();
    p.text(label, 28, ly);
    ly += 14;
  }
}

new p5(sketch);
