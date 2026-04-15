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
  root.style.cssText = `
    display: flex; width: 100%; height: 100%;
    font-family: system-ui, -apple-system, sans-serif;
    color: #e0e0e0; background: #0f0f12;
  `;
  container.appendChild(root);

  // ── Map wrapper ──
  const mapWrap = document.createElement('div');
  mapWrap.style.cssText = 'flex: 1; position: relative; min-width: 0;';
  root.appendChild(mapWrap);

  // Toggle bar
  const toggleBar = document.createElement('div');
  toggleBar.style.cssText = `
    position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
    z-index: 1000; display: flex; gap: 0;
    background: rgba(16,16,24,0.95); border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.1); overflow: hidden;
  `;
  mapWrap.appendChild(toggleBar);

  const states = ['pre', 'post', 'compare'];
  const stateLabels = ['Pre-fire', 'Post-fire', 'Compare'];
  _toggleBtns = states.map((s, i) => {
    const btn = document.createElement('button');
    btn.textContent = stateLabels[i];
    btn.dataset.state = s;
    btn.style.cssText = `
      padding: 6px 16px; border: none; cursor: pointer;
      font-size: 11px; font-family: inherit; font-weight: 600;
      letter-spacing: 0.03em; transition: all 0.15s;
      background: transparent; color: #777;
    `;
    if (i < states.length - 1) btn.style.borderRight = '1px solid rgba(255,255,255,0.08)';
    btn.addEventListener('click', () => switchState(s));
    toggleBar.appendChild(btn);
    return btn;
  });

  // Source badge
  const srcBadge = document.createElement('div');
  srcBadge.style.cssText = `
    position: absolute; top: 10px; right: 12px; z-index: 1000;
    background: ${_hasSimData ? 'rgba(184,224,74,0.15)' : 'rgba(220,170,60,0.15)'};
    border: 1px solid ${_hasSimData ? 'rgba(184,224,74,0.35)' : 'rgba(220,170,60,0.35)'};
    border-radius: 4px; padding: 3px 10px; font-size: 10px; font-weight: 600;
    color: ${_hasSimData ? '#b8e04a' : '#dcaa3c'};
  `;
  srcBadge.textContent = _hasSimData ? 'LIVE SIMULATION' : 'REFERENCE: Camp Fire 2018';
  mapWrap.appendChild(srcBadge);

  // Map container
  const mapEl = document.createElement('div');
  mapEl.id = 'soil-study-map';
  mapEl.style.cssText = 'width: 100%; height: 100%;';
  mapWrap.appendChild(mapEl);

  // Legend
  _legendEl = document.createElement('div');
  _legendEl.style.cssText = `
    position: absolute; bottom: 16px; left: 16px; z-index: 1000;
    background: rgba(16,16,24,0.92); border-radius: 6px;
    padding: 10px 14px; font-size: 10px; color: #bbb;
    border: 1px solid rgba(255,255,255,0.08); line-height: 1.7;
    max-width: 220px;
  `;
  mapWrap.appendChild(_legendEl);

  // Timeline slider (sim mode only, shown in post/compare)
  if (_hasSimData && sharedState.fireTimeline && sharedState.fireTimeline.length > 0) {
    const sliderWrap = document.createElement('div');
    sliderWrap.id = 'soil-timeline-wrap';
    sliderWrap.style.cssText = `
      position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
      z-index: 1000; background: rgba(16,16,24,0.92); border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.08); padding: 8px 14px;
      display: none; align-items: center; gap: 10px; min-width: 280px;
    `;
    _timelineLabel = document.createElement('span');
    _timelineLabel.style.cssText = 'font-size: 10px; color: #999; min-width: 60px;';
    _timelineLabel.textContent = 'Tick 0';

    _timelineSlider = document.createElement('input');
    _timelineSlider.type = 'range';
    _timelineSlider.min = '0';
    _timelineSlider.max = String(sharedState.fireTimeline.length - 1);
    _timelineSlider.value = String(sharedState.fireTimeline.length - 1);
    _timelineSlider.style.cssText = 'flex: 1; accent-color: #dc503c;';
    _timelineSlider.addEventListener('input', () => onTimelineChange(+_timelineSlider.value));

    const timelineTitle = document.createElement('span');
    timelineTitle.style.cssText = 'font-size: 10px; color: #777; font-weight: 600;';
    timelineTitle.textContent = 'Fire spread';

    sliderWrap.appendChild(timelineTitle);
    sliderWrap.appendChild(_timelineSlider);
    sliderWrap.appendChild(_timelineLabel);
    mapWrap.appendChild(sliderWrap);
  }

  // ── Data panel ──
  _dataPanelEl = document.createElement('div');
  _dataPanelEl.style.cssText = `
    width: 340px; min-width: 340px; height: 100%;
    background: rgba(16,16,24,0.98);
    border-left: 1px solid rgba(255,255,255,0.08);
    overflow-y: auto; padding: 18px 16px;
  `;
  root.appendChild(_dataPanelEl);

  // ── Responsive ──
  const mq = window.matchMedia('(max-width: 720px)');
  function applyLayout(e) {
    if (e.matches) {
      root.style.flexDirection = 'column';
      _dataPanelEl.style.width = '100%';
      _dataPanelEl.style.minWidth = '0';
      _dataPanelEl.style.height = '50%';
      _dataPanelEl.style.borderLeft = 'none';
      _dataPanelEl.style.borderTop = '1px solid rgba(255,255,255,0.08)';
    } else {
      root.style.flexDirection = 'row';
      _dataPanelEl.style.width = '340px';
      _dataPanelEl.style.minWidth = '340px';
      _dataPanelEl.style.height = '100%';
      _dataPanelEl.style.borderLeft = '1px solid rgba(255,255,255,0.08)';
      _dataPanelEl.style.borderTop = 'none';
    }
  }
  mq.addEventListener('change', applyLayout);
  applyLayout(mq);

  // ── Init Leaflet map ──
  initMap(mapEl);

  // Tooltip marker style
  if (!document.getElementById('soil-marker-style')) {
    const style = document.createElement('style');
    style.id = 'soil-marker-style';
    style.textContent = `
      .soil-marker-tip {
        background: rgba(16,16,24,0.88); color: #ddd;
        border: 1px solid rgba(255,255,255,0.15); border-radius: 4px;
        padding: 2px 8px; font-size: 10px; font-family: system-ui, sans-serif;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      }
      .soil-marker-tip::before { border-top-color: rgba(16,16,24,0.88) !important; }
    `;
    document.head.appendChild(style);
  }

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

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
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
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
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
    btn.style.background = active ? 'rgba(184,224,74,0.12)' : 'transparent';
    btn.style.color = active ? '#b8e04a' : '#777';
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
    // Hide heatmap, show soil polygons
    if (_heatmapLayer) _heatmapLayer.setOpacity(0);
    if (_timelineLayer) _map.removeLayer(_timelineLayer);
    if (_soilWmsLayer) _soilWmsLayer.addTo(_map);
  } else {
    // Show heatmap, hide soil polygons
    if (_heatmapLayer) _heatmapLayer.setOpacity(0.75);
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
    html = `
      <div style="font-weight:600;margin-bottom:4px;">Pre-fire landscape</div>
      ${swatch('#6ebe6e', 'solid')} Unburned terrain<br>
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
    _dataPanelEl.innerHTML = html;

    // Build radar with dynamic values
    const preRadar = soilToRadarFromBaseline(pre, pre);
    const postRadar = soilToRadarFromBaseline(postSoil, pre);
    buildRadarChart(preRadar, postRadar);
  }
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
  let html = `<div style="margin:10px 0;padding:8px 10px;background:rgba(220,80,60,0.08);border-radius:4px;border:1px solid rgba(220,80,60,0.15);">`;
  html += `<div style="font-size:10px;color:#dc503c;font-weight:600;margin-bottom:4px;">Burn summary</div>`;
  html += `<div style="font-size:11px;color:#ccc;line-height:1.6;">`;
  html += `Cells burned: <strong>${stats.burned}</strong> / ${stats.total} (${stats.burnedPct.toFixed(1)}%)<br>`;
  html += `Peak severity: <strong>${stats.maxSeverity.toFixed(2)}</strong><br>`;
  if (timeline) html += `Fire duration: <strong>${timeline.length}</strong> ticks<br>`;
  html += `</div></div>`;
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
  let html = `<div style="margin:8px 0;padding:8px 10px;background:rgba(110,190,110,0.06);border-radius:4px;border:1px solid rgba(110,190,110,0.12);">`;
  html += `<div style="font-size:10px;color:#6ebe6e;font-weight:600;margin-bottom:4px;">Site soil details</div>`;
  html += `<div style="font-size:11px;color:#ccc;line-height:1.6;">`;
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
      <div style="font-size:14px;font-weight:700;color:#e0e0e0;letter-spacing:0.02em;">${title}</div>
      <div style="font-size:10px;color:#888;margin-top:2px;">${subtitle}</div>
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
        <span style="font-size:11px;color:#bbb;">${p.label}</span>
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
    <div style="background:rgba(30,30,42,0.8);border:1px solid rgba(255,255,255,0.06);
                border-radius:5px;padding:10px;">
      <div style="font-size:9px;color:#888;margin-bottom:5px;">${label}</div>
      <div style="font-family:'SF Mono',SFMono-Regular,Menlo,monospace;font-size:12px;">
        <span style="color:#6ebe6e;">${pre}</span>
        <span style="color:#555;margin:0 4px;">\u2192</span>
        <span style="color:#dc503c;">${post}</span>
        <span style="color:#888;font-size:10px;"> ${unit}</span>
      </div>
      <div style="font-size:10px;color:#dc503c;margin-top:3px;">${delta}</div>
    </div>
  `;
}

function source(text) {
  return `<div style="font-size:9px;color:#666;margin:10px 0 6px;font-style:italic;">${text}</div>`;
}

function insight(text) {
  return `
    <div style="border-left:3px solid rgba(220,170,60,0.5);background:rgba(220,170,60,0.06);
                padding:10px 12px;border-radius:0 5px 5px 0;margin-top:10px;
                font-size:11px;color:#c0b89a;font-style:italic;line-height:1.55;">
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
          grid: { color: 'rgba(255,255,255,0.08)' },
          angleLines: { color: 'rgba(255,255,255,0.06)' },
          pointLabels: {
            color: '#999', font: { size: 9, family: 'system-ui, sans-serif' },
          },
        },
      },
      plugins: {
        legend: {
          labels: {
            color: '#999', font: { size: 10 }, boxWidth: 12, padding: 10,
          },
        },
      },
    },
  });
}
