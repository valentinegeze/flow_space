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
let _igniteBtn = null;        // always-visible "Ignite a tree" button
// Screen-space positions of each node, captured during renderPanel so the
// click-to-ignite handler can find the nearest node without recomputing the
// projection. Index-aligned with _microNodes.
let _nodeScreenPositions = [];
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
  _divider.className = 'zoom-divider';
  _closeBtn = document.createElement('button');
  _closeBtn.textContent = '\u00d7';
  _closeBtn.title = 'Close zoom panel';
  _closeBtn.className = 'zoom-close-btn';
  _closeBtn.addEventListener('click', () => {
    if (_clearSelectionFn) _clearSelectionFn();
    hidePanel();
  });
  _divider.appendChild(_closeBtn);

  // Panel
  _panel = document.createElement('div');
  _panel.id = 'zoom-panel';
  _panel.className = 'zoom-panel-body';

  _canvas = document.createElement('canvas');
  // crosshair cursor signals to the user that this canvas accepts clicks —
  // without it, it's not obvious that the trees are interactive.
  _canvas.style.cssText = 'display: block; width: 100%; height: 100%; cursor: crosshair;';
  _panel.appendChild(_canvas);
  _ctx = _canvas.getContext('2d');

  // Always-visible "Ignite a tree" floating button. Clicking it ignites the
  // node closest to the panel center, regardless of where the user clicks —
  // gives a single-click way to start the micro-sim without needing to aim
  // for a specific tree, which was apparently the discoverability problem.
  const igniteBtn = document.createElement('button');
  igniteBtn.className = 'zoom-ignite-btn';
  igniteBtn.textContent = 'Ignite a tree';
  igniteBtn.title = 'Ignite the centermost unburned tree to start the spread';
  igniteBtn.addEventListener('click', () => {
    igniteCenterNode();
  });
  _panel.appendChild(igniteBtn);
  _igniteBtn = igniteBtn;

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
  if (_igniteBtn) _igniteBtn.style.display = 'none';

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

  // Deep-copy nodes with micro-sim state. Bumped burnDuration so each tree
  // gets more spread attempts before going BURNED — without enough chances,
  // a single low-weight edge can kill the whole burn at the seed.
  _microNodes = (nodes || []).map(n => ({
    ...n,
    state: NODE.UNBURNED,
    burnAge: 0,
    burnDuration: n.type === 'tree' ? 8 : 3,
    fuelLoad: n.type === 'tree' ? 0.55 : (n.vulnerability || 0.3) * 0.7,
  }));

  _microEdges = (edges || []).map(e => ({ ...e }));
  _microTick = 0;
  _fireReached = false;
  _ignitionNodeIdx = -1;
  // Diagnostic — DevTools shows whether the synthetic graph actually
  // connected the cells you picked. If edges=0, spread can never happen.
  console.log(
    `[zoom-panel] setFeatureData: ${_microNodes.length} nodes, ` +
    `${_microEdges.length} edges, hasSiteFeatures=${hasSiteFeatures}`
  );
  // Show the "Ignite a tree" button once the panel has nodes to ignite.
  // Use 'block' explicitly — empty string falls back to the CSS rule, which
  // is `display: none` for this class.
  if (_igniteBtn) _igniteBtn.style.display = _microNodes.length > 0 ? 'block' : 'none';
}

// ═══════════════════════════════════════════════════════════════════════════
// Fire arrival detection — called from sketch.js after each fire step
// ═══════════════════════════════════════════════════════════════════════════

