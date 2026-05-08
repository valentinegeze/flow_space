/**
 * phi-panel.js — Percolation φ overlay panel for the mosaic view.
 *
 * Shows:
 *  - Current φ value with "percolates" / "contained" label
 *  - Flammability-threshold slider (filters cells by fuelLoad)
 *  - Small S-curve chart (φ vs spread extent)
 *  - Fire / Flood mode toggle for which patch types count as flammable
 *
 * The panel is an HTML overlay div positioned on top of the p5 canvas.
 * It drives computePhiConnectivity() from connectivity.js and exposes a
 * getClusterOverlay() function that sketch.js can query every frame to
 * tint the giant cluster.
 */

import { PATCH_PARAMS } from './patches.js';
import { computePhiConnectivity } from './connectivity.js';

const PHI_STAR = 0.59;

const patchKeys = Object.keys(PATCH_PARAMS);

// Fire-relevant patch types
const FIRE_KEYS  = ['grass', 'forest', 'corridor'];
// Flood-relevant: everything except urban and water
const FLOOD_KEYS = ['grass', 'forest', 'wetland', 'bare', 'corridor'];

// ── Module state ─────────────────────────────────────────────────────────────
let _patchGrid = null;   // reference to the live patchGrid from sketch.js
let _cols = 64;
let _rows = 64;
let _mode = 'fire';      // 'fire' | 'flood'
let _threshold = 0;      // fuelLoad threshold — cells with fuelLoad >= threshold count
let _phi = 0;
let _clusterMap = null;   // Int32Array from computePhiConnectivity
let _giantSize = 0;

// DOM references
let _panelEl = null;
let _phiValueEl = null;
let _phiLabelEl = null;
let _threshValEl = null;
let _chartCanvas = null;
let _chartCtx = null;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create the panel DOM and append to the mosaic container.
 * Call once during sketch setup.
 * @param {HTMLElement} parentEl  — the #mosaic-container div
 */
export function createPhiPanel(parentEl) {
  _panelEl = document.createElement('div');
  _panelEl.id = 'phi-panel';
  _panelEl.innerHTML = `
    <div class="phi-header">
      <span class="phi-symbol">&phi;</span>
      <span class="phi-value" id="phi-val">0.00</span>
    </div>
    <div class="phi-label" id="phi-label">contained</div>

    <label class="phi-slider-label">
      threshold <span id="phi-thresh-val">0.00</span>
    </label>
    <input type="range" id="phi-thresh" min="0" max="0.45" step="0.005" value="0">

    <canvas id="phi-scurve" width="200" height="120"></canvas>

    <!-- Step 2 is fire-only now; the Flood mode button was hidden when the
         user-facing flood toggle was removed from Step 2. φ_flood readout still
         exists in the code for Step 3's pre/post comparison. -->
    <div class="phi-mode-row">
      <button class="phi-mode-btn active" data-mode="fire">Fire</button>
    </div>
    <div class="phi-scale-readout" id="phi-scale-readout">
      <span style="color:#888;">scale:</span> <span id="phi-cell-size">unitless</span>
    </div>
  `;
  // Styles are in styles.css
  parentEl.appendChild(_panelEl);

  _phiValueEl  = _panelEl.querySelector('#phi-val');
  _phiLabelEl  = _panelEl.querySelector('#phi-label');
  _threshValEl = _panelEl.querySelector('#phi-thresh-val');
  _chartCanvas = _panelEl.querySelector('#phi-scurve');
  _chartCtx    = _chartCanvas.getContext('2d');

  // Threshold slider
  const slider = _panelEl.querySelector('#phi-thresh');
  slider.addEventListener('input', () => {
    _threshold = parseFloat(slider.value);
    _threshValEl.textContent = _threshold.toFixed(2);
    _recompute();
  });

  // Mode toggle
  _panelEl.querySelectorAll('.phi-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _panelEl.querySelectorAll('.phi-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _mode = btn.dataset.mode;
      _recompute();
    });
  });
}

/**
 * Bind the live patchGrid reference so recompute can use it.
 * Call after initGrid() in sketch.js, and again if patchGrid is replaced.
 */
export function setPhiGrid(patchGrid, cols, rows) {
  _patchGrid = patchGrid;
  _cols = cols;
  _rows = rows;
  _recompute();
  _refreshCellSize();
}

