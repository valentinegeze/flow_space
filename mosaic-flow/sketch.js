/**
 * Main sketch: land mosaic grid, physics loop, visualization.
 */

import { stepFlow, getElevation } from './flow.js';
import { PATCH_TYPES, PATCH_PARAMS, DEFAULT_MATRIX } from './patches.js';
import { createUI } from './ui.js';
import { computeConnectivity } from './connectivity.js';
import { spawnParticles, advectParticles } from './particles.js';

const COLS = 64;
const ROWS = 64;

let patchGrid;
let depths;
let elevations;
let fluxes;
let sedimentDepth;
let particles = [];
let peakFlow = 0;
let sedimentCount = 0;
let connectivity = 0;
let cellPx = 8;
let canvasW = 0;
let canvasH = 0;

const patchKeys = Object.keys(PATCH_PARAMS);

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
  const ctrl = window.mosaicControls;
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
}

const sketch = (p) => {
  p.setup = () => {
    resizeCanvas(p);
    const canvas = p.createCanvas(canvasW, canvasH);
    canvas.parent('mosaic-container');

    p.windowResized = () => {
      resizeCanvas(p);
      p.resizeCanvas(canvasW, canvasH);
    };

    initGrid();

    const { controls, updateMetrics } = createUI((msg, data) => {
      if (msg === 'reset') {
        depths.fill(0);
        sedimentDepth.fill(0);
        particles.length = 0;
        peakFlow = 0;
        sedimentCount = 0;
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
        const ctrl = window.mosaicControls;
        const payload = {
          version: 1,
          cols: COLS,
          rows: ROWS,
          patchGrid: Array.from(patchGrid),
          elevationMode: ctrl?.elevationMode ?? 'slope',
          slopeAngle: ctrl?.slopeAngle ?? 270,
          slopeMagnitude: ctrl?.slopeMagnitude ?? 0.01,
          elevations: ctrl?.elevationMode === 'dem' && ctrl?.demElevations
            ? Array.from(ctrl.demElevations)
            : undefined,
          exportedAt: new Date().toISOString(),
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `mosaic-scenario-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      } else if (msg === 'import' && data) {
        const grid = data.patchGrid;
        if (Array.isArray(grid) && grid.length === COLS * ROWS) {
          for (let i = 0; i < grid.length; i++) {
            const v = Math.floor(grid[i]);
            patchGrid[i] = Math.max(0, Math.min(v, patchKeys.length - 1));
          }
        }
        const ctrl = window.mosaicControls;
        if (ctrl) {
          ctrl.elevationMode = data.elevationMode ?? 'slope';
          ctrl.slopeAngle = data.slopeAngle ?? 270;
          ctrl.slopeMagnitude = data.slopeMagnitude ?? 0.01;
          if (data.elevationMode === 'dem' && Array.isArray(data.elevations) && data.elevations.length === COLS * ROWS) {
            ctrl.demElevations = new Float32Array(data.elevations);
            const nameEl = document.getElementById('dem-file-name');
            if (nameEl) nameEl.textContent = '(from import)';
          } else {
            ctrl.demElevations = null;
          }
          const slopeRadio = document.querySelector('input[name="topo-mode"][value="slope"]');
          const demRadio = document.querySelector('input[name="topo-mode"][value="dem"]');
          const topoSlopeDivEl = document.getElementById('topo-slope-div');
          const topoDemDivEl = document.getElementById('topo-dem-div');
          if (slopeRadio && demRadio) {
            slopeRadio.checked = ctrl.elevationMode === 'slope';
            demRadio.checked = ctrl.elevationMode === 'dem';
          }
          if (topoSlopeDivEl) topoSlopeDivEl.style.display = ctrl.elevationMode === 'slope' ? 'block' : 'none';
          if (topoDemDivEl) topoDemDivEl.style.display = ctrl.elevationMode === 'dem' ? 'block' : 'none';
        }
        if (Array.isArray(grid) && grid.length !== COLS * ROWS) {
          console.warn('Import: invalid grid dimensions');
        }
        updateElevations();
      } else {
        updateElevations();
      }
    });

    window.mosaicControls = controls;

    const runLoop = () => {
      if (controls.running) {
        const mult = Math.max(1, controls.speedMultiplier ?? 1);
        for (let s = 0; s < mult; s++) {
          const result = stepFlow(
            { depths, patchGrid, elevations, cols: COLS, rows: ROWS },
            controls.rainfall,
            1,
            { patchParams: PATCH_PARAMS, patchKeys }
          );
          depths = result.depths;
          fluxes = result.fluxes;

          connectivity = computeConnectivity(depths, fluxes, patchGrid, COLS, ROWS);
          spawnParticles(depths, fluxes, patchGrid, COLS, ROWS, particles, 1, controls.sedimentMultiplier ?? 1);
          advectParticles(particles, depths, fluxes, COLS, ROWS, 1, sedimentDepth);
        }

        let totalOutflow = 0;
        for (let i = 0; i < ROWS; i++) {
          for (let j = 0; j < COLS; j++) {
            const idx = i * COLS + j;
            const vx = fluxes[idx * 2];
            const vy = fluxes[idx * 2 + 1];
            const v = Math.sqrt(vx * vx + vy * vy);
            totalOutflow += v * depths[idx];
          }
        }
        peakFlow = Math.max(peakFlow, totalOutflow * 0.001);
        sedimentCount = particles.filter(pp => pp.settled).length + particles.filter(pp => !pp.settled).length;
        updateMetrics(peakFlow, sedimentCount, connectivity);
      }
    };

    setInterval(runLoop, 100);
  };

  p.draw = () => {
    p.background(18, 18, 24);

    for (let i = 0; i < ROWS; i++) {
      for (let j = 0; j < COLS; j++) {
        const idx = i * COLS + j;
        const patchIdx = patchGrid[idx];
        const params = PATCH_PARAMS[patchKeys[patchIdx]] || PATCH_PARAMS.grass;

        p.fill(params.color);
        p.noStroke();
        p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);

        const h = depths[idx];
        if (h > 0.0005) {
          const alpha = Math.min(255, 160 + h * 3000);
          p.fill(80, 130, 200, alpha);
          p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
        }

        const vx = fluxes[idx * 2];
        const vy = fluxes[idx * 2 + 1];
        if (Math.abs(vx) > 0.001 || Math.abs(vy) > 0.001) {
          const cx = j * cellPx + cellPx / 2;
          const cy = i * cellPx + cellPx / 2;
          const scale = 3;
          p.stroke(255, 200, 100, 150);
          p.strokeWeight(1);
          p.line(cx, cy, cx + vx * scale, cy + vy * scale);
        }
      }
    }

    for (let i = 0; i < ROWS; i++) {
      for (let j = 0; j < COLS; j++) {
        const sd = sedimentDepth[i * COLS + j];
        if (sd > 0) {
          const alpha = Math.min(220, 80 + sd * 12);
          p.fill(139, 90, 43, alpha);
          p.noStroke();
          p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
        }
      }
    }

    for (const pt of particles) {
      if (pt.settled) continue;
      const size = 2;
      p.fill(pt.color[0], pt.color[1], pt.color[2], 255);
      p.noStroke();
      p.ellipse(pt.x * cellPx + cellPx / 2, pt.y * cellPx + cellPx / 2, size, size);
    }

    if (window.mosaicControls?.showElevationLines && elevations) {
      drawElevationContours(p);
    }

    const brushRadius = (window.mosaicControls?.brushSize ?? 3) * cellPx;
    if (p.mouseX >= 0 && p.mouseX < canvasW && p.mouseY >= 0 && p.mouseY < canvasH) {
      p.noFill();
      p.stroke(255, 255, 255, 120);
      p.strokeWeight(1);
      p.ellipse(p.mouseX, p.mouseY, brushRadius * 2, brushRadius * 2);
    }

    p.fill(220, 220, 220);
    p.textSize(Math.max(10, cellPx * 0.6));
    p.textAlign(p.LEFT, p.BOTTOM);
    p.noStroke();
    p.text('Click to paint patches', 8, canvasH - 8);
  };

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

  p.mousePressed = () => {
    if (p.mouseX < 0 || p.mouseX >= canvasW || p.mouseY < 0 || p.mouseY >= canvasH) return;
    paintAt(p.mouseX, p.mouseY);
  };

  p.mouseDragged = () => {
    if (p.mouseX < 0 || p.mouseX >= canvasW || p.mouseY < 0 || p.mouseY >= canvasH) return;
    paintAt(p.mouseX, p.mouseY);
  };
};

function paintAt(x, y) {
  const j = Math.floor(x / cellPx);
  const i = Math.floor(y / cellPx);
  const radius = window.mosaicControls?.brushSize ?? 3;
  if (i >= 0 && i < ROWS && j >= 0 && j < COLS) {
    const key = window.mosaicControls?.activePatch ?? PATCH_TYPES.GRASS;
    const idx = Object.keys(PATCH_PARAMS).indexOf(key);
    if (idx >= 0) {
      for (let di = -radius; di <= radius; di++) {
        for (let dj = -radius; dj <= radius; dj++) {
          const ni = i + di;
          const nj = j + dj;
          if (ni >= 0 && ni < ROWS && nj >= 0 && nj < COLS) {
            const dist = Math.sqrt(di * di + dj * dj);
            if (dist <= radius) {
              patchGrid[ni * COLS + nj] = idx;
            }
          }
        }
      }
    }
  }
}

new p5(sketch);
