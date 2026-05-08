/**
 * soil-study.js — Dynamic soil study tab.
 *
 * When fire simulation data is available in sharedState, shows:
 *   - Leaflet map with fire spread heatmap overlay + timeline slider
 *   - Pre/post/compare soil property panels driven by actual simulation results
 *
 * Falls back to the Camp Fire 2018 static reference when no simulation data exists.
 */

import { sharedState, addListener, SSURGO_ANCHORS } from './sharedState.js';
import { FIRE } from './fire.js';
import { PATCH_PARAMS, PATCH_TYPES } from './patches.js';
import { runBurnFlowComparison } from './burn-flow-comparison.js';
import { addRun, getRuns, removeRun, provenance as calibProvenance } from './stream-table-calibration.js';

// ═══════════════════════════════════════════════════════════════════════════
// Side-by-side flood renderer
// ═══════════════════════════════════════════════════════════════════════════
//
// Draws a depth field over a patch background into a canvas so the pre- and
// post-fire flood runs can be compared at a glance, not just as Δ numbers.
// Each grid cell becomes one ImageData pixel; the canvas's CSS width then
// scales it up via image-rendering: pixelated.

function _hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

// Pre-fire patch map: each cell colored by its land-cover type. Used in the
// compare view's headline side-by-side maps.
function renderPatchMap(canvas, patchGrid, patchKeys, cols, rows) {
  canvas.width = cols;
  canvas.height = rows;
  canvas.style.imageRendering = 'pixelated';
  canvas.style.aspectRatio = `${cols} / ${rows}`;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cols, rows);
  for (let i = 0; i < cols * rows; i++) {
    const params = PATCH_PARAMS[patchKeys[patchGrid[i]]] || PATCH_PARAMS.grass || { color: '#bdbdbd' };
    const [r, g, b] = _hexToRgb(params.color);
    const p = i * 4;
    img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// Post-fire map: patches faded back, with burn-severity overlay (yellow→red
// gradient) on cells that burned. Black for fully consumed cells.
function renderBurnMap(canvas, patchGrid, patchKeys, sev, cols, rows) {
  canvas.width = cols;
  canvas.height = rows;
  canvas.style.imageRendering = 'pixelated';
  canvas.style.aspectRatio = `${cols} / ${rows}`;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cols, rows);
  for (let i = 0; i < cols * rows; i++) {
    const params = PATCH_PARAMS[patchKeys[patchGrid[i]]] || PATCH_PARAMS.grass || { color: '#bdbdbd' };
    let [r, g, b] = _hexToRgb(params.color);
    // Desaturate base toward gray so burn signal pops.
    const lum = Math.round(r * 0.4 + g * 0.4 + b * 0.4);
    r = Math.round(r * 0.4 + lum * 0.6);
    g = Math.round(g * 0.4 + lum * 0.6);
    b = Math.round(b * 0.4 + lum * 0.6);
    const s = sev[i];
    if (s > 0) {
      // Severity colormap: 0..0.33 yellow, 0.33..0.66 orange, 0.66..1 red→dark
      let cr, cg, cb;
      if (s < 0.33) {
        const t = s / 0.33;
        cr = Math.round(255);                   cg = Math.round(220 - t * 70);  cb = Math.round(60 - t * 60);
      } else if (s < 0.66) {
        const t = (s - 0.33) / 0.33;
        cr = Math.round(255 - t * 30);          cg = Math.round(150 - t * 70);  cb = 0;
      } else {
        const t = (s - 0.66) / 0.34;
        cr = Math.round(225 - t * 165);         cg = Math.round(80 - t * 60);   cb = 0;
      }
      const alpha = Math.min(1, 0.5 + s * 0.5);
      r = Math.round(r * (1 - alpha) + cr * alpha);
      g = Math.round(g * (1 - alpha) + cg * alpha);
      b = Math.round(b * (1 - alpha) + cb * alpha);
    }
    const p = i * 4;
    img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function renderFloodComparison(canvas, depths, patchGrid, patchKeys, cols, rows) {
  // Use the canvas's natural pixel grid (1 cell = 1 pixel) to keep this fast
  // even on dense grids; the canvas's CSS width scales the bitmap up.
  canvas.width = cols;
  canvas.height = rows;
  canvas.style.imageRendering = 'pixelated';
  // Match the bed plane's display aspect.
  canvas.style.aspectRatio = `${cols} / ${rows}`;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cols, rows);

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j;
      const patchIdx = patchGrid ? patchGrid[idx] : 0;
      const params = PATCH_PARAMS[patchKeys[patchIdx]] || PATCH_PARAMS.grass || { color: '#bdbdbd' };
      let [r, g, b] = _hexToRgb(params.color);

      // Blend a blue water tint over the patch where depth > threshold. Same
      // log-scaled alpha as sketch.js's main draw loop, so visual tone matches
      // the live fire/water view in Step 2.
      const h = depths[idx];
      if (h > 0.0005) {
        const alpha = Math.min(1, (120 + Math.log1p(h * 3000) * 42) / 255);
        const wr = 80, wg = 130, wb = 200;
        r = Math.round(r * (1 - alpha) + wr * alpha);
        g = Math.round(g * (1 - alpha) + wg * alpha);
        b = Math.round(b * (1 - alpha) + wb * alpha);
      }

      const p = idx * 4;
      img.data[p]     = r;
      img.data[p + 1] = g;
      img.data[p + 2] = b;
      img.data[p + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants — Camp Fire fallback (static reference data)
// ═══════════════════════════════════════════════════════════════════════════

const PARADISE = [39.7596, -121.6219];
const IGNITION = [39.812, -121.477];

const FIRE_PERIMETER = [
  [39.815,-121.476],[39.850,-121.490],[39.863,-121.527],[39.860,-121.572],
  [39.857,-121.621],[39.840,-121.660],[39.821,-121.681],[39.795,-121.693],
  [39.760,-121.691],[39.720,-121.673],[39.700,-121.645],[39.685,-121.600],
  [39.680,-121.558],[39.690,-121.515],[39.720,-121.485],[39.760,-121.474],
  [39.790,-121.470],[39.815,-121.476],
];

const HIGH_SEVERITY = [
  [39.780,-121.580],[39.795,-121.560],[39.802,-121.595],[39.800,-121.625],
  [39.793,-121.650],[39.775,-121.655],[39.758,-121.642],[39.748,-121.615],
  [39.752,-121.580],[39.765,-121.560],[39.780,-121.580],
];

const STATIC_PRE_FIRE = {
  texture:       { label: 'Texture class',        value: 'Gravelly loam',       color: 'green' },
  organicMatter: { label: 'Organic matter',        value: '3.1%',                color: 'green' },
  infiltration:  { label: 'Infiltration rate',     value: '0.80 in/hr',          color: 'green' },
  erodibility:   { label: 'Erodibility (Kf)',      value: '0.24',                color: 'green' },
  waterCapacity: { label: 'Avail. water capacity', value: '0.15 in/in',          color: 'amber' },
  hydroGroup:    { label: 'Hydrologic group',      value: 'B \u2014 moderate',   color: 'green' },
  hydrophobic:   { label: 'Hydrophobicity',        value: 'None (WDPT >60s)',    color: 'green' },
  debrisFlow:    { label: 'Debris flow risk',      value: 'Low',                 color: 'green' },
};

const STATIC_POST_FIRE = {
  texture:       { label: 'Texture class',        value: 'Gravelly loam *',            note: 'structure destroyed', color: 'red' },
  organicMatter: { label: 'Organic matter',        value: '0.6%',                       color: 'red' },
  infiltration:  { label: 'Infiltration rate',     value: '<0.05 in/hr',                color: 'red' },
  erodibility:   { label: 'Erodibility (Kf)',      value: '>0.50 (est.)',               color: 'red' },
  waterCapacity: { label: 'Avail. water capacity', value: '0.06 in/in',                 color: 'red' },
  hydroGroup:    { label: 'Hydrologic group',      value: 'D \u2014 reclassified',      color: 'red' },
  hydrophobic:   { label: 'Hydrophobicity',        value: 'Strong (WDPT <5s)',          color: 'red' },
  debrisFlow:    { label: 'Debris flow risk',      value: 'Very High',                  color: 'red' },
};

const STATIC_INSIGHTS = {
  pre: 'Cohasset gravelly loam is a well-drained volcanic soil with moderate infiltration. Its B hydrologic group and low erodibility support stable hillslopes under mixed-conifer canopy.',
  post: 'High-severity fire consumed nearly all organic matter, collapsed soil aggregates, and formed a hydrophobic layer at 2\u20135 cm depth. Infiltration dropped by 94%, reclassifying the soil to hydrologic group D and creating extreme debris-flow hazard on the steep Paradise terrain.',
  compare: 'The radar chart shows near-total collapse of soil function across all axes. The most critical shift is infiltration (0.80 \u2192 <0.05 in/hr): water that once percolated now runs off, mobilizing ash and destabilized sediment. Recovery timelines for these volcanic soils are estimated at 5\u201315 years without active restoration.',
};

const STATIC_RADAR_PRE  = [8, 7, 7, 8, 9, 8];
const STATIC_RADAR_POST = [1, 2, 3, 2, 1, 1];

const RADAR_LABELS = ['Infiltration', 'Organic matter', 'Water holding', 'Soil stability', 'Hydrophob.\nresistance', 'Runoff\nresistance'];

const COLOR = {
  green:  { bg: 'rgba(110,190,110,0.12)', fg: '#6ebe6e', border: 'rgba(110,190,110,0.3)' },
  amber:  { bg: 'rgba(220,170,60,0.12)',  fg: '#dcaa3c', border: 'rgba(220,170,60,0.3)' },
  red:    { bg: 'rgba(220,80,60,0.12)',    fg: '#dc503c', border: 'rgba(220,80,60,0.3)' },
};

// Severity color ramp for heatmap
const SEVERITY_RAMP = [
  [0.0,  [30, 80, 30, 0]],       // unburned — transparent
  [0.33, [220, 180, 60, 140]],    // low — amber
  [0.66, [220, 120, 40, 180]],    // moderate — orange
  [1.0,  [200, 50, 30, 220]],     // high — red
];

function severityColor(s) {
  let lo = SEVERITY_RAMP[0], hi = SEVERITY_RAMP[SEVERITY_RAMP.length - 1];
  for (let i = 0; i < SEVERITY_RAMP.length - 1; i++) {
    if (s >= SEVERITY_RAMP[i][0] && s <= SEVERITY_RAMP[i + 1][0]) {
      lo = SEVERITY_RAMP[i]; hi = SEVERITY_RAMP[i + 1]; break;
    }
  }
  const range = hi[0] - lo[0] || 1;
  const t = (s - lo[0]) / range;
  return lo[1].map((v, j) => Math.round(v + (hi[1][j] - v) * t));
}

// ═══════════════════════════════════════════════════════════════════════════
// Module state
// ═══════════════════════════════════════════════════════════════════════════
let _map = null;
let _state = 'pre'; // 'pre' | 'post' | 'compare'
let _legendEl = null;
let _dataPanelEl = null;
let _radarChart = null;
let _toggleBtns = [];
let _hasSimData = false;
let _heatmapLayer = null;
let _patchLayer = null;
let _timelineSlider = null;
let _timelineLabel = null;
let _timelineLayer = null;
let _containerId = null;

// Static-mode layers
let _soilWmsLayer = null;
let _burnModerateLayer = null;
let _burnHighLayer = null;
let _staticPerimeter = null;
let _staticMarkers = [];

// ═══════════════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════════════

export function initSoilStudy(containerId) {
  _containerId = containerId;
  const container = document.getElementById(containerId);
  if (!container) return;

  _hasSimData = !!(sharedState.burnSeverityGrid && sharedState.scenarioPhase === 'fire-complete');

  buildLayout(container);

  // Subscribe to sharedState — rebuild when fire completes
  addListener(() => {
    const nowHasData = !!(sharedState.burnSeverityGrid && sharedState.scenarioPhase === 'fire-complete');
    if (nowHasData !== _hasSimData) {
      _hasSimData = nowHasData;
      rebuildFromState();
    }
  });
}

export function onSoilStudyActivated() {
  if (_map) setTimeout(() => _map.invalidateSize(), 50);
  // Check if sim data arrived while tab was inactive
  const nowHasData = !!(sharedState.burnSeverityGrid && sharedState.scenarioPhase === 'fire-complete');
  if (nowHasData !== _hasSimData) {
    _hasSimData = nowHasData;
    rebuildFromState();
  }
}

function rebuildFromState() {
  const container = document.getElementById(_containerId);
  if (!container) return;
  // Tear down old map to avoid Leaflet reuse errors
  if (_map) { _map.remove(); _map = null; }
  _radarChart = null;
  buildLayout(container);
}

// ═══════════════════════════════════════════════════════════════════════════
// Layout
// ═══════════════════════════════════════════════════════════════════════════

function buildLayout(container) {
  container.innerHTML = '';

  const root = document.createElement('div');
  root.className = 'soil-root';
  container.appendChild(root);

  // ── Map wrapper ──
  const mapWrap = document.createElement('div');
  mapWrap.className = 'soil-map-wrap';
  root.appendChild(mapWrap);

  // Toggle bar
  const toggleBar = document.createElement('div');
  toggleBar.className = 'soil-toggle-bar';
  mapWrap.appendChild(toggleBar);

  const states = ['pre', 'post', 'compare'];
  const stateLabels = ['Pre-fire', 'Post-fire', 'Compare'];
  _toggleBtns = states.map((s, i) => {
    const btn = document.createElement('button');
    btn.textContent = stateLabels[i];
    btn.dataset.state = s;
    btn.className = 'soil-toggle-btn';
    btn.addEventListener('click', () => switchState(s));
    toggleBar.appendChild(btn);
    return btn;
  });

  // Source badge
  const srcBadge = document.createElement('div');
  srcBadge.className = `soil-src-badge ${_hasSimData ? 'live' : 'reference'}`;
  srcBadge.textContent = _hasSimData ? 'LIVE SIMULATION' : 'REFERENCE: Camp Fire 2018';
  mapWrap.appendChild(srcBadge);

  // Map container
  const mapEl = document.createElement('div');
  mapEl.id = 'soil-study-map';
  mapEl.style.cssText = 'width:100%;height:100%;';
  mapWrap.appendChild(mapEl);

  // Legend
  _legendEl = document.createElement('div');
  _legendEl.className = 'soil-legend';
  mapWrap.appendChild(_legendEl);

  // Timeline slider (sim mode only, shown in post/compare)
  if (_hasSimData && sharedState.fireTimeline && sharedState.fireTimeline.length > 0) {
    const sliderWrap = document.createElement('div');
    sliderWrap.id = 'soil-timeline-wrap';
    sliderWrap.className = 'soil-timeline-wrap';

    _timelineLabel = document.createElement('span');
    _timelineLabel.className = 'soil-timeline-label';
    _timelineLabel.textContent = 'Tick 0';

    _timelineSlider = document.createElement('input');
    _timelineSlider.type = 'range';
    _timelineSlider.min = '0';
    _timelineSlider.max = String(sharedState.fireTimeline.length - 1);
    _timelineSlider.value = String(sharedState.fireTimeline.length - 1);
    _timelineSlider.className = 'soil-timeline-slider';
    _timelineSlider.addEventListener('input', () => onTimelineChange(+_timelineSlider.value));

    const timelineTitle = document.createElement('span');
    timelineTitle.className = 'soil-timeline-title';
    timelineTitle.textContent = 'Fire spread';

    sliderWrap.appendChild(timelineTitle);
    sliderWrap.appendChild(_timelineSlider);
    sliderWrap.appendChild(_timelineLabel);
    mapWrap.appendChild(sliderWrap);
  }

  // ── Resizer between map and data panel ──
  // Drag the vertical bar to make the right panel wider — useful when both
  // pre/post soil tables and the side-by-side flood maps are showing and 340 px
  // feels cramped. Width is clamped and persisted to localStorage.
  const resizer = document.createElement('div');
  resizer.className = 'soil-resizer';
  resizer.title = 'Drag to resize';
  root.appendChild(resizer);

  // ── Data panel ──
  _dataPanelEl = document.createElement('div');
  _dataPanelEl.className = 'soil-data-panel';
  root.appendChild(_dataPanelEl);

  // Restore previous width if saved.
  const savedWidth = parseInt(localStorage.getItem('soil-data-panel-width') || '0', 10);
  if (savedWidth >= 280 && savedWidth <= window.innerWidth * 0.75) {
    _dataPanelEl.style.width = savedWidth + 'px';
    _dataPanelEl.style.minWidth = savedWidth + 'px';
  }

  // Drag-to-resize. Mousedown on the bar enters drag mode; mousemove updates
  // the panel width; mouseup leaves drag mode and persists. We invalidate the
  // Leaflet map size after release so it redraws at the new dimensions.
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newWidth = window.innerWidth - e.clientX;
    const clamped = Math.max(280, Math.min(Math.round(window.innerWidth * 0.75), newWidth));
    _dataPanelEl.style.width = clamped + 'px';
    _dataPanelEl.style.minWidth = clamped + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (_map && _map.invalidateSize) _map.invalidateSize();
    const w = parseInt(_dataPanelEl.style.width || '0', 10);
    if (w > 0) localStorage.setItem('soil-data-panel-width', String(w));
  });

  // ── Init Leaflet map ──
  initMap(mapEl);

  // Tooltip marker styles are in styles.css

  // Set initial state
  switchState('pre');
}

// ═══════════════════════════════════════════════════════════════════════════
// Map initialization
// ═══════════════════════════════════════════════════════════════════════════

function initMap(mapEl) {
  if (_hasSimData) {
    initSimMap(mapEl);
  } else {
    initStaticMap(mapEl);
  }
}

function initStaticMap(mapEl) {
  _map = L.map(mapEl, { zoomControl: false }).setView(PARADISE, 12);
  L.control.zoom({ position: 'topright' }).addTo(_map);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd', maxZoom: 19,
  }).addTo(_map);

  _staticPerimeter = L.polygon(FIRE_PERIMETER, {
    color: '#dc3c3c', weight: 2, dashArray: '8,5',
    fillColor: '#dc3c3c', fillOpacity: 0.04,
  }).addTo(_map);

  const m1 = L.marker(PARADISE).addTo(_map).bindTooltip('Paradise', {
    permanent: true, direction: 'top', className: 'soil-marker-tip', offset: [0, -8],
  });
  const m2 = L.marker(IGNITION, {
    icon: L.divIcon({
      className: '', iconSize: [10, 10],
      html: '<div style="width:10px;height:10px;border-radius:50%;background:#ff6633;border:2px solid #fff;"></div>',
    }),
  }).addTo(_map).bindTooltip('Pulga (ignition)', {
    permanent: true, direction: 'right', className: 'soil-marker-tip', offset: [8, 0],
  });
  _staticMarkers = [m1, m2];

  _soilWmsLayer = L.tileLayer.wms('https://SDMDataAccess.sc.egov.usda.gov/Spatial/SDM.wms', {
    layers: 'MapunitPoly', format: 'image/png',
    transparent: true, opacity: 0.55, version: '1.1.1',
  });
  _burnModerateLayer = L.polygon(FIRE_PERIMETER, {
    color: 'transparent', fillColor: '#d4a030', fillOpacity: 0.25,
  });
  _burnHighLayer = L.polygon(HIGH_SEVERITY, {
    color: 'transparent', fillColor: '#cc3322', fillOpacity: 0.45,
  });
}

