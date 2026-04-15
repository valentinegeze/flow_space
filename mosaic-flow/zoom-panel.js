/**
 * zoom-panel.js — Side-by-side zoom panel for real-time fire micro-simulation.
 *
 * When cells are selected, a panel slides in from the right showing the
 * site-feature graph (trees/buildings). When fire reaches selected cells,
 * a micro-simulation animates spread node-to-node.
 */

import { FIRE } from './fire.js';
import { PHI_STAR as SITE_PHI_STAR } from './site-features.js';

// ═══════════════════════════════════════════════════════════════════════════
// Micro-sim node states
// ═══════════════════════════════════════════════════════════════════════════
const NODE = { UNBURNED: 0, BURNING: 1, BURNED: 2 };

// ═══════════════════════════════════════════════════════════════════════════
// Module state
// ═══════════════════════════════════════════════════════════════════════════
let _panel = null;          // DOM element
let _canvas = null;         // Canvas element inside panel
let _ctx = null;            // Canvas 2D context
let _divider = null;        // Divider bar
let _closeBtn = null;       // Close button
let _mosaicContainer = null;
let _visible = false;
let _animFrame = null;

// Micro-sim state
let _microNodes = [];       // [{type, lat, lon, state, burnAge, burnDuration, fuelLoad, vulnerability, crownRadius}]
let _microEdges = [];       // [{i, j, weight, distanceM}]
let _microPhiLocal = 0;
let _microStatus = '';      // 'real' | 'synthetic' | etc
let _fireReached = false;
let _fireArrivalTick = 0;
let _microTick = 0;
let _microTimer = null;
let _ignitionNodeIdx = -1;
let _hasSiteFeatures = false;

// Cached references
let _getSelectedBounds = null;
let _getFireState = null;
let _getSelectedCells = null;
let _getControls = null;
let _clearSelectionFn = null;

// ═══════════════════════════════════════════════════════════════════════════
// DOM setup
// ═══════════════════════════════════════════════════════════════════════════

export function createZoomPanel(mosaicContainer, {
  getSelectedBounds,
  getFireState,
  getSelectedCells,
  getControls,
  clearSelection,
}) {
  _mosaicContainer = mosaicContainer;
  _getSelectedBounds = getSelectedBounds;
  _getFireState = getFireState;
  _getSelectedCells = getSelectedCells;
  _getControls = getControls;
  _clearSelectionFn = clearSelection;

  // Make mosaic container a flex row with transition
  mosaicContainer.style.display = 'flex';
  mosaicContainer.style.flexDirection = 'row';
  mosaicContainer.style.transition = 'none';

  // Divider
  _divider = document.createElement('div');
  _divider.style.cssText = `
    width: 0; min-width: 0; background: #1a1a24;
    display: flex; flex-direction: column; align-items: center;
    transition: width 200ms ease, min-width 200ms ease;
    overflow: hidden; z-index: 50;
  `;
  _closeBtn = document.createElement('button');
  _closeBtn.textContent = '\u00d7';
  _closeBtn.title = 'Close zoom panel';
  _closeBtn.style.cssText = `
    background: rgba(40,40,55,0.95); border: 1px solid #333;
    color: #aaa; font-size: 16px; cursor: pointer;
    width: 22px; height: 22px; border-radius: 3px;
    margin-top: 6px; line-height: 1; padding: 0;
  `;
  _closeBtn.addEventListener('click', () => {
    if (_clearSelectionFn) _clearSelectionFn();
    hidePanel();
  });
  _divider.appendChild(_closeBtn);

  // Panel
  _panel = document.createElement('div');
  _panel.id = 'zoom-panel';
  _panel.style.cssText = `
    width: 0; min-width: 0; height: 100%;
    background: #12121a;
    overflow: hidden;
    transition: width 200ms ease, min-width 200ms ease;
    position: relative;
    flex-shrink: 0;
  `;

  _canvas = document.createElement('canvas');
  _canvas.style.cssText = 'display: block; width: 100%; height: 100%;';
  _panel.appendChild(_canvas);
  _ctx = _canvas.getContext('2d');

  mosaicContainer.appendChild(_divider);
  mosaicContainer.appendChild(_panel);
  setupClickHandler();

  return { showPanel, hidePanel, updateZoomPanel, checkFireArrival, resetMicroSim, setFeatureData };
}