// Show the real-world cell size when a parcel is loaded; otherwise show
// "unitless" so the user knows the random-landscape view doesn't have a
// physical scale. Called whenever the grid is set up or refreshed.
function _refreshCellSize() {
  const el = _panelEl?.querySelector?.('#phi-cell-size');
  if (!el) return;
  // Pull bounds from sharedState (set by the parcel-analysis flow). If the
  // user came in via the Randomize fork, bounds will be missing → unitless.
  let bounds = null;
  try {
    if (typeof window !== 'undefined' && window.simState && window.simState.parcelBounds) {
      bounds = window.simState.parcelBounds;
    } else if (typeof window !== 'undefined' && window.mosaicControls?.parcelBounds) {
      bounds = window.mosaicControls.parcelBounds;
    }
  } catch (e) { /* fall through */ }
  if (!bounds || !_cols || !_rows) {
    el.textContent = 'unitless (synthetic)';
    el.title = 'Random landscape — model is intrinsically scale-invariant';
    return;
  }
  // Haversine — same as zoom-panel.js cellSizeLabel.
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const latMid = (bounds.north + bounds.south) / 2;
  const dW = bounds.east - bounds.west;
  const dH = bounds.north - bounds.south;
  const widthM  = 2 * R * Math.asin(Math.sqrt(Math.cos(toRad(latMid))**2 * Math.sin(toRad(dW)/2)**2));
  const heightM = 2 * R * Math.asin(Math.sqrt(Math.sin(toRad(dH)/2)**2));
  const cw = widthM / _cols, ch = heightM / _rows;
  el.textContent = `${cw.toFixed(0)}×${ch.toFixed(0)} m per cell`;
  el.title = `Parcel ≈ ${(widthM).toFixed(0)}×${heightM.toFixed(0)} m, divided into ${_cols}×${_rows} cells`;
}

/**
 * Returns the current cluster overlay data for sketch.js to use during rendering.
 * @returns {{ clusterMap: Int32Array|null, phi: number, mode: string }}
 */
export function getClusterOverlay() {
  return { clusterMap: _clusterMap, phi: _phi, mode: _mode };
}

/** Get current phi mode ('fire' | 'flood') */
export function getPhiMode() { return _mode; }

// ── Internal ─────────────────────────────────────────────────────────────────

function _activeKeys() {
  return _mode === 'fire' ? FIRE_KEYS : FLOOD_KEYS;
}

function _filteredKeys() {
  // Return only the active keys whose fuelLoad (fire) or infiltration inverse (flood)
  // passes the threshold.
  const base = _activeKeys();
  if (_threshold <= 0) return base;
  return base.filter(k => {
    const p = PATCH_PARAMS[k];
    if (_mode === 'fire') return (p.fuelLoad ?? 0) >= _threshold;
    // Flood: use inverse connectivity threshold normalized to 0–1
    return (1 - (p.connectivityThreshold ?? 0) / 1.5) >= _threshold;
  });
}

function _recompute() {
  if (!_patchGrid) return;

  const keys = _filteredKeys();
  const result = computePhiConnectivity(_patchGrid, patchKeys, keys, _cols, _rows);
  _phi = result.phi;
  _giantSize = result.giantClusterSize;
  _clusterMap = result.clusterMap;

  // Update DOM
  if (_phiValueEl) _phiValueEl.textContent = _phi.toFixed(2);
  if (_phiLabelEl) {
    if (_phi > PHI_STAR) {
      _phiLabelEl.textContent = 'percolates';
      _phiLabelEl.style.color = '#E8593C';
    } else {
      _phiLabelEl.textContent = 'contained';
      _phiLabelEl.style.color = '#3B8BD4';
    }
  }

  _drawSCurve();
}

function _drawSCurve() {
  const ctx = _chartCtx;
  if (!ctx) return;
  const w = _chartCanvas.width, h = _chartCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const pad = { top: 12, right: 8, bottom: 22, left: 28 };
  const pw = w - pad.left - pad.right;
  const ph = h - pad.top - pad.bottom;

  // Axes
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + ph);
  ctx.lineTo(pad.left + pw, pad.top + ph);
  ctx.stroke();

  // Labels
  ctx.fillStyle = '#999';
  ctx.font = '9px Inter, system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('\u03c6', pad.left + pw / 2, h - 2);
  ctx.save();
  ctx.translate(7, pad.top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('spread', 0, 0);
  ctx.restore();

  // Ticks
  ctx.fillStyle = '#bbb';
  ctx.font = '8px Inter, system-ui';
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) {
    const v = i / 4;
    ctx.fillText(v.toFixed(1), pad.left + v * pw, pad.top + ph + 12);
  }

  // S-curve (sigmoid approximation)
  ctx.strokeStyle = 'rgba(60,120,180,0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i <= 100; i++) {
    const phi = i / 100;
    const spread = 1 / (1 + Math.exp(-16 * (phi - PHI_STAR)));
    const x = pad.left + phi * pw;
    const y = pad.top + ph - spread * ph;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // φ* dashed vertical
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = 'rgba(192,80,48,0.4)';
  ctx.lineWidth = 1;
  const xStar = pad.left + PHI_STAR * pw;
  ctx.beginPath();
  ctx.moveTo(xStar, pad.top);
  ctx.lineTo(xStar, pad.top + ph);
  ctx.stroke();
  ctx.setLineDash([]);

  // φ* label
  ctx.fillStyle = '#c05030';
  ctx.font = '8px Inter, system-ui';
  ctx.fillText('\u03c6*', xStar, pad.top - 2);

  // Current φ dot
  const spread = 1 / (1 + Math.exp(-16 * (_phi - PHI_STAR)));
  const dx = pad.left + Math.min(1, _phi) * pw;
  const dy = pad.top + ph - spread * ph;
  ctx.fillStyle = _phi > PHI_STAR ? '#E8593C' : '#3B8BD4';
  ctx.beginPath();
  ctx.arc(dx, dy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// Styles are in styles.css