function initSimMap(mapEl) {
  const bounds = sharedState.geoBounds;
  const cols = sharedState.cols;
  const rows = sharedState.rows;

  // Determine center and zoom
  let center, zoom;
  if (bounds) {
    center = [(bounds.south + bounds.north) / 2, (bounds.west + bounds.east) / 2];
    zoom = 14;
  } else {
    // Synthetic grid — use abstract coordinates
    center = [rows / 2, cols / 2];
    zoom = 6;
  }

  _map = L.map(mapEl, {
    zoomControl: false,
    crs: bounds ? L.CRS.EPSG3857 : L.CRS.Simple,
  }).setView(center, zoom);
  L.control.zoom({ position: 'topright' }).addTo(_map);

  if (bounds) {
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd', maxZoom: 19,
    }).addTo(_map);

    // SSURGO WMS soil polygons for pre-fire view
    _soilWmsLayer = L.tileLayer.wms('https://SDMDataAccess.sc.egov.usda.gov/Spatial/SDM.wms', {
      layers: 'MapunitPoly', format: 'image/png',
      transparent: true, opacity: 0.45, version: '1.1.1',
    });
  }

  // Build the burn severity heatmap as a canvas overlay
  buildHeatmapOverlay(sharedState.burnSeverityGrid, cols, rows, bounds);

  // Build the pre-fire patch grid overlay (NLCD-derived patch types)
  if (sharedState.patchGridSnapshot) {
    buildPatchOverlay(sharedState.patchGridSnapshot, cols, rows, bounds);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Heatmap overlay — renders burn severity grid on Leaflet
// ═══════════════════════════════════════════════════════════════════════════

function buildHeatmapOverlay(severityGrid, cols, rows, geoBounds) {
  if (!severityGrid || !_map) return;

  // Create an image from severity grid
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(cols, rows);

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j;
      const s = severityGrid[idx];
      const [r, g, b, a] = severityColor(s);
      const px = idx * 4;
      imgData.data[px] = r;
      imgData.data[px + 1] = g;
      imgData.data[px + 2] = b;
      imgData.data[px + 3] = a;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  const imageBounds = geoBounds
    ? [[geoBounds.south, geoBounds.west], [geoBounds.north, geoBounds.east]]
    : [[0, 0], [rows, cols]];

  if (_heatmapLayer) _map.removeLayer(_heatmapLayer);
  _heatmapLayer = L.imageOverlay(canvas.toDataURL(), imageBounds, {
    opacity: 0.75,
    interactive: false,
  }).addTo(_map);

  if (geoBounds) {
    _map.fitBounds(imageBounds, { padding: [20, 20] });
  } else {
    _map.fitBounds(imageBounds);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Patch overlay — renders pre-fire patch grid (NLCD-derived) on Leaflet
// ═══════════════════════════════════════════════════════════════════════════

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function buildPatchOverlay(patchGrid, cols, rows, geoBounds) {
  if (!patchGrid || !_map) return;

  const patchKeys = Object.keys(PATCH_PARAMS);
  const colorCache = patchKeys.map(k => hexToRgb(PATCH_PARAMS[k].color));

  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(cols, rows);

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j;
      const patchIdx = patchGrid[idx];
      const rgb = colorCache[patchIdx] || [200, 200, 200];
      const px = idx * 4;
      imgData.data[px]     = rgb[0];
      imgData.data[px + 1] = rgb[1];
      imgData.data[px + 2] = rgb[2];
      imgData.data[px + 3] = 200;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  const imageBounds = geoBounds
    ? [[geoBounds.south, geoBounds.west], [geoBounds.north, geoBounds.east]]
    : [[0, 0], [rows, cols]];

  if (_patchLayer) _map.removeLayer(_patchLayer);
  _patchLayer = L.imageOverlay(canvas.toDataURL(), imageBounds, {
    opacity: 0.7,
    interactive: false,
  });
}

function buildTimelineOverlay(tickIdx) {
  const timeline = sharedState.fireTimeline;
  if (!timeline || tickIdx < 0 || tickIdx >= timeline.length) return;

  const cols = sharedState.cols;
  const rows = sharedState.rows;
  const snapshot = timeline[tickIdx];
  const geoBounds = sharedState.geoBounds;

  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(cols, rows);

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j;
      const cellState = snapshot.cell[idx];
      const px = idx * 4;
      if (cellState === FIRE.BURNING) {
        imgData.data[px] = 255; imgData.data[px+1] = 120; imgData.data[px+2] = 30; imgData.data[px+3] = 230;
      } else if (cellState === FIRE.BURNED) {
        imgData.data[px] = 80; imgData.data[px+1] = 40; imgData.data[px+2] = 25; imgData.data[px+3] = 180;
      } else {
        imgData.data[px+3] = 0;
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);

  const imageBounds = geoBounds
    ? [[geoBounds.south, geoBounds.west], [geoBounds.north, geoBounds.east]]
    : [[0, 0], [rows, cols]];

  if (_timelineLayer) _map.removeLayer(_timelineLayer);
  _timelineLayer = L.imageOverlay(canvas.toDataURL(), imageBounds, {
    opacity: 0.85, interactive: false,
  }).addTo(_map);
}

function onTimelineChange(tickIdx) {
  if (_timelineLabel) {
    const timeline = sharedState.fireTimeline;
    _timelineLabel.textContent = `Tick ${timeline[tickIdx].tick}`;
  }
  buildTimelineOverlay(tickIdx);
}

// ═══════════════════════════════════════════════════════════════════════════
// State switching
// ═══════════════════════════════════════════════════════════════════════════

function switchState(s) {
  _state = s;

  _toggleBtns.forEach(btn => {
    const active = btn.dataset.state === s;
    btn.classList.toggle('active', active);
  });

  // Timeline slider visibility
  const sliderWrap = document.getElementById('soil-timeline-wrap');
  if (sliderWrap) {
    sliderWrap.style.display = (s === 'post' || s === 'compare') ? 'flex' : 'none';
  }

  if (_hasSimData) {
    switchSimLayers(s);
  } else {
    switchStaticLayers(s);
  }

  renderLegend();
  renderDataPanel();
}

function switchStaticLayers(s) {
  if (_soilWmsLayer) {
    if (s === 'pre') _soilWmsLayer.addTo(_map);
    else _map.removeLayer(_soilWmsLayer);
  }
  if (_burnModerateLayer) {
    if (s === 'post' || s === 'compare') _burnModerateLayer.addTo(_map);
    else _map.removeLayer(_burnModerateLayer);
  }
  if (_burnHighLayer) {
    if (s === 'post' || s === 'compare') _burnHighLayer.addTo(_map);
    else _map.removeLayer(_burnHighLayer);
  }
}

function switchSimLayers(s) {
  if (s === 'pre') {
    // Hide heatmap, show patch grid + soil polygons
    if (_heatmapLayer) _heatmapLayer.setOpacity(0);
    if (_timelineLayer) _map.removeLayer(_timelineLayer);
    if (_patchLayer) _patchLayer.addTo(_map);
    if (_soilWmsLayer) _soilWmsLayer.addTo(_map);
  } else {
    // Show heatmap, hide patch grid + soil polygons
    if (_heatmapLayer) _heatmapLayer.setOpacity(0.75);
    if (_patchLayer) _map.removeLayer(_patchLayer);
    if (_soilWmsLayer) _map.removeLayer(_soilWmsLayer);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Legend
// ═══════════════════════════════════════════════════════════════════════════

function renderLegend() {
  if (!_legendEl) return;

  if (_hasSimData) {
    renderSimLegend();
  } else {
    renderStaticLegend();
  }
}

function renderStaticLegend() {
  let html = '';
  if (_state === 'pre') {
    html = `
      ${swatch('#dc3c3c', 'dashed')} Fire perimeter (2018)<br>
      ${swatch('rgba(180,160,120,0.5)', 'solid')} SSURGO soil polygons<br>
      <span style="color:#888;font-size:9px;">USDA Web Soil Survey WMS</span>
    `;
  } else if (_state === 'post') {
    html = `
      ${swatch('#dc3c3c', 'dashed')} Fire perimeter<br>
      ${swatch('#d4a030', 'solid')} Moderate burn severity<br>
      ${swatch('#cc3322', 'solid')} High burn severity<br>
      <span style="color:#888;font-size:9px;">USFS BAER assessment 2018</span>
    `;
  } else {
    html = `
      ${swatch('#dc3c3c', 'dashed')} Fire perimeter<br>
      ${swatch('#d4a030', 'solid')} Moderate severity<br>
      ${swatch('#cc3322', 'solid')} High severity<br>
      <span style="color:#888;font-size:9px;">Pre/post comparison active</span>
    `;
  }
  _legendEl.innerHTML = html;
}

function renderSimLegend() {
  const hasReal = !!sharedState.ssurgoData;
  let html = '';
  if (_state === 'pre') {
    const present = patchTypesPresent();
    const patchSwatches = present.length
      ? present.map(p => `${swatch(PATCH_PARAMS[p].color, 'solid')} ${PATCH_PARAMS[p].name}`).join('<br>')
      : `${swatch('#6ebe6e', 'solid')} Unburned terrain`;
    html = `
      <div style="font-weight:600;margin-bottom:4px;">Pre-fire landscape (NLCD patches)</div>
      ${patchSwatches}<br>
      ${sharedState.geoBounds ? swatch('rgba(180,160,120,0.5)', 'solid') + ' SSURGO soil polygons<br>' : ''}
      <span style="color:#888;font-size:9px;">${hasReal ? 'Real SSURGO data from site' : 'SSURGO baseline properties'}</span>
    `;
  } else {
    html = `
      <div style="font-weight:600;margin-bottom:4px;">Burn severity</div>
      ${gradientBar()}<br>
      <span style="color:#888;font-size:9px;">Derived from fire simulation age</span>
    `;
    if (_state === 'compare' && sharedState.fireTimeline) {
      html += `<br><span style="color:#888;font-size:9px;">Use timeline slider to replay spread</span>`;
    }
  }
  _legendEl.innerHTML = html;
}

function patchTypesPresent() {
  const grid = sharedState.patchGridSnapshot;
  if (!grid) return [];
  const patchKeys = Object.keys(PATCH_PARAMS);
  const counts = new Array(patchKeys.length).fill(0);
  for (let i = 0; i < grid.length; i++) counts[grid[i]]++;
  const indexed = counts.map((c, i) => ({ i, c, key: patchKeys[i] }));
  indexed.sort((a, b) => b.c - a.c);
  return indexed.filter(x => x.c > 0).slice(0, 4).map(x => x.key);
}

function gradientBar() {
  return `
    <div style="display:flex;align-items:center;gap:6px;margin:3px 0;">
      <span style="font-size:9px;color:#999;">Low</span>
      <div style="flex:1;height:10px;border-radius:3px;
        background:linear-gradient(to right, #dcb43c, #dc7828, #c83320);"></div>
      <span style="font-size:9px;color:#999;">High</span>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// Data panel
// ═══════════════════════════════════════════════════════════════════════════

function renderDataPanel() {
  if (!_dataPanelEl) return;
  if (_hasSimData) {
    renderSimDataPanel();
  } else {
    renderStaticDataPanel();
  }
}

// ── Static (Camp Fire reference) ──

function renderStaticDataPanel() {
  if (_state === 'pre') {
    let html = panelTitle('Pre-fire soil properties', 'Cohasset gravelly loam \u2014 SSURGO');
    html += propsTable(STATIC_PRE_FIRE);
    html += source('USDA NRCS SSURGO \u00B7 Butte County CA \u00B7 Survey area 10-CA013');
    html += insight(STATIC_INSIGHTS.pre);
    _dataPanelEl.innerHTML = html;
  } else if (_state === 'post') {
    let html = panelTitle('Post-fire soil properties', 'High-severity burn zone \u2014 BAER 2018');
    html += propsTable(STATIC_POST_FIRE);
    html += severityBar(41, 34, 25);
    html += source('USFS BAER assessment \u00B7 Camp Fire 2018');
    html += insight(STATIC_INSIGHTS.post);
    _dataPanelEl.innerHTML = html;
  } else {
    let html = panelTitle('Pre/post comparison', 'Camp Fire 2018 \u2014 High-severity zone');
    html += `<canvas id="soil-radar-canvas" width="280" height="240" style="display:block;margin:8px auto 12px;"></canvas>`;
    html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">`;
    html += metricCard('Infiltration rate', '0.80', '<0.05', 'in/hr', '\u2193 94%');
    html += metricCard('Organic matter', '3.1%', '0.6%', '', '\u2193 81%');
    html += metricCard('Water capacity', '0.15', '0.06', 'in/in', '\u2193 60%');
    html += metricCard('Hydrologic group', 'B', 'D', '', 'reclassified');
    html += `</div>`;
    html += source('USDA SSURGO + USFS BAER 2018');
    html += insight(STATIC_INSIGHTS.compare);
    _dataPanelEl.innerHTML = html;
    buildRadarChart(STATIC_RADAR_PRE, STATIC_RADAR_POST);
  }
}

// ── Dynamic (simulation results) ──

/**
 * Get the pre-fire baseline: use real SSURGO data if available,
 * otherwise fall back to the hardcoded anchor.
 */
function getPreFireBaseline() {
  const real = sharedState.ssurgoData;
  if (real) {
    return {
      infiltrationRate: real.infiltrationRate,
      organicMatter:    real.organicMatter,
      kFactor:          real.kfact,
      hydrologicGroup:  real.hydgrp,
      cohesion:         estimateCohesion(real),
      frictionAngle:    estimateFrictionAngle(real),
      // Extra fields from real data
      texdesc:          real.texdesc,
      muname:           real.muname,
      compname:         real.compname,
      awc:              real.awc,
      slope:            real.slope,
      sand:             real.sand,
      clay:             real.clay,
      silt:             real.silt,
      bulkDensity:      real.bulkDensity,
      _isReal:          true,
    };
  }
  return { ...SSURGO_ANCHORS[0], _isReal: false };
}

/** Estimate cohesion from texture (kPa). Clay-rich soils are more cohesive. */
function estimateCohesion(ssurgo) {
  if (!ssurgo.clay) return 8.0;
  if (ssurgo.clay >= 40) return 12.0;
  if (ssurgo.clay >= 25) return 8.0;
  if (ssurgo.clay >= 10) return 5.0;
  return 2.0; // sandy
}

/** Estimate friction angle from texture (degrees). Sandy soils have higher friction. */
function estimateFrictionAngle(ssurgo) {
  if (!ssurgo.sand) return 32;
  if (ssurgo.sand >= 70) return 36;
  if (ssurgo.sand >= 50) return 33;
  if (ssurgo.sand >= 30) return 30;
  return 28; // clay-rich
}

function renderSimDataPanel() {
  const pre = getPreFireBaseline();
  const stats = computeSimStats();
  const realLabel = pre._isReal
    ? `${pre.compname} \u2014 ${pre.muname}`
    : 'SSURGO anchor \u2014 severity 0.0';
  const realSource = pre._isReal
    ? `USDA SSURGO \u00B7 ${pre.muname}`
    : 'SSURGO lookup table \u00B7 pre-fire baseline';

  if (_state === 'pre') {
    let html = panelTitle('Pre-fire soil properties', realLabel);
    html += propsTable(buildPreFireProps(pre));
    if (pre._isReal) {
      html += textureBar(pre);
      html += soilDetails(pre);
    }
    html += patchComposition();
    html += source(realSource);
    html += insight(generatePreInsight(pre));
    _dataPanelEl.innerHTML = html;
  } else if (_state === 'post') {
    let html = panelTitle('Post-fire soil properties', `Mean severity: ${stats.meanSeverity.toFixed(2)}`);
    html += propsTable(buildPostFireProps(pre, stats));
    html += severityBar(stats.pctHigh, stats.pctModerate, stats.pctLow);
    html += burnSummary(stats);
    html += source(`Degraded from ${pre._isReal ? 'site SSURGO' : 'baseline'} via burn severity`);
    html += insight(generatePostInsight(stats, pre));
    _dataPanelEl.innerHTML = html;
  } else {
    const postSoil = degradeSoil(pre, stats.meanSeverity);
    let html = panelTitle('Pre/post comparison', `Simulation results \u2014 ${stats.burnedPct.toFixed(0)}% burned`);

    // Side-by-side maps: pre-fire patch composition on the left, the same
    // parcel with the burn-severity overlay on the right. Renders the same
    // patchGrid + burnSeverityGrid the rest of the compare uses, so the two
    // visualizations are guaranteed to be the same parcel.
    if (sharedState.patchGridSnapshot && sharedState.burnSeverityGrid &&
        sharedState.cols && sharedState.rows) {
      html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
        <div>
          <div style="font-size:9.5px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#666;margin-bottom:4px;">Pre-fire \u00b7 land cover</div>
          <canvas id="ss-map-pre" style="width:100%;display:block;border:1px solid #e5e5e5;border-radius:4px;background:#fafafa;"></canvas>
        </div>
        <div>
          <div style="font-size:9.5px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#c05030;margin-bottom:4px;">Post-fire \u00b7 burn severity</div>
          <canvas id="ss-map-post" style="width:100%;display:block;border:1px solid #f0d0c4;border-radius:4px;background:#fafafa;"></canvas>
        </div>
      </div>`;
    }

    // Side-by-side full soil panels \u2014 pre-fire baseline on the left, the same
    // soil after burn-severity degradation on the right. This replaces the
    // previous compare-only metric grid as the headline view, so the user can
    // read the full property tables in parallel and then run the same flood
    // model on each below.
    const preLabel = pre._isReal
      ? `${pre.compname} \u2014 ${pre.muname}`
      : 'SSURGO baseline';
    const postLabel = `Mean severity ${stats.meanSeverity.toFixed(2)}`;
    html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">`;
    html += `<div style="border:1px solid #e5e5e5;border-radius:6px;padding:10px;background:#fafafa;">`;
    html += `<div style="font-size:9.5px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#666;margin-bottom:6px;">Pre-fire \u00b7 ${preLabel}</div>`;
    html += propsTable(buildPreFireProps(pre));
    html += `</div>`;
    html += `<div style="border:1px solid #f0d0c4;border-radius:6px;padding:10px;background:#fff5f0;">`;
    html += `<div style="font-size:9.5px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#c05030;margin-bottom:6px;">Post-fire \u00b7 ${postLabel}</div>`;
    html += propsTable(buildPostFireProps(pre, stats));
    html += `</div>`;
    html += `</div>`;

    html += `<canvas id="soil-radar-canvas" width="280" height="240" style="display:block;margin:8px auto 12px;"></canvas>`;

    // Dynamic metric cards
    const infDrop = ((1 - postSoil.infiltrationRate / pre.infiltrationRate) * 100).toFixed(0);
    const omDrop = ((1 - postSoil.organicMatter / pre.organicMatter) * 100).toFixed(0);
    const kInc = ((postSoil.kFactor / pre.kFactor - 1) * 100).toFixed(0);

    html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">`;
    html += metricCard('Infiltration rate', pre.infiltrationRate.toFixed(1), postSoil.infiltrationRate.toFixed(1), 'mm/hr', `\u2193 ${infDrop}%`);
    html += metricCard('Organic matter', pre.organicMatter.toFixed(1) + '%', postSoil.organicMatter.toFixed(1) + '%', '', `\u2193 ${omDrop}%`);
    html += metricCard('Erodibility (Kf)', pre.kFactor.toFixed(2), postSoil.kFactor.toFixed(2), '', `\u2191 ${kInc}%`);
    html += metricCard('Hydrologic group', pre.hydrologicGroup, postSoil.hydrologicGroup, '', pre.hydrologicGroup !== postSoil.hydrologicGroup ? 'reclassified' : 'unchanged');
    html += `</div>`;

    if (pre._isReal) {
      html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">`;
      html += metricCard('Cohesion', pre.cohesion.toFixed(1) + ' kPa', postSoil.cohesion.toFixed(1) + ' kPa', '', `\u2193 ${((1 - postSoil.cohesion / pre.cohesion) * 100).toFixed(0)}%`);
      html += metricCard('Avail. water cap.', (pre.awc || 0).toFixed(2), (postSoil.awc || 0).toFixed(2), 'cm/cm', `\u2193 ${((1 - (postSoil.awc || 0) / (pre.awc || 1)) * 100).toFixed(0)}%`);
      html += `</div>`;
    }

    html += severityBar(stats.pctHigh, stats.pctModerate, stats.pctLow);
    html += source(pre._isReal ? `${pre.muname} \u2014 SSURGO + fire simulation` : 'SSURGO interpolation from simulated burn severity');
    html += insight(generateCompareInsight(pre, postSoil, stats));
    html += flowBridgeBlock();
    _dataPanelEl.innerHTML = html;

    // Build radar with dynamic values
    const preRadar = soilToRadarFromBaseline(pre, pre);
    const postRadar = soilToRadarFromBaseline(postSoil, pre);
    buildRadarChart(preRadar, postRadar);

    // Render the two side-by-side mini-maps (pre = patch composition, post =
    // patches faded under a burn-severity overlay). Both share the same grid.
    const preMap  = document.getElementById('ss-map-pre');
    const postMap = document.getElementById('ss-map-post');
    if (preMap && postMap && sharedState.patchGridSnapshot && sharedState.burnSeverityGrid) {
      const keysList = Object.keys(PATCH_PARAMS);
      renderPatchMap(preMap, sharedState.patchGridSnapshot, keysList,
                     sharedState.cols, sharedState.rows);
      renderBurnMap(postMap, sharedState.patchGridSnapshot, keysList,
                    sharedState.burnSeverityGrid, sharedState.cols, sharedState.rows);
    }

    wireFlowBridge();
  }
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// Flow bridge \u2014 pre/post-fire flow comparison
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

function flowBridgeBlock() {
  const have = {
    patchGrid: !!sharedState.patchGridSnapshot,
    elevations: !!sharedState.elevationSnapshot,
    severity: !!sharedState.burnSeverityGrid,
  };
  const ready = have.patchGrid && have.elevations && have.severity;
  const missing = Object.entries(have).filter(([, v]) => !v).map(([k]) => k);

  const status = ready
    ? `<span style="color:#4a8a4a;">snapshots ready</span>`
    : `<span style="color:#c05030;">missing: ${missing.join(', ')}</span> \u2014 complete a fire run from Step 2 first`;

  const prov = calibProvenance();
  const runs = getRuns();
  const provLine = prov.source === 'literature'
    ? `<span style="color:#888;">curve: literature constants (no calibration runs yet)</span>`
    : `<span style="color:#4a8a4a;">curve: calibrated from ${prov.n} stream-table run${prov.n > 1 ? 's' : ''}</span>`;

  const runRows = runs.map(r => `
    <tr>
      <td style="padding:2px 6px;font-family:monospace;">${r.label}</td>
      <td style="padding:2px 6px;text-align:right;">${r.severity.toFixed(2)}</td>
      <td style="padding:2px 6px;text-align:right;">${r.infiltrationFactor.toFixed(2)}</td>
      <td style="padding:2px 6px;text-align:right;">${r.roughnessFactor.toFixed(2)}</td>
      <td style="padding:2px 6px;text-align:right;">${r.d50_mm != null ? r.d50_mm + ' mm' : '\u2014'}</td>
      <td style="padding:2px 6px;text-align:right;"><button data-rm="${r.ts}" style="border:0;background:transparent;color:#c05030;cursor:pointer;font-size:11px;">\u00d7</button></td>
    </tr>
  `).join('');

  const calibrationTable = runs.length ? `
    <table style="width:100%;font-size:11px;color:#444;margin-top:6px;border-collapse:collapse;">
      <thead><tr style="border-bottom:1px solid #e5e5e5;color:#888;">
        <th style="text-align:left;padding:2px 6px;">label</th>
        <th style="text-align:right;padding:2px 6px;">severity</th>
        <th style="text-align:right;padding:2px 6px;">infil \u00d7</th>
        <th style="text-align:right;padding:2px 6px;">rough \u00d7</th>
        <th style="text-align:right;padding:2px 6px;">d50</th>
        <th></th>
      </tr></thead>
      <tbody>${runRows}</tbody>
    </table>
  ` : '';

  return `
    <div class="ss-bridge" style="margin-top:18px;padding:14px;border:1px solid #e5e5e5;border-radius:6px;background:#fafafa;">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#c05030;margin-bottom:6px;">Flow bridge \u2014 pre/post-fire</div>
      <div style="font-size:12px;color:#555;line-height:1.5;margin-bottom:8px;">
        Re-runs overland flow under burn perturbation. Per-cell infiltration and Manning's n
        are scaled by a curve over burn severity. The curve is either literature-grounded
        (defaults: <strong>1 \u2212 0.70\u00b7s</strong> and <strong>1 \u2212 0.15\u00b7s</strong>) or calibrated
        from stream-table runs logged below.
        Reports \u0394 of the water-side percolation order parameter \u03c6<sub>w</sub> after a short storm.
      </div>
      <div style="font-size:11px;color:#666;margin-bottom:6px;">${status}</div>
      <div style="font-size:11px;margin-bottom:10px;">${provLine}</div>

      <button id="ss-bridge-run" ${ready ? '' : 'disabled'} style="padding:6px 12px;font-size:11px;font-weight:500;letter-spacing:0.04em;text-transform:uppercase;background:${ready ? '#1a1a1a' : '#bbb'};color:#fff;border:1px solid ${ready ? '#1a1a1a' : '#bbb'};border-radius:4px;cursor:${ready ? 'pointer' : 'not-allowed'};font-family:inherit;">Run pre/post comparison</button>
      <div id="ss-bridge-results" style="margin-top:12px;font-size:12px;color:#1a1a1a;"></div>

      <details style="margin-top:14px;">
        <summary style="cursor:pointer;font-size:11px;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;color:#666;">Stream-table calibration (${runs.length})</summary>
        <div style="margin-top:8px;font-size:11px;color:#666;line-height:1.5;">
          Log a stream-table run to anchor the perturbation curve. <em>Severity</em> is the
          burn-severity-equivalent you assign to the run (0 = unburned analog, 1 = high-severity analog);
          <em>infil \u00d7</em> and <em>rough \u00d7</em> are the corresponding factors you observed
          (e.g. relative channel coverage shift). Optional: dominant grain size in mm.
        </div>
        ${calibrationTable}
        <div style="display:grid;grid-template-columns:repeat(4,1fr) auto;gap:6px;margin-top:8px;align-items:end;">
          <div><label style="font-size:10px;color:#888;display:block;">Label</label><input id="cal-label" type="text" placeholder="run-1" style="width:100%;padding:4px 6px;font-size:11px;border:1px solid #ddd;border-radius:4px;font-family:inherit;"></div>
          <div><label style="font-size:10px;color:#888;display:block;">Severity (0\u20131)</label><input id="cal-severity" type="number" min="0" max="1" step="0.01" placeholder="0.7" style="width:100%;padding:4px 6px;font-size:11px;border:1px solid #ddd;border-radius:4px;font-family:inherit;"></div>
          <div><label style="font-size:10px;color:#888;display:block;">Infil \u00d7 (0\u20131)</label><input id="cal-infil" type="number" min="0.05" max="1.5" step="0.01" placeholder="0.35" style="width:100%;padding:4px 6px;font-size:11px;border:1px solid #ddd;border-radius:4px;font-family:inherit;"></div>
          <div><label style="font-size:10px;color:#888;display:block;">Rough \u00d7 (0\u20131)</label><input id="cal-rough" type="number" min="0.5" max="1.5" step="0.01" placeholder="0.85" style="width:100%;padding:4px 6px;font-size:11px;border:1px solid #ddd;border-radius:4px;font-family:inherit;"></div>
          <button id="cal-add" style="padding:5px 10px;font-size:11px;font-weight:500;letter-spacing:0.04em;background:#fff;border:1px solid #1a1a1a;color:#1a1a1a;border-radius:4px;cursor:pointer;font-family:inherit;">Add</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr auto;gap:6px;margin-top:6px;align-items:end;">
          <div><label style="font-size:10px;color:#888;display:block;">d50 mm (optional)</label><input id="cal-d50" type="number" min="0.1" max="5" step="0.1" placeholder="0.7" style="width:100%;padding:4px 6px;font-size:11px;border:1px solid #ddd;border-radius:4px;font-family:inherit;"></div>
          <div style="font-size:10px;color:#888;line-height:1.4;">Recorded for provenance only;<br>not used by the curve.</div>
        </div>
      </details>
    </div>
  `;
}

function wireFlowBridge() {
  // Calibration: add a run
  const addBtn = document.getElementById('cal-add');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const sev = parseFloat(document.getElementById('cal-severity').value);
      const inf = parseFloat(document.getElementById('cal-infil').value);
      const rou = parseFloat(document.getElementById('cal-rough').value);
      if (!Number.isFinite(sev) || !Number.isFinite(inf) || !Number.isFinite(rou)) return;
      const d50raw = parseFloat(document.getElementById('cal-d50').value);
      const label = document.getElementById('cal-label').value.trim() || undefined;
      addRun({
        severity: sev, infiltrationFactor: inf, roughnessFactor: rou,
        d50_mm: Number.isFinite(d50raw) ? d50raw : null, label,
      });
      renderDataPanel(); // re-render to show the new row + updated provenance
    });
  }

  // Calibration: remove a run
  document.querySelectorAll('[data-rm]').forEach(b => {
    b.addEventListener('click', () => {
      const ts = Number(b.dataset.rm);
      if (Number.isFinite(ts)) { removeRun(ts); renderDataPanel(); }
    });
  });

  const btn = document.getElementById('ss-bridge-run');
  if (!btn || btn.disabled) return;
  btn.addEventListener('click', async () => {
    const results = document.getElementById('ss-bridge-results');
    btn.disabled = true;
    btn.textContent = 'Running...';
    if (results) results.innerHTML = '';
    await new Promise(r => setTimeout(r, 30));

    console.log('[burn-bridge] starting comparison', {
      cols: sharedState.cols,
      rows: sharedState.rows,
      patchGrid: sharedState.patchGridSnapshot?.length,
      elevations: sharedState.elevationSnapshot?.length,
      severity: sharedState.burnSeverityGrid?.length,
    });

    try {
      const out = runBurnFlowComparison({
        patchGrid: sharedState.patchGridSnapshot,
        elevations: sharedState.elevationSnapshot,
        severityGrid: sharedState.burnSeverityGrid,
        patchParams: PATCH_PARAMS,
        patchKeys: Object.keys(PATCH_PARAMS),
        cols: sharedState.cols,
        rows: sharedState.rows,
      });

      const dPhi = out.deltaPhi;
      const ddmm = (out.meanDepthPerturbed - out.meanDepthVanilla) * 1000;
      const sign = (x) => (x >= 0 ? '+' : '');
      console.log('[burn-bridge] result', out);

      const verdict = dPhi > 0.02
        ? 'Burn perturbation pushed water-side connectivity forward \u2014 channels span more of the parcel post-fire.'
        : dPhi < -0.02
        ? 'Counter-intuitive: \u03c6_w decreased. Worth checking elevations / rainfall settings.'
        : 'Marginal \u0394\u03c6_w \u2014 perturbation effect within noise for this run.';

      const provLabel = out.curveProvenance.source === 'literature'
        ? 'literature constants'
        : `calibrated from ${out.curveProvenance.n} stream-table run${out.curveProvenance.n > 1 ? 's' : ''}`;
      if (results) {
        results.innerHTML = `
          <!-- Side-by-side depth-field comparison. Each canvas renders patches
               (NLCD-derived colors) under a blue water-depth overlay so you can
               see WHERE the post-fire run accumulates more standing water, not
               just the aggregate \u0394 numbers. -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
            <div>
              <div style="font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#666;margin-bottom:4px;">Pre-fire flood</div>
              <canvas id="ss-flood-pre" style="width:100%;display:block;border:1px solid #e5e5e5;border-radius:4px;background:#fafafa;"></canvas>
              <div style="font-size:10.5px;color:#888;margin-top:4px;">\u03c6<sub>w</sub> ${out.phiVanilla.toFixed(3)} \u00b7 mean depth ${(out.meanDepthVanilla*1000).toFixed(2)} mm</div>
            </div>
            <div>
              <div style="font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#c05030;margin-bottom:4px;">Post-fire flood</div>
              <canvas id="ss-flood-post" style="width:100%;display:block;border:1px solid #e5e5e5;border-radius:4px;background:#fafafa;"></canvas>
              <div style="font-size:10.5px;color:#888;margin-top:4px;">\u03c6<sub>w</sub> ${out.phiPerturbed.toFixed(3)} \u00b7 mean depth ${(out.meanDepthPerturbed*1000).toFixed(2)} mm</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;">
            <div><strong>\u0394\u03c6<sub>w</sub>:</strong> ${sign(dPhi)}${dPhi.toFixed(3)}</div>
            <div><strong>\u0394 mean depth:</strong> ${sign(ddmm)}${ddmm.toFixed(2)} mm</div>
            <div style="grid-column:1/-1;"><strong>New wet cells:</strong> ${out.newWetCells} / ${sharedState.cols * sharedState.rows}</div>
            <div style="grid-column:1/-1;color:#666;"><strong>Curve:</strong> ${provLabel}</div>
          </div>
          <div style="margin-top:8px;font-size:11px;color:#666;font-style:italic;">${verdict}</div>
        `;

        // Render the two depth fields. Pixel-perfect rendering using ImageData
        // \u2014 each cell becomes one image pixel, then the canvas CSS scales it up.
        const cols = sharedState.cols;
        const rows = sharedState.rows;
        const patchGrid = sharedState.patchGridSnapshot;
        const patchKeysList = Object.keys(PATCH_PARAMS);
        const preCanvas  = document.getElementById('ss-flood-pre');
        const postCanvas = document.getElementById('ss-flood-post');
        if (preCanvas && postCanvas) {
          renderFloodComparison(preCanvas,  out.vanillaDepths,   patchGrid, patchKeysList, cols, rows);
          renderFloodComparison(postCanvas, out.perturbedDepths, patchGrid, patchKeysList, cols, rows);
        }
      }
    } catch (e) {
      if (results) results.innerHTML = `<div style="color:#c05030;">Error: ${e.message}</div>`;
      console.error('[burn-bridge]', e);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run pre/post comparison';
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Simulation statistics
// ═══════════════════════════════════════════════════════════════════════════

function computeSimStats() {
  const bsg = sharedState.burnSeverityGrid;
  const n = bsg.length;
  let burned = 0, sumSev = 0, maxSev = 0;
  let low = 0, mod = 0, high = 0;

  for (let i = 0; i < n; i++) {
    const s = bsg[i];
    if (s > 0) {
      burned++;
      sumSev += s;
      if (s > maxSev) maxSev = s;
      if (s <= 0.33) low++;
      else if (s <= 0.66) mod++;
      else high++;
    }
  }

  const meanSeverity = burned > 0 ? sumSev / burned : 0;
  return {
    total: n,
    burned,
    burnedPct: (burned / n) * 100,
    meanSeverity,
    maxSeverity: maxSev,
    low, mod, high,
    pctLow: burned > 0 ? Math.round(low / burned * 100) : 0,
    pctModerate: burned > 0 ? Math.round(mod / burned * 100) : 0,
    pctHigh: burned > 0 ? Math.round(high / burned * 100) : 0,
  };
}

/**
 * Degrade soil properties from a real baseline by burn severity.
 * Uses degradation ratios from SSURGO anchors: how much each property
 * changes from severity=0 to severity=s, applied to the real baseline.
 */
function degradeSoil(baseline, severity) {
  const s = Math.max(0, Math.min(1, severity));
  const anchor0 = SSURGO_ANCHORS[0]; // reference pre-fire
  const anchorMax = SSURGO_ANCHORS[SSURGO_ANCHORS.length - 1]; // reference at severity=1

  // Find bracketing anchors for ratio computation
  let lo = anchor0, hi = anchorMax;
  for (let i = 0; i < SSURGO_ANCHORS.length - 1; i++) {
    if (s >= SSURGO_ANCHORS[i].severity && s <= SSURGO_ANCHORS[i + 1].severity) {
      lo = SSURGO_ANCHORS[i]; hi = SSURGO_ANCHORS[i + 1]; break;
    }
  }
  const range = hi.severity - lo.severity || 1;
  const t = (s - lo.severity) / range;

  // For each numeric field, compute the degradation ratio from the anchor table
  // and apply it to the real baseline
  function degradeField(field, higherIsBad) {
    const anchorLo = lo[field];
    const anchorHi = hi[field];
    const anchorPre = anchor0[field];
    if (!anchorPre) return baseline[field] || 0;

    const anchorPost = anchorLo + (anchorHi - anchorLo) * t;
    const ratio = anchorPost / anchorPre;
    return baseline[field] * ratio;
  }

  // Hydrologic group: degrade through B→C→D based on severity
  const groups = ['A', 'B', 'C', 'D'];
  const baseIdx = groups.indexOf(baseline.hydrologicGroup) || 1;
  const groupShift = s > 0.66 ? 2 : s > 0.33 ? 1 : 0;
  const postGroupIdx = Math.min(3, baseIdx + groupShift);

  return {
    infiltrationRate: degradeField('infiltrationRate'),
    organicMatter:    degradeField('organicMatter'),
    kFactor:          degradeField('kFactor'),
    cohesion:         degradeField('cohesion'),
    frictionAngle:    degradeField('frictionAngle'),
    hydrologicGroup:  groups[postGroupIdx],
    awc:              baseline.awc ? baseline.awc * (1 - s * 0.6) : undefined, // ~60% loss at max severity
  };
}

function soilToRadarFromBaseline(soil, baseline) {
  // Normalize each metric to 0–10 scale relative to the baseline
  const safeDiv = (a, b) => b ? a / b : 0;
  return [
    Math.round(safeDiv(soil.infiltrationRate, baseline.infiltrationRate) * 8),
    Math.round(safeDiv(soil.organicMatter, baseline.organicMatter) * 7),
    Math.round((1 - soil.kFactor / 0.6) * 7),
    Math.round(safeDiv(soil.cohesion, baseline.cohesion) * 8),
    Math.round(safeDiv(soil.frictionAngle, baseline.frictionAngle) * 9),
    Math.round(safeDiv(soil.infiltrationRate, baseline.infiltrationRate) * 8),
  ].map(v => Math.max(0, Math.min(10, v)));
}

function buildPreFireProps(pre) {
  const props = {
    infiltration:  { label: 'Infiltration rate (Ksat)', value: `${pre.infiltrationRate.toFixed(1)} mm/hr`, color: 'green' },
    organicMatter: { label: 'Organic matter',           value: `${pre.organicMatter.toFixed(1)}%`,        color: 'green' },
    erodibility:   { label: 'Erodibility (Kf)',         value: pre.kFactor.toFixed(2),                    color: pre.kFactor > 0.32 ? 'amber' : 'green' },
    hydroGroup:    { label: 'Hydrologic group',         value: pre.hydrologicGroup,                       color: 'green' },
    cohesion:      { label: 'Cohesion',                 value: `${pre.cohesion.toFixed(1)} kPa`,          color: 'green' },
    frictionAngle: { label: 'Friction angle',           value: `${pre.frictionAngle}\u00B0`,              color: 'green' },
  };
  if (pre.texdesc) {
    props.texture = { label: 'Texture class', value: pre.texdesc, color: 'green' };
  }
  if (pre.awc != null) {
    props.awc = { label: 'Avail. water capacity', value: `${pre.awc.toFixed(2)} cm/cm`, color: pre.awc < 0.1 ? 'amber' : 'green' };
  }
  return props;
}

function buildPostFireProps(baseline, stats) {
  const soil = degradeSoil(baseline, stats.meanSeverity);
  const sevColor = stats.meanSeverity > 0.66 ? 'red' : stats.meanSeverity > 0.33 ? 'amber' : 'green';
  const props = {
    infiltration:  { label: 'Infiltration rate (Ksat)', value: `${soil.infiltrationRate.toFixed(1)} mm/hr`, color: sevColor },
    organicMatter: { label: 'Organic matter',           value: `${soil.organicMatter.toFixed(1)}%`,        color: sevColor },
    erodibility:   { label: 'Erodibility (Kf)',         value: soil.kFactor.toFixed(2),                    color: sevColor },
    hydroGroup:    { label: 'Hydrologic group',         value: soil.hydrologicGroup,                       color: sevColor },
    cohesion:      { label: 'Cohesion',                 value: `${soil.cohesion.toFixed(1)} kPa`,          color: sevColor },
    frictionAngle: { label: 'Friction angle',           value: `${soil.frictionAngle.toFixed(0)}\u00B0`,   color: sevColor },
  };
  if (baseline.texdesc) {
    props.texture = { label: 'Texture class', value: `${baseline.texdesc} *`, note: 'structure degraded', color: sevColor };
  }
  if (soil.awc != null) {
    props.awc = { label: 'Avail. water capacity', value: `${soil.awc.toFixed(2)} cm/cm`, color: sevColor };
  }
  return props;
}

function patchComposition() {
  const pg = sharedState.patchGridSnapshot;
  if (!pg) return '';
  const patchKeys = Object.keys(PATCH_PARAMS);
  const counts = new Map();
  for (let i = 0; i < pg.length; i++) {
    const key = patchKeys[pg[i]] || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const total = pg.length;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  let html = `<div style="margin:12px 0 8px;">
    <div style="font-size:10px;color:#999;margin-bottom:4px;">Landscape composition</div>
    <div style="display:flex;height:16px;border-radius:3px;overflow:hidden;font-size:9px;font-weight:600;">`;
  const colors = ['#6ebe6e', '#4a90d9', '#d4a030', '#8b6914', '#888', '#c06030'];
  sorted.forEach(([key, count], i) => {
    const pct = Math.round(count / total * 100);
    if (pct < 3) return;
    html += `<div style="flex:${pct};background:${colors[i % colors.length]};color:#fff;display:flex;align-items:center;justify-content:center;">${pct}% ${key}</div>`;
  });
  html += `</div></div>`;
  return html;
}

function burnSummary(stats) {
  const timeline = sharedState.fireTimeline;
  let html = `<div style="margin:10px 0;padding:8px 10px;background:rgba(192,80,48,0.05);border-radius:6px;border:1px solid rgba(192,80,48,0.15);">`;
  html += `<div style="font-size:10px;color:#c05030;font-weight:500;margin-bottom:4px;">Burn summary</div>`;
  html += `<div style="font-size:11px;color:#555;line-height:1.6;">`;
  html += `Cells burned: <strong>${stats.burned}</strong> / ${stats.total} (${stats.burnedPct.toFixed(1)}%)<br>`;
  html += `Peak severity: <strong>${stats.maxSeverity.toFixed(2)}</strong><br>`;
  if (timeline) {
    // Each "tick" is one cell-to-cell ignition cycle from the fire-spread
    // worker (~150 ms of wall-clock at default speed, but the model itself is
    // unitless — what matters is the relative spread, not the absolute clock).
    const approxSeconds = (timeline.length * 0.15).toFixed(0);
    html += `Fire duration: <strong>${timeline.length}</strong> spread steps <span style="color:#888;font-size:10px;">· ~${approxSeconds}s of sim at default speed</span><br>`;
    html += `<span style="color:#888;font-size:10px;font-style:italic;">A spread step is one cell-to-cell ignition cycle in the percolation model — relative, not real-world seconds.</span>`;
  }
  html += `</div></div>`;
  // Per-land-type breakdown: how the fire actually consumed each land cover.
  // Forest cells with high fuel load typically burn near 100%; grass cells with
  // partial fuel may only reach ~30% — this reveals the "selectivity" of the
  // burn over the parcel's composition.
  html += burnByLandTypeTable();
  return html;
}

// Build a table breaking the burn down by land-cover type. For each type:
//   - cells of that type in the parcel (whole-grid count)
//   - cells of that type that burned (severity > 0)
//   - burned % within type
//   - mean severity over burned cells of that type
// Reads patchGrid + burnSeverityGrid + PATCH_PARAMS from sharedState/imports.
function burnByLandTypeTable() {
  const grid = sharedState.patchGridSnapshot;
  const sev  = sharedState.burnSeverityGrid;
  if (!grid || !sev || grid.length !== sev.length) return '';

  const keys = Object.keys(PATCH_PARAMS);
  const totals     = new Array(keys.length).fill(0);
  const burnedCnt  = new Array(keys.length).fill(0);
  const sevSum     = new Array(keys.length).fill(0);

  for (let i = 0; i < grid.length; i++) {
    const k = grid[i];
    if (k < 0 || k >= keys.length) continue;
    totals[k]++;
    if (sev[i] > 0) {
      burnedCnt[k]++;
      sevSum[k] += sev[i];
    }
  }

  // Show only patch types that actually exist in the parcel, sorted by count.
  const rows = keys
    .map((k, i) => ({ key: k, params: PATCH_PARAMS[k], total: totals[i], burned: burnedCnt[i], sevSum: sevSum[i] }))
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total);
  if (rows.length === 0) return '';

  let html = `<div style="margin:10px 0;padding:8px 10px;background:#fff;border-radius:6px;border:1px solid #e5e5e5;">`;
  html += `<div style="font-size:10px;color:#666;font-weight:500;margin-bottom:6px;">Burn by land cover</div>`;
  html += `<div style="font-size:10.5px;color:#555;line-height:1.5;margin-bottom:6px;">For each land type in the parcel: how much of it burned, and the average severity where it did. Reveals which land-cover types carried the fire vs resisted it. Burn probability per cell is set by each type's <em>fuelLoad</em> in the patch model (see Phase 1 patches).</div>`;
  html += `<table style="width:100%;font-size:11px;border-collapse:collapse;">`;
  html += `<thead><tr style="color:#888;font-size:9.5px;letter-spacing:0.04em;text-transform:uppercase;border-bottom:1px solid #eee;">`;
  html += `<th style="text-align:left;padding:3px 4px;">type</th>`;
  html += `<th style="text-align:right;padding:3px 4px;">cells</th>`;
  html += `<th style="text-align:right;padding:3px 4px;">% burned</th>`;
  html += `<th style="text-align:right;padding:3px 4px;">mean sev</th>`;
  html += `</tr></thead><tbody>`;
  for (const r of rows) {
    const pct = r.total > 0 ? (r.burned / r.total) * 100 : 0;
    const meanSev = r.burned > 0 ? r.sevSum / r.burned : 0;
    html += `<tr>`;
    html += `<td style="padding:3px 4px;display:flex;align-items:center;gap:6px;">`;
    html += `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${r.params.color};border:1px solid rgba(0,0,0,0.12);flex-shrink:0;"></span>`;
    html += `<span>${r.params.name || r.key}</span></td>`;
    html += `<td style="text-align:right;padding:3px 4px;font-variant-numeric:tabular-nums;">${r.total}</td>`;
    html += `<td style="text-align:right;padding:3px 4px;font-variant-numeric:tabular-nums;color:${pct > 50 ? '#c05030' : '#555'};">${pct.toFixed(0)}%</td>`;
    html += `<td style="text-align:right;padding:3px 4px;font-variant-numeric:tabular-nums;">${meanSev.toFixed(2)}</td>`;
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;
  return html;
}

function textureBar(pre) {
  if (!pre.sand && !pre.clay && !pre.silt) return '';
  const sand = Math.round(pre.sand || 0);
  const clay = Math.round(pre.clay || 0);
  const silt = Math.round(pre.silt || 0);
  return `
    <div style="margin:12px 0 8px;">
      <div style="font-size:10px;color:#999;margin-bottom:4px;">Soil texture composition</div>
      <div style="display:flex;height:16px;border-radius:3px;overflow:hidden;font-size:9px;font-weight:600;">
        <div style="flex:${sand};background:#d4a030;color:#fff;display:flex;align-items:center;justify-content:center;">${sand}% Sand</div>
        <div style="flex:${silt};background:#8b8b6e;color:#fff;display:flex;align-items:center;justify-content:center;">${silt}% Silt</div>
        <div style="flex:${clay};background:#8b4513;color:#fff;display:flex;align-items:center;justify-content:center;">${clay}% Clay</div>
      </div>
    </div>
  `;
}

function soilDetails(pre) {
  let html = `<div style="margin:8px 0;padding:8px 10px;background:rgba(74,138,74,0.05);border-radius:6px;border:1px solid rgba(74,138,74,0.15);">`;
  html += `<div style="font-size:10px;color:#4a8a4a;font-weight:500;margin-bottom:4px;">Site soil details</div>`;
  html += `<div style="font-size:11px;color:#555;line-height:1.6;">`;
  if (pre.muname) html += `Map unit: <strong>${pre.muname}</strong><br>`;
  if (pre.compname) html += `Component: <strong>${pre.compname}</strong><br>`;
  if (pre.bulkDensity) html += `Bulk density: <strong>${pre.bulkDensity.toFixed(2)} g/cm\u00B3</strong><br>`;
  if (pre.slope) html += `Slope: <strong>${pre.slope.toFixed(1)}\u00B0</strong><br>`;
  html += `</div></div>`;
  return html;
}

function generatePreInsight(pre) {
  if (pre._isReal) {
    const groupDesc = { A: 'high infiltration, low runoff', B: 'moderate infiltration', C: 'slow infiltration, moderate runoff', D: 'very slow infiltration, high runoff' };
    return `Real SSURGO data for ${pre.compname || 'this site'}. ${pre.texdesc || 'Unknown texture'} with infiltration rate ${pre.infiltrationRate.toFixed(1)} mm/hr, organic matter ${pre.organicMatter.toFixed(1)}%, hydrologic group ${pre.hydrologicGroup} (${groupDesc[pre.hydrologicGroup] || ''}). These are the actual pre-fire soil conditions at your selected parcel.`;
  }
  return `Baseline soil properties before fire. Infiltration rate ${pre.infiltrationRate.toFixed(1)} mm/hr, organic matter ${pre.organicMatter.toFixed(1)}%, hydrologic group ${pre.hydrologicGroup}. These values represent the unburned reference state for your simulation grid.`;
}

function generatePostInsight(stats, baseline) {
  const soil = degradeSoil(baseline, stats.meanSeverity);
  const infDrop = ((1 - soil.infiltrationRate / baseline.infiltrationRate) * 100).toFixed(0);
  const siteNote = baseline._isReal ? ` for ${baseline.compname || 'this site'}` : '';

  if (stats.meanSeverity > 0.66) {
    return `High-severity fire across ${stats.burnedPct.toFixed(0)}% of the grid${siteNote}. Infiltration capacity dropped by ${infDrop}% (${baseline.infiltrationRate.toFixed(1)} \u2192 ${soil.infiltrationRate.toFixed(1)} mm/hr), with organic matter largely consumed. Soil structure collapse and hydrophobic layer formation are likely. Debris flow risk is elevated on any slope >15\u00B0.`;
  } else if (stats.meanSeverity > 0.33) {
    return `Moderate burn severity across the affected area${siteNote}. Infiltration reduced by ${infDrop}%, with partial organic matter loss. Soil recovery is expected within 3\u20135 years under favorable conditions, though steep slopes remain vulnerable to erosion.`;
  }
  return `Low-severity fire with ${stats.burnedPct.toFixed(0)}% of grid affected${siteNote}. Soil impacts are limited \u2014 infiltration reduced by ${infDrop}%. Natural recovery should proceed within 1\u20132 growing seasons.`;
}

function generateCompareInsight(pre, post, stats) {
  const infDrop = ((1 - post.infiltrationRate / pre.infiltrationRate) * 100).toFixed(0);
  const kIncrease = ((post.kFactor / pre.kFactor - 1) * 100).toFixed(0);
  return `Fire burned ${stats.burnedPct.toFixed(0)}% of the landscape (${stats.pctHigh}% high, ${stats.pctModerate}% moderate, ${stats.pctLow}% low severity). Mean infiltration dropped ${infDrop}% (${pre.infiltrationRate.toFixed(1)} \u2192 ${post.infiltrationRate.toFixed(1)} mm/hr), while erodibility increased ${kIncrease}%. ${pre.hydrologicGroup !== post.hydrologicGroup ? `Hydrologic group reclassified from ${pre.hydrologicGroup} to ${post.hydrologicGroup}, indicating fundamentally altered runoff behavior.` : 'Hydrologic group unchanged.'} Use the timeline slider to see how fire spread across the terrain.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// HTML builders (shared between static and sim modes)
// ═══════════════════════════════════════════════════════════════════════════

function panelTitle(title, subtitle) {
  return `
    <div style="margin-bottom:14px;">
      <div style="font-size:14px;font-weight:500;color:#1a1a1a;letter-spacing:0.02em;">${title}</div>
      <div style="font-size:10px;color:#999;margin-top:2px;">${subtitle}</div>
    </div>
  `;
}

function propsTable(props) {
  let rows = '';
  for (const key of Object.keys(props)) {
    const p = props[key];
    const c = COLOR[p.color] || COLOR.green;
    const note = p.note ? `<span style="display:block;font-size:9px;color:#999;font-style:italic;">${p.note}</span>` : '';
    rows += `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;
                  padding:7px 10px;background:${c.bg};border-left:3px solid ${c.border};
                  border-radius:0 4px 4px 0;margin-bottom:4px;">
        <span style="font-size:11px;color:#666;">${p.label}</span>
        <span style="font-size:11px;font-family:'SF Mono',SFMono-Regular,Menlo,monospace;color:${c.fg};text-align:right;">
          ${p.value}${note}
        </span>
      </div>
    `;
  }
  return rows;
}

function severityBar(pctHigh, pctMod, pctLow) {
  return `
    <div style="margin:12px 0 8px;">
      <div style="font-size:10px;color:#999;margin-bottom:4px;">Burn severity distribution</div>
      <div style="display:flex;height:16px;border-radius:3px;overflow:hidden;font-size:9px;font-weight:600;">
        <div style="flex:${pctHigh};background:#cc3322;color:#fff;display:flex;align-items:center;justify-content:center;">${pctHigh}% High</div>
        <div style="flex:${pctMod};background:#d4a030;color:#fff;display:flex;align-items:center;justify-content:center;">${pctMod}% Mod</div>
        <div style="flex:${pctLow};background:#6ebe6e;color:#fff;display:flex;align-items:center;justify-content:center;">${pctLow}% Low</div>
      </div>
    </div>
  `;
}

function metricCard(label, pre, post, unit, delta) {
  return `
    <div style="background:#f5f5f5;border:1px solid #eee;
                border-radius:6px;padding:10px;">
      <div style="font-size:9px;color:#999;margin-bottom:5px;">${label}</div>
      <div style="font-family:'SF Mono',SFMono-Regular,Menlo,monospace;font-size:12px;">
        <span style="color:#4a8a4a;">${pre}</span>
        <span style="color:#ccc;margin:0 4px;">\u2192</span>
        <span style="color:#c05030;">${post}</span>
        <span style="color:#999;font-size:10px;"> ${unit}</span>
      </div>
      <div style="font-size:10px;color:#c05030;margin-top:3px;">${delta}</div>
    </div>
  `;
}

function source(text) {
  return `<div style="font-size:9px;color:#666;margin:10px 0 6px;font-style:italic;">${text}</div>`;
}

function insight(text) {
  return `
    <div style="border-left:3px solid rgba(192,80,48,0.3);background:rgba(192,80,48,0.04);
                padding:10px 12px;border-radius:0 5px 5px 0;margin-top:10px;
                font-size:11px;color:#666;font-style:italic;line-height:1.55;">
      ${text}
    </div>
  `;
}

function swatch(color, style) {
  const border = style === 'dashed' ? `2px dashed ${color}` : 'none';
  const bg = style === 'solid' ? color : 'transparent';
  return `<span style="display:inline-block;width:14px;height:10px;background:${bg};border:${border};border-radius:2px;vertical-align:middle;margin-right:5px;"></span>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Radar chart (Chart.js)
// ═══════════════════════════════════════════════════════════════════════════

function buildRadarChart(preData, postData) {
  const canvas = document.getElementById('soil-radar-canvas');
  if (!canvas || typeof Chart === 'undefined') return;

  if (_radarChart) { _radarChart.destroy(); _radarChart = null; }

  const ctx = canvas.getContext('2d');
  _radarChart = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: RADAR_LABELS,
      datasets: [
        {
          label: 'Pre-fire',
          data: preData,
          backgroundColor: 'rgba(110,190,110,0.15)',
          borderColor: '#6ebe6e',
          borderWidth: 2,
          pointBackgroundColor: '#6ebe6e',
          pointRadius: 3,
        },
        {
          label: _hasSimData ? 'Post-fire (simulated)' : 'Post-fire (high severity)',
          data: postData,
          backgroundColor: 'rgba(220,80,60,0.15)',
          borderColor: '#dc503c',
          borderWidth: 2,
          pointBackgroundColor: '#dc503c',
          pointRadius: 3,
        },
      ],
    },
    options: {
      responsive: false,
      scales: {
        r: {
          min: 0, max: 10,
          ticks: { display: false, stepSize: 2 },
          grid: { color: 'rgba(0,0,0,0.06)' },
          angleLines: { color: 'rgba(0,0,0,0.05)' },
          pointLabels: {
            color: '#666', font: { size: 9, family: "'Inter', system-ui, sans-serif" },
          },
        },
      },
      plugins: {
        legend: {
          labels: {
            color: '#666', font: { size: 10 }, boxWidth: 12, padding: 10,
          },
        },
      },
    },
  });
}