// ═══════════════════════════════════════════════════════════════════════════
// Show / Hide with CSS transition
// ═══════════════════════════════════════════════════════════════════════════

function showPanel() {
  if (_visible) return;
  _visible = true;

  // Get available width (container width minus controls panel ~300px)
  const containerW = _mosaicContainer.clientWidth;
  const panelW = Math.floor(containerW * 0.35);

  _divider.style.width = '12px';
  _divider.style.minWidth = '12px';
  _panel.style.width = panelW + 'px';
  _panel.style.minWidth = panelW + 'px';

  // Resize canvas after transition
  setTimeout(() => {
    resizePanelCanvas();
    startRenderLoop();
  }, 220);
}

function hidePanel() {
  if (!_visible) return;
  _visible = false;

  _divider.style.width = '0';
  _divider.style.minWidth = '0';
  _panel.style.width = '0';
  _panel.style.minWidth = '0';

  stopMicroSim();
  stopRenderLoop();
}

function resizePanelCanvas() {
  if (!_panel || !_canvas) return;
  const w = _panel.clientWidth;
  const h = _panel.clientHeight;
  if (w <= 0 || h <= 0) return;
  _canvas.width = w * (window.devicePixelRatio || 1);
  _canvas.height = h * (window.devicePixelRatio || 1);
  _canvas.style.width = w + 'px';
  _canvas.style.height = h + 'px';
  _ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature data intake
// ═══════════════════════════════════════════════════════════════════════════

function setFeatureData(siteFeatureResult, hasSiteFeatures) {
  _hasSiteFeatures = hasSiteFeatures;
  if (!siteFeatureResult) {
    _microNodes = [];
    _microEdges = [];
    _microPhiLocal = 0;
    _microStatus = '';
    return;
  }

  const { nodes, edges, phiLocal, status } = siteFeatureResult;
  _microPhiLocal = phiLocal || 0;
  _microStatus = status || '';

  // Deep-copy nodes with micro-sim state
  _microNodes = (nodes || []).map(n => ({
    ...n,
    state: NODE.UNBURNED,
    burnAge: 0,
    burnDuration: n.type === 'tree' ? 5 : 2,
    fuelLoad: n.type === 'tree' ? 0.35 : (n.vulnerability || 0.3) * 0.5,
  }));

  _microEdges = (edges || []).map(e => ({ ...e }));
  _microTick = 0;
  _fireReached = false;
  _ignitionNodeIdx = -1;
}

// ═══════════════════════════════════════════════════════════════════════════
// Fire arrival detection — called from sketch.js after each fire step
// ═══════════════════════════════════════════════════════════════════════════

function checkFireArrival(fireState, selectedCells, cols, rows, timestep) {
  if (!_visible || _fireReached || !fireState || selectedCells.length === 0) return;

  for (const { r, c } of selectedCells) {
    const idx = r * cols + c;
    if (fireState.cell[idx] === FIRE.BURNING) {
      _fireReached = true;
      _fireArrivalTick = timestep;

      // Find closest node to the burning cell for ignition seed
      if (_microNodes.length > 0) {
        const bounds = _getSelectedBounds?.();
        let cellLat, cellLon;
        if (bounds) {
          const latStep = (bounds.north - bounds.south) / rows;
          const lonStep = (bounds.east - bounds.west) / cols;
          cellLat = bounds.south + (r + 0.5) * latStep;
          cellLon = bounds.west + (c + 0.5) * lonStep;
        } else {
          // Synthetic case: node lat/lon are grid row/col
          cellLat = r;
          cellLon = c;
        }

        let bestDist = Infinity;
        _ignitionNodeIdx = 0;
        for (let i = 0; i < _microNodes.length; i++) {
          const n = _microNodes[i];
          const dlat = n.lat - cellLat;
          const dlon = n.lon - cellLon;
          const d = dlat * dlat + dlon * dlon;
          if (d < bestDist) { bestDist = d; _ignitionNodeIdx = i; }
        }

        // Ignite the seed node
        if (_microNodes[_ignitionNodeIdx]) {
          _microNodes[_ignitionNodeIdx].state = NODE.BURNING;
          _microNodes[_ignitionNodeIdx].burnAge = 0;
        }
      }

      startMicroSim();
      return;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Micro-simulation
// ═══════════════════════════════════════════════════════════════════════════

function startMicroSim() {
  stopMicroSim();
  _microTimer = setInterval(stepMicroSim, 300);
}

function stopMicroSim() {
  if (_microTimer) { clearInterval(_microTimer); _microTimer = null; }
}

function stepMicroSim() {
  if (!_fireReached || _microNodes.length === 0) return;
  _microTick++;

  const controls = _getControls?.() || {};
  const windAngle = controls.windAngle ?? 225;
  const windSpeed = controls.windSpeed ?? 2.5;
  const wRad = (windAngle * Math.PI) / 180;
  const wx = Math.sin(wRad), wy = -Math.cos(wRad);

  // Track which unburned nodes have been attempted this tick (one roll per node)
  const attempted = new Set();

  // Process burning nodes
  for (let i = 0; i < _microNodes.length; i++) {
    const node = _microNodes[i];
    if (node.state !== NODE.BURNING) continue;

    node.burnAge++;
    if (node.burnAge >= node.burnDuration) {
      node.state = NODE.BURNED;
      // Still try to spread on final tick
    }

    // Try to ignite neighbors via edges
    for (const edge of _microEdges) {
      let neighborIdx = -1;
      if (edge.i === i) neighborIdx = edge.j;
      else if (edge.j === i) neighborIdx = edge.i;
      else continue;

      const neighbor = _microNodes[neighborIdx];
      if (neighbor.state !== NODE.UNBURNED) continue;
      if (attempted.has(neighborIdx)) continue;
      attempted.add(neighborIdx);

      // Recompute weight with current wind
      let weight = edge.weight;

      // Vulnerability boost for buildings
      if (neighbor.type === 'building') {
        weight *= 1 + (neighbor.vulnerability || 0.3);
      }

      // Ignition probability = edge weight × node fuelLoad
      const P = Math.min(1.0, weight * neighbor.fuelLoad * 3.5);
      if (Math.random() < P) {
        neighbor.state = NODE.BURNING;
        neighbor.burnAge = 0;
      }
    }
  }
}

export function resetMicroSim() {
  stopMicroSim();
  _fireReached = false;
  _microTick = 0;
  _ignitionNodeIdx = -1;
  for (const n of _microNodes) {
    n.state = NODE.UNBURNED;
    n.burnAge = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Edge reweighting (wind change)
// ═══════════════════════════════════════════════════════════════════════════

let _lastPanelWindAngle = -1;
let _lastPanelWindSpeed = -1;

function reweightEdgesIfNeeded(siteFeatureResult) {
  if (!siteFeatureResult) return;
  const controls = _getControls?.() || {};
  const wAngle = controls.windAngle ?? 225;
  const wSpeed = controls.windSpeed ?? 2.5;
  if (wAngle === _lastPanelWindAngle && wSpeed === _lastPanelWindSpeed) return;
  _lastPanelWindAngle = wAngle;
  _lastPanelWindSpeed = wSpeed;

  // Update edges from the source result (which gets rebuilt by sketch.js maybeRebuildEdges)
  if (siteFeatureResult.edges) {
    _microEdges = siteFeatureResult.edges.map(e => ({ ...e }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Render loop
// ═══════════════════════════════════════════════════════════════════════════

function startRenderLoop() {
  stopRenderLoop();
  const loop = () => {
    if (!_visible) return;
    renderPanel();
    _animFrame = requestAnimationFrame(loop);
  };
  _animFrame = requestAnimationFrame(loop);
}

function stopRenderLoop() {
  if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }
}

function renderPanel() {
  if (!_ctx || !_canvas) return;
  const w = _canvas.width / (window.devicePixelRatio || 1);
  const h = _canvas.height / (window.devicePixelRatio || 1);
  if (w <= 0 || h <= 0) return;

  // Clear
  _ctx.fillStyle = '#12121a';
  _ctx.fillRect(0, 0, w, h);

  if (_microNodes.length === 0) {
    _ctx.fillStyle = '#666';
    _ctx.font = '12px system-ui, sans-serif';
    _ctx.textAlign = 'center';
    _ctx.fillText('Select cells to view feature graph', w / 2, h / 2);
    return;
  }

  // Compute coordinate bounds from nodes (works for both real lat/lon and synthetic grid coords)
  let bounds = _getSelectedBounds?.();
  if (!bounds) {
    // Derive bounds from node lat/lon (synthetic case uses grid r,c)
    if (_microNodes.length === 0) return;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const n of _microNodes) {
      if (n.lat < minLat) minLat = n.lat;
      if (n.lat > maxLat) maxLat = n.lat;
      if (n.lon < minLon) minLon = n.lon;
      if (n.lon > maxLon) maxLon = n.lon;
    }
    bounds = { south: minLat - 0.5, north: maxLat + 0.5, west: minLon - 0.5, east: maxLon + 0.5 };
  }

  const padX = 30, padY = 40;
  const plotW = w - 2 * padX;
  const plotH = h - 2 * padY;
  const latRange = bounds.north - bounds.south || 1e-6;
  const lonRange = bounds.east - bounds.west || 1e-6;

  function toScreen(lat, lon) {
    return {
      x: padX + ((lon - bounds.west) / lonRange) * plotW,
      y: padY + ((bounds.north - lat) / latRange) * plotH,
    };
  }

  // ── Draw edges ────────────────────────────────────────────────────────
  for (const e of _microEdges) {
    const ni = _microNodes[e.i], nj = _microNodes[e.j];
    if (!ni || !nj) continue;
    const a = toScreen(ni.lat, ni.lon);
    const b = toScreen(nj.lat, nj.lon);

    // Active spread edge: burning → unburned
    const isBurning = ni.state === NODE.BURNING || nj.state === NODE.BURNING;
    const isUnburned = ni.state === NODE.UNBURNED || nj.state === NODE.UNBURNED;
    const isActiveSpread = isBurning && isUnburned;

    if (isActiveSpread) {
      _ctx.strokeStyle = `rgba(255, 180, 60, ${0.6 + 0.3 * Math.sin(_microTick * 1.5)})`;
      _ctx.lineWidth = Math.max(1, e.weight * 6);
    } else {
      const alpha = 0.15 + e.weight * 0.35;
      _ctx.strokeStyle = `rgba(140, 160, 190, ${alpha})`;
      _ctx.lineWidth = 0.5 + e.weight * 2;
    }

    _ctx.beginPath();
    _ctx.moveTo(a.x, a.y);
    _ctx.lineTo(b.x, b.y);
    _ctx.stroke();
  }

  // ── Draw nodes ────────────────────────────────────────────────────────
  const tick = _microTick;
  for (const n of _microNodes) {
    const s = toScreen(n.lat, n.lon);

    if (n.type === 'tree') {
      const baseR = (n.crownRadius || 3) * 1.2;

      if (n.state === NODE.UNBURNED) {
        _ctx.fillStyle = '#6ebe6e';
        fillCircle(s.x, s.y, baseR);
      } else if (n.state === NODE.BURNING) {
        // Pulsing outer ring
        const pulse = 1 + 0.25 * Math.sin(tick * 2.5);
        _ctx.strokeStyle = 'rgba(240, 100, 60, 0.5)';
        _ctx.lineWidth = 2;
        strokeCircle(s.x, s.y, baseR * pulse + 3);
        _ctx.fillStyle = '#f06440';
        fillCircle(s.x, s.y, baseR);
      } else {
        // Burned — dark gray, smaller
        _ctx.fillStyle = '#444';
        fillCircle(s.x, s.y, baseR * 0.75);
      }
    } else {
      // Building
      const sz = 8;
      const vuln = n.vulnerability || 0.3;

      if (n.state === NODE.UNBURNED) {
        _ctx.fillStyle = '#6ebe6e';
        fillRoundRect(s.x - sz / 2, s.y - sz / 2, sz, sz, 2);
        _ctx.strokeStyle = `rgba(100, 190, 100, ${0.3 + vuln * 0.5})`;
        _ctx.lineWidth = 0.5 + vuln * 2.5;
        strokeRoundRect(s.x - sz / 2, s.y - sz / 2, sz, sz, 2);
      } else if (n.state === NODE.BURNING) {
        // Flicker between coral and amber
        const flicker = tick % 2 === 0;
        _ctx.fillStyle = flicker ? '#f06440' : '#e0a030';
        fillRoundRect(s.x - sz / 2, s.y - sz / 2, sz, sz, 2);
        _ctx.strokeStyle = flicker ? '#e0a030' : '#f06440';
        _ctx.lineWidth = 1 + vuln * 2;
        strokeRoundRect(s.x - sz / 2, s.y - sz / 2, sz, sz, 2);
      } else {
        // Burned
        _ctx.fillStyle = '#444';
        fillRoundRect(s.x - sz / 2, s.y - sz / 2, sz * 0.85, sz * 0.85, 2);
      }
    }
  }

  // ── HUD: phi value ────────────────────────────────────────────────────
  _ctx.textAlign = 'left';
  _ctx.font = '11px system-ui, sans-serif';
  const phiColor = _microPhiLocal > SITE_PHI_STAR ? '#f08246' : '#78b4dc';
  _ctx.fillStyle = phiColor;
  _ctx.fillText(`\u03c6 = ${_microPhiLocal.toFixed(2)}`, 10, 16);
  if (_microPhiLocal > SITE_PHI_STAR) {
    _ctx.font = '9px system-ui, sans-serif';
    _ctx.fillStyle = '#f08246';
    _ctx.fillText('\u2014 supercritical', 10, 28);
  }

  // ── HUD: status / waiting ─────────────────────────────────────────────
  if (!_fireReached) {
    // Pulsing "Waiting for fire..." text
    const pulse = 0.5 + 0.3 * Math.sin(Date.now() / 600);
    _ctx.textAlign = 'center';
    _ctx.font = '13px system-ui, sans-serif';
    _ctx.fillStyle = `rgba(200, 180, 160, ${pulse})`;
    _ctx.fillText('Waiting for fire\u2026', w / 2, 20);
  } else {
    // Timer since arrival
    _ctx.textAlign = 'right';
    _ctx.font = '11px system-ui, sans-serif';
    _ctx.fillStyle = '#cc8844';
    _ctx.fillText(`t = ${_microTick}s into arrival`, w - 10, 16);
  }

  // ── Synthetic notice ──────────────────────────────────────────────────
  if (!_hasSiteFeatures) {
    _ctx.textAlign = 'left';
    _ctx.font = '9px system-ui, sans-serif';
    _ctx.fillStyle = '#777';
    _ctx.fillText('Using synthetic graph \u2014 load site features for real trees and buildings', 10, h - 8);
  }

  // ── Wind arrow (top-right) ────────────────────────────────────────────
  const controls = _getControls?.() || {};
  const wAngle = controls.windAngle ?? 225;
  const wSpeed = controls.windSpeed ?? 2.5;
  const cx = w - 24, cy = 24;
  const rad = (wAngle * Math.PI) / 180;
  const arrowLen = 12;
  const ax = cx + Math.sin(rad) * arrowLen;
  const ay = cy - Math.cos(rad) * arrowLen;
  _ctx.strokeStyle = 'rgba(200, 180, 130, 0.6)';
  _ctx.lineWidth = 1.5;
  _ctx.beginPath();
  _ctx.moveTo(cx, cy);
  _ctx.lineTo(ax, ay);
  _ctx.stroke();
  _ctx.fillStyle = 'rgba(200, 180, 130, 0.6)';
  fillCircle(ax, ay, 2.5);

  // ── Reset button (bottom-right, only during active fire) ──────────────
  if (_fireReached) {
    const bw = 90, bh = 22;
    const bx = w - bw - 8, by = h - bh - 8;
    _ctx.fillStyle = 'rgba(40, 40, 55, 0.9)';
    fillRoundRect(bx, by, bw, bh, 4);
    _ctx.strokeStyle = '#555';
    _ctx.lineWidth = 1;
    strokeRoundRect(bx, by, bw, bh, 4);
    _ctx.fillStyle = '#bbb';
    _ctx.font = '10px system-ui, sans-serif';
    _ctx.textAlign = 'center';
    _ctx.fillText('Reset zoom fire', bx + bw / 2, by + bh / 2 + 3);

    // Store for click detection
    _resetBtnRect = { x: bx, y: by, w: bw, h: bh };
  } else {
    _resetBtnRect = null;
  }

  // ── Legend ─────────────────────────────────────────────────────────────
  const legendX = 10;
  let legendY = h - 60;
  if (!_hasSiteFeatures) legendY -= 14;
  _ctx.font = '9px system-ui, sans-serif';
  _ctx.textAlign = 'left';

  _ctx.fillStyle = '#6ebe6e';
  fillCircle(legendX + 5, legendY + 4, 4);
  _ctx.fillStyle = '#aaa';
  _ctx.fillText('tree', legendX + 14, legendY + 7);
  legendY += 14;

  _ctx.fillStyle = '#6ebe6e';
  fillRoundRect(legendX + 1, legendY, 8, 8, 2);
  _ctx.fillStyle = '#aaa';
  _ctx.fillText('building', legendX + 14, legendY + 7);
}

let _resetBtnRect = null;

// ═══════════════════════════════════════════════════════════════════════════
// Click handling for reset button
// ═══════════════════════════════════════════════════════════════════════════

function setupClickHandler() {
  if (!_canvas) return;
  _canvas.addEventListener('click', (e) => {
    if (!_resetBtnRect) return;
    const rect = _canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x >= _resetBtnRect.x && x <= _resetBtnRect.x + _resetBtnRect.w &&
        y >= _resetBtnRect.y && y <= _resetBtnRect.y + _resetBtnRect.h) {
      resetMicroSim();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Canvas helpers
// ═══════════════════════════════════════════════════════════════════════════

function fillCircle(x, y, r) {
  _ctx.beginPath();
  _ctx.arc(x, y, r, 0, Math.PI * 2);
  _ctx.fill();
}

function strokeCircle(x, y, r) {
  _ctx.beginPath();
  _ctx.arc(x, y, r, 0, Math.PI * 2);
  _ctx.stroke();
}

function fillRoundRect(x, y, w, h, r) {
  _ctx.beginPath();
  _ctx.roundRect(x, y, w, h, r);
  _ctx.fill();
}

function strokeRoundRect(x, y, w, h, r) {
  _ctx.beginPath();
  _ctx.roundRect(x, y, w, h, r);
  _ctx.stroke();
}

// ═══════════════════════════════════════════════════════════════════════════
// Public update — called from sketch.js draw loop
// ═══════════════════════════════════════════════════════════════════════════

function updateZoomPanel(siteFeatureResult, hasSiteFeatures) {
  if (!_visible) return;
  // Keep edges in sync with wind changes
  reweightEdgesIfNeeded(siteFeatureResult);
}

// ═══════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════

export { showPanel, hidePanel, NODE };