function checkFireArrival(fireState, selectedCells, cols, rows, timestep) {
  if (!_visible || _fireReached || !fireState || selectedCells.length === 0) return;

  for (const { r, c } of selectedCells) {
    const idx = r * cols + c;
    // Also accept BURNED — for small selections the main-grid fire can race
    // through a cell between worker dispatches, leaving the cell already
    // BURNED by the time we look at it. Without this branch we'd miss the
    // arrival entirely and the zoom panel would sit "Waiting for fire…"
    // forever even though the parcel already burned.
    if (fireState.cell[idx] === FIRE.BURNING || fireState.cell[idx] === FIRE.BURNED) {
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

      // Ignition probability — bumped multiplier and added a 0.15 floor so
      // even weak edges have some chance per tick. Combined with the longer
      // burnDuration this guarantees visible spread for any non-degenerate
      // graph (the model is for visualization, not strict probabilistic
      // realism — that's what the main grid model is for).
      const P = Math.max(0.15, Math.min(1.0, weight * neighbor.fuelLoad * 6.0));
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
  // Bring the "Ignite a tree" button back so the user can re-trigger.
  if (_igniteBtn) _igniteBtn.style.display = _microNodes.length > 0 ? 'block' : 'none';
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
  _ctx.fillStyle = '#fafafa';
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
  // Reset cached node screen positions for the click handler.
  _nodeScreenPositions.length = _microNodes.length;
  for (let nidx = 0; nidx < _microNodes.length; nidx++) {
    const n = _microNodes[nidx];
    const s = toScreen(n.lat, n.lon);
    _nodeScreenPositions[nidx] = s;

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
  // Node-count badge \u2014 answers "why so few/many trees?" by surfacing how many
  // fuel-bearing cells the synthetic graph builder found in the selected area.
  _ctx.font = '10px system-ui, sans-serif';
  _ctx.fillStyle = '#888';
  const _burningN = _microNodes.filter(n => n.state === NODE.BURNING).length;
  const _burnedN  = _microNodes.filter(n => n.state === NODE.BURNED).length;
  _ctx.fillText(
    `${_microNodes.length} nodes \u00b7 ${_burningN} burning \u00b7 ${_burnedN} burned`,
    10, _microPhiLocal > SITE_PHI_STAR ? 42 : 30
  );

  // ── HUD: status / waiting ─────────────────────────────────────────────
  if (!_fireReached) {
    // Pulsing "Waiting for fire..." text
    const pulse = 0.5 + 0.3 * Math.sin(Date.now() / 600);
    _ctx.textAlign = 'center';
    _ctx.font = '13px system-ui, sans-serif';
    _ctx.fillStyle = `rgba(200, 180, 160, ${pulse})`;
    _ctx.fillText('Waiting for fire\u2026', w / 2, 20);
    // Hint that the user can short-circuit the wait by clicking on a tree.
    _ctx.font = '10px system-ui, sans-serif';
    _ctx.fillStyle = `rgba(150, 150, 150, ${pulse})`;
    _ctx.fillText('click any tree to ignite manually', w / 2, 36);
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
  // Larger, brighter label so it's obvious how to start over.
  if (_fireReached) {
    const bw = 130, bh = 26;
    const bx = w - bw - 10, by = h - bh - 10;
    _ctx.fillStyle = '#c05030';
    fillRoundRect(bx, by, bw, bh, 5);
    _ctx.strokeStyle = '#a04020';
    _ctx.lineWidth = 1;
    strokeRoundRect(bx, by, bw, bh, 5);
    _ctx.fillStyle = '#fff';
    _ctx.font = '11px system-ui, sans-serif';
    _ctx.textAlign = 'center';
    _ctx.fillText('↻ Restart tree-by-tree', bx + bw / 2, by + bh / 2 + 4);

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

// Ignite the closest unburned node to the panel center. Used by both the
// always-visible "Ignite a tree" button and as a one-click safety net when
// the user can't aim for individual trees.
// Haversine distance between two (lat, lon) points in metres. Used to compute
// the real-world cell size for the parcel currently loaded — answers the
// "how big is each square?" question with a concrete number.
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Returns "{cellW}×{cellH} m" for a real parcel, "unitless" for the synthetic
// (randomized) path. cols/rows come from the zoom panel's caller so the same
// numbers as the main grid are used.
function cellSizeLabel(cols, rows) {
  const bounds = _getSelectedBounds?.();
  if (!bounds || cols <= 0 || rows <= 0) return 'unitless';
  // East-west span at the parcel's mean latitude:
  const latMid = (bounds.north + bounds.south) / 2;
  const widthMeters  = haversineMeters(latMid, bounds.west, latMid, bounds.east);
  const heightMeters = haversineMeters(bounds.south, bounds.west, bounds.north, bounds.west);
  const cellW = widthMeters  / cols;
  const cellH = heightMeters / rows;
  return `cell ≈ ${cellW.toFixed(0)}×${cellH.toFixed(0)} m`;
}

// Count edges touching a given node — used for diagnostic logging.
function edgesTouchingNode(idx) {
  let c = 0;
  for (const e of _microEdges) if (e.i === idx || e.j === idx) c++;
  return c;
}

function igniteCenterNode() {
  if (_microNodes.length === 0) return;
  // Find the geometric center of the node cloud
  let sumLat = 0, sumLon = 0, n = 0;
  for (const node of _microNodes) {
    if (node.state === NODE.UNBURNED) { sumLat += node.lat; sumLon += node.lon; n++; }
  }
  if (n === 0) return;   // everything already burning/burned
  const cLat = sumLat / n, cLon = sumLon / n;
  let bestI = -1, bestD = Infinity;
  for (let i = 0; i < _microNodes.length; i++) {
    if (_microNodes[i].state !== NODE.UNBURNED) continue;
    const dlat = _microNodes[i].lat - cLat;
    const dlon = _microNodes[i].lon - cLon;
    const d = dlat * dlat + dlon * dlon;
    if (d < bestD) { bestD = d; bestI = i; }
  }
  if (bestI === -1) return;
  _microNodes[bestI].state = NODE.BURNING;
  _microNodes[bestI].burnAge = 0;

  // Diagnostic: log graph stats so the user can see in DevTools whether the
  // seed is connected. If `edges touching seed` is 0, spread literally cannot
  // happen — the cell selected is in a sparse area where the synthetic graph
  // didn't connect this node to any neighbors.
  const seedEdgeCount = edgesTouchingNode(bestI);
  console.log(
    `[zoom-panel] Ignited seed ${bestI} at (lat=${_microNodes[bestI].lat}, ` +
    `lon=${_microNodes[bestI].lon}). nodes=${_microNodes.length}, ` +
    `edges=${_microEdges.length}, edges touching seed=${seedEdgeCount}`
  );

  // Robust fallback: also force-ignite up to TWO directly-connected
  // neighbors so the user always sees more than one tree burning, even if
  // probabilistic spread rolls poorly. The model is for visualization, not
  // strict realism — this guarantees a visibly progressing simulation.
  let pickedNeighbors = 0;
  for (const e of _microEdges) {
    if (pickedNeighbors >= 2) break;
    let nidx = -1;
    if (e.i === bestI) nidx = e.j;
    else if (e.j === bestI) nidx = e.i;
    else continue;
    if (_microNodes[nidx] && _microNodes[nidx].state === NODE.UNBURNED) {
      _microNodes[nidx].state = NODE.BURNING;
      _microNodes[nidx].burnAge = 0;
      pickedNeighbors++;
    }
  }
  console.log(`[zoom-panel] Auto-ignited ${pickedNeighbors} neighbor(s) of seed.`);

  _fireReached = true;
  if (!_microTimer) startMicroSim();
  if (_igniteBtn) _igniteBtn.style.display = 'none';
}

function setupClickHandler() {
  if (!_canvas) return;
  _canvas.addEventListener('click', (e) => {
    const rect = _canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Reset button takes priority.
    if (_resetBtnRect &&
        x >= _resetBtnRect.x && x <= _resetBtnRect.x + _resetBtnRect.w &&
        y >= _resetBtnRect.y && y <= _resetBtnRect.y + _resetBtnRect.h) {
      resetMicroSim();
      return;
    }

    // Click-to-ignite the closest unburned node within ~16 px. This lets the
    // user trigger the tree-to-tree spread directly without waiting for fire
    // in the main grid to physically arrive at the selected cells — useful
    // when the selection is in a low-fuel area or far from the ignition.
    if (_microNodes.length === 0 || _nodeScreenPositions.length !== _microNodes.length) return;
    let bestI = -1, bestD = 16 * 16;
    for (let i = 0; i < _microNodes.length; i++) {
      if (_microNodes[i].state !== NODE.UNBURNED) continue;
      const p = _nodeScreenPositions[i];
      if (!p) continue;
      const dx = p.x - x, dy = p.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; bestI = i; }
    }
    if (bestI === -1) return;
    _microNodes[bestI].state = NODE.BURNING;
    _microNodes[bestI].burnAge = 0;
    _fireReached = true;
    if (!_microTimer) startMicroSim();
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
