/**
 * parcel-analysis.js
 * Site Analysis module: geocode a location, draw a parcel on a satellite map,
 * fetch real NLCD 2021 land cover data, and feed it into the mosaic-flow simulation.
 *
 * Depends on: Leaflet 1.9 + Leaflet.draw (loaded via CDN in index.html)
 * Requires: nlcd-mapper.js
 */

import {
  NLCD_CLASSES,
  nlcdToPatchIndex,
  colorToNlcdClass,
  computeComposition,
  generateMockNLCDGrid,
} from './nlcd-mapper.js';
import { simState } from './state.js';

const COLS = 64;
const ROWS = 64;

// ── Module state ──────────────────────────────────────────────────────────────
let _map = null;
let _mapReady = false;       // true after first-time map init
let _drawnItems = null;
let _drawControl = null;
let _polygon = null;         // L.Layer (polygon or rectangle)
let _polygonGeoJson = null;
let _bounds = null;          // L.LatLngBounds
let _nlcdGrid = null;        // Uint8Array[COLS*ROWS] of NLCD class values
let _patchGrid = null;       // Uint8Array[COLS*ROWS] of internal patch indices
let _composition = null;     // Array<{nlcdClass, name, hex, patchKey, pct}>
let _lcOverlay = null;       // L.ImageOverlay — land cover grid on map
let _simOverlay = null;      // L.ImageOverlay — simulation result on map
let _simCanvas = null;       // offscreen 64×64 canvas for sim overlay rendering
let _simCtx = null;
let _simAnimId = null;
let _onGridReady = null;
let _onRunSim = null;

// ── Public API ────────────────────────────────────────────────────────────────

export function initParcelAnalysis(containerId, { onGridReady, onRunSim }) {
  _onGridReady = onGridReady;
  _onRunSim = onRunSim;

  const el = document.getElementById(containerId);
  if (!el) { console.error('[PA] container not found:', containerId); return; }

  // Build the HTML skeleton and sidebar controls immediately.
  // The Leaflet map is initialized lazily in onTabActivated() because Leaflet
  // requires the container to be visible (non-zero size) at init time.
  el.innerHTML = _buildHTML();
  _injectStyles();

  // Offscreen canvas for sim overlay (doesn't need to be visible)
  _simCanvas = document.createElement('canvas');
  _simCanvas.width = COLS;
  _simCanvas.height = ROWS;
  _simCtx = _simCanvas.getContext('2d');

  _wireEvents();
  _setStep(0);
}

/**
 * Call when this tab becomes visible.
 * Initializes the Leaflet map on the first call (container now has real dimensions),
 * then invalidates size on subsequent calls.
 */
export function onTabActivated() {
  if (!_mapReady) {
    _initMap();
  } else {
    setTimeout(() => _map && _map.invalidateSize(), 50);
  }
}

/** Initialize Leaflet — must be called only when the container is visible. */
function _initMap() {
  _mapReady = true;

  // Esri World Imagery satellite base — free, no API key required
  _map = L.map('pa-map', { zoomControl: true }).setView([39.5, -98.35], 4);

  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Tiles &copy; Esri &mdash; Esri, Maxar, GeoEye, USGS', maxZoom: 19 }
  ).addTo(_map);

  // Leaflet.draw setup
  _drawnItems = new L.FeatureGroup().addTo(_map);
  _drawControl = new L.Control.Draw({
    draw: {
      polygon: {
        allowIntersection: false,
        showArea: true,
        shapeOptions: { color: '#b8e04a', weight: 2, fillOpacity: 0.06 },
      },
      rectangle: {
        shapeOptions: { color: '#b8e04a', weight: 2, fillOpacity: 0.06 },
      },
      polyline: false, circle: false, circlemarker: false, marker: false,
    },
    edit: { featureGroup: _drawnItems, remove: true },
  });
  _map.addControl(_drawControl);

  _map.on(L.Draw.Event.CREATED, _onShapeCreated);
  _map.on(L.Draw.Event.EDITED,  _onShapeEdited);
  _map.on(L.Draw.Event.DELETED, () => _clearDrawing(false));
}

/** Stop the sim overlay animation loop (call when leaving site-analysis tab). */
export function stopSimOverlay() {
  if (_simAnimId) { cancelAnimationFrame(_simAnimId); _simAnimId = null; }
}

// ── HTML template ─────────────────────────────────────────────────────────────

function _buildHTML() {
  return `
<div id="pa-layout">
  <aside id="pa-sidebar">
    <div id="pa-header"><span class="pa-logo">◈</span> Site Analysis</div>

    <div class="pa-step" id="pa-step-0">
      <div class="pa-step-hd"><span class="pa-num">1</span><span class="pa-title">Search Location</span></div>
      <div class="pa-step-body">
        <div id="pa-search-row">
          <input id="pa-search-input" type="text" placeholder="Address or place name…" autocomplete="off"/>
          <button id="pa-search-btn">Go</button>
        </div>
        <div id="pa-search-results"></div>
      </div>
    </div>

    <div class="pa-step pa-locked" id="pa-step-1">
      <div class="pa-step-hd"><span class="pa-num">2</span><span class="pa-title">Draw Parcel</span></div>
      <div class="pa-step-body">
        <p class="pa-hint">Use the polygon or rectangle tool on the map toolbar. Double-click a polygon to close it.</p>
        <button id="pa-clear-btn" class="pa-secondary" style="display:none">Clear Shape</button>
      </div>
    </div>

    <div class="pa-step pa-locked" id="pa-step-2">
      <div class="pa-step-hd"><span class="pa-num">3</span><span class="pa-title">Confirm Parcel</span></div>
      <div class="pa-step-body">
        <div id="pa-parcel-info"></div>
        <div class="pa-row">
          <button id="pa-load-btn">Load Land Cover</button>
          <button id="pa-redraw-btn" class="pa-secondary">Redraw</button>
        </div>
      </div>
    </div>

    <div class="pa-step pa-locked" id="pa-step-3">
      <div class="pa-step-hd"><span class="pa-num">4</span><span class="pa-title">Land Cover</span></div>
      <div class="pa-step-body">
        <div id="pa-lc-status"></div>
        <div id="pa-lc-comp"></div>
        <label class="pa-check-row">
          <input type="checkbox" id="pa-show-lc" checked> Show land cover overlay
        </label>
      </div>
    </div>

    <div class="pa-step pa-locked" id="pa-step-4">
      <div class="pa-step-hd"><span class="pa-num">5</span><span class="pa-title">Simulate</span></div>
      <div class="pa-step-body">
        <p class="pa-hint">The simulation runs in the Mosaic Design view with your parcel's land cover loaded.</p>
        <div class="pa-row">
          <button id="pa-run-btn">Run Simulation →</button>
          <button id="pa-export-btn" class="pa-secondary">Export</button>
        </div>
        <label class="pa-check-row" id="pa-overlay-row" style="display:none">
          <input type="checkbox" id="pa-show-sim-overlay" checked> Live simulation overlay
        </label>
      </div>
    </div>
  </aside>

  <div id="pa-map-wrap">
    <div id="pa-map"></div>
  </div>
</div>`;
}

// ── Styles ────────────────────────────────────────────────────────────────────

function _injectStyles() {
  if (document.getElementById('pa-styles')) return;
  const s = document.createElement('style');
  s.id = 'pa-styles';
  s.textContent = `
    #pa-layout {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex;
      background: #0f0f12; color: #e0e0e0;
      font-family: system-ui, -apple-system, sans-serif; font-size: 13px;
    }
    #pa-sidebar {
      width: 270px; min-width: 270px; height: 100%; overflow-y: auto;
      background: rgba(18,18,26,0.99);
      border-right: 1px solid rgba(255,255,255,0.08);
      display: flex; flex-direction: column;
    }
    #pa-header {
      padding: 13px 16px 11px; font-size: 14px; font-weight: 600;
      color: #b8e04a; border-bottom: 1px solid rgba(255,255,255,0.07);
      display: flex; align-items: center; gap: 7px; letter-spacing: 0.01em;
    }
    .pa-logo { font-size: 17px; }
    .pa-step { border-bottom: 1px solid rgba(255,255,255,0.06); transition: opacity 0.2s; }
    .pa-locked { opacity: 0.35; pointer-events: none; }
    .pa-step-hd {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px 7px; cursor: default;
    }
    .pa-num {
      width: 21px; height: 21px; border-radius: 50%;
      background: rgba(184,224,74,0.12); border: 1px solid #b8e04a;
      color: #b8e04a; font-size: 10px; font-weight: 700;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .pa-title { font-weight: 600; font-size: 12.5px; color: #e0e0e0; }
    .pa-step-body { padding: 0 16px 12px; }
    .pa-hint { color: #888; font-size: 11.5px; margin-bottom: 8px; line-height: 1.55; }
    #pa-search-row { display: flex; gap: 6px; }
    #pa-search-input {
      flex: 1; background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.14); border-radius: 5px;
      padding: 6px 8px; color: #e0e0e0; font-size: 12px; outline: none;
    }
    #pa-search-input:focus { border-color: #b8e04a; }
    #pa-search-results { margin-top: 5px; max-height: 150px; overflow-y: auto; }
    .pa-result {
      padding: 5px 8px; border-radius: 4px; cursor: pointer;
      font-size: 11.5px; color: #ccc; line-height: 1.4;
    }
    .pa-result:hover { background: rgba(255,255,255,0.08); color: #fff; }
    #pa-parcel-info { font-size: 11.5px; color: #aaa; margin-bottom: 8px; line-height: 1.5; }
    #pa-lc-status { font-size: 11.5px; color: #aaa; margin-bottom: 6px; min-height: 18px; }
    .pa-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
    .pa-comp-item { display: flex; align-items: center; gap: 5px; padding: 2px 0; font-size: 11px; }
    .pa-swatch { width: 11px; height: 11px; border-radius: 2px; flex-shrink: 0; }
    .pa-comp-name { flex: 1; color: #bbb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pa-bar-wrap { width: 52px; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; flex-shrink: 0; }
    .pa-bar { height: 100%; border-radius: 2px; }
    .pa-pct { width: 28px; text-align: right; color: #777; flex-shrink: 0; }
    .pa-check-row {
      display: flex; align-items: center; gap: 7px;
      font-size: 11.5px; color: #aaa; cursor: pointer; margin-top: 7px;
    }
    button {
      background: rgba(184,224,74,0.1); border: 1px solid rgba(184,224,74,0.38);
      color: #b8e04a; border-radius: 5px; padding: 5px 11px;
      font-size: 12px; cursor: pointer; transition: background 0.15s; white-space: nowrap;
    }
    button:hover { background: rgba(184,224,74,0.2); }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .pa-secondary {
      background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.18); color: #aaa;
    }
    .pa-secondary:hover { background: rgba(255,255,255,0.09); }
    #pa-map-wrap { flex: 1; position: relative; overflow: hidden; }
    #pa-map { position: absolute; top: 0; left: 0; right: 0; bottom: 0; }
    .pa-spin {
      display: inline-block; width: 12px; height: 12px;
      border: 2px solid rgba(184,224,74,0.3); border-top-color: #b8e04a;
      border-radius: 50%; animation: pa-spin 0.6s linear infinite;
      vertical-align: middle; margin-right: 5px;
    }
    @keyframes pa-spin { to { transform: rotate(360deg); } }
    .leaflet-draw-toolbar a,
    .leaflet-bar a { background-color: #1a1a26 !important; color: #b8e04a !important; border-color: rgba(255,255,255,0.12) !important; }
    .leaflet-draw-toolbar a:hover,
    .leaflet-bar a:hover { background-color: #252534 !important; }
    .leaflet-control-zoom a { color: #ccc !important; }
  `;
  document.head.appendChild(s);
}

// ── Workflow step management ──────────────────────────────────────────────────

function _setStep(step) {
  for (let i = 0; i <= 4; i++) {
    const el = document.getElementById(`pa-step-${i}`);
    if (!el) continue;
    el.classList.toggle('pa-locked', i > step);
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function _wireEvents() {
  const $ = id => document.getElementById(id);

  // Search
  $('pa-search-btn')?.addEventListener('click', _doSearch);
  $('pa-search-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') _doSearch(); });

  // Drawing controls
  $('pa-clear-btn')?.addEventListener('click', () => _clearDrawing(true));
  $('pa-redraw-btn')?.addEventListener('click', () => _clearDrawing(true));

  // Confirm
  $('pa-load-btn')?.addEventListener('click', _loadLandCover);

  // LC overlay toggle
  $('pa-show-lc')?.addEventListener('change', e => {
    if (!_lcOverlay) return;
    e.target.checked ? _lcOverlay.addTo(_map) : _lcOverlay.remove();
  });

  // Simulate / export
  $('pa-run-btn')?.addEventListener('click', _runSimulation);
  $('pa-export-btn')?.addEventListener('click', _doExport);

  // Sim overlay toggle
  $('pa-show-sim-overlay')?.addEventListener('change', e => {
    e.target.checked ? _startSimOverlay() : stopSimOverlay();
  });
}

// ── Geocode search (Nominatim — free, no key) ─────────────────────────────────

async function _doSearch() {
  const q = document.getElementById('pa-search-input')?.value?.trim();
  if (!q) return;
  const resultsEl = document.getElementById('pa-search-results');
  resultsEl.innerHTML = '<span class="pa-hint"><span class="pa-spin"></span>Searching…</span>';

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en-US,en' } });
    const data = await res.json();

    if (!data.length) {
      resultsEl.innerHTML = '<p class="pa-hint">No results found.</p>';
      return;
    }
    resultsEl.innerHTML = '';
    for (const item of data) {
      const div = document.createElement('div');
      div.className = 'pa-result';
      div.textContent = item.display_name;
      div.addEventListener('click', () => {
        const [s, n, w, e] = item.boundingbox.map(Number);
        _map.fitBounds([[s, w], [n, e]], { maxZoom: 16 });
        resultsEl.innerHTML = '';
        _setStep(1);
      });
      resultsEl.appendChild(div);
    }
  } catch (err) {
    resultsEl.innerHTML = '<p class="pa-hint">Search failed — try again.</p>';
    console.warn('[PA] Nominatim error:', err);
  }
}

// ── Drawing events ────────────────────────────────────────────────────────────

function _onShapeCreated(e) {
  _drawnItems.clearLayers();
  _polygon = e.layer;
  _drawnItems.addLayer(_polygon);
  _polygonGeoJson = _polygon.toGeoJSON();
  _bounds = _polygon.getBounds();
  _syncParcelBounds();
  _updateParcelInfo();
  document.getElementById('pa-clear-btn').style.display = '';
  _setStep(2);
}

function _onShapeEdited() {
  const layers = _drawnItems.getLayers();
  if (layers.length > 0) {
    _polygon = layers[0];
    _polygonGeoJson = _polygon.toGeoJSON();
    _bounds = _polygon.getBounds();
    _syncParcelBounds();
    _updateParcelInfo();
    _setStep(2);
  }
}

function _syncParcelBounds() {
  if (_bounds) {
    const sw = _bounds.getSouthWest(), ne = _bounds.getNorthEast();
    simState.parcelBounds = { west: sw.lng, south: sw.lat, east: ne.lng, north: ne.lat };
  } else {
    simState.parcelBounds = null;
  }
}

function _clearDrawing(resetToStep1 = true) {
  _polygon = null;
  _polygonGeoJson = null;
  _bounds = null;
  simState.parcelBounds = null;
  _nlcdGrid = null;
  _patchGrid = null;
  _composition = null;
  if (_lcOverlay) { if (_map) _lcOverlay.remove(); _lcOverlay = null; }
  if (_simOverlay) { if (_map) _simOverlay.remove(); _simOverlay = null; }
  if (_drawnItems) _drawnItems.clearLayers();
  stopSimOverlay();
  const el = document.getElementById('pa-clear-btn');
  if (el) el.style.display = 'none';
  const pi = document.getElementById('pa-parcel-info'); if (pi) pi.innerHTML = '';
  const ls = document.getElementById('pa-lc-status');   if (ls) ls.innerHTML = '';
  const lc = document.getElementById('pa-lc-comp');     if (lc) lc.innerHTML = '';
  if (resetToStep1) _setStep(1);
}

function _updateParcelInfo() {
  const infoEl = document.getElementById('pa-parcel-info');
  if (!infoEl || !_bounds) return;
  const sw = _bounds.getSouthWest();
  const ne = _bounds.getNorthEast();
  const km2 = _approxAreaKm2(_bounds);
  infoEl.innerHTML = `
    <div>${sw.lat.toFixed(4)}°N, ${sw.lng.toFixed(4)}°E  →  ${ne.lat.toFixed(4)}°N, ${ne.lng.toFixed(4)}°E</div>
    <div style="color:#b8e04a;margin-top:3px">≈ ${km2.toFixed(2)} km² · ${(km2 * 100).toFixed(0)} ha</div>
  `;
}

// ── NLCD land cover fetch ─────────────────────────────────────────────────────

async function _loadLandCover() {
  if (!_polygon || !_bounds) return;
  _setStep(3);

  const statusEl = document.getElementById('pa-lc-status');
  statusEl.innerHTML = '<span class="pa-spin"></span>Fetching NLCD 2021 data from MRLC…';

  try {
    _nlcdGrid = await _fetchNLCDGrid(_bounds, COLS, ROWS);
    statusEl.innerHTML = '✓ NLCD 2021 data loaded';
  } catch (err) {
    console.warn('[PA] NLCD fetch failed, using synthetic fallback:', err);
    const seedLat = Math.floor(_bounds.getCenter().lat * 1000);
    _nlcdGrid = generateMockNLCDGrid(COLS, ROWS, seedLat);
    statusEl.innerHTML = '⚠ Synthetic land cover (NLCD unavailable from this origin)';
  }

  // NLCD class values → internal patch indices
  _patchGrid = new Uint8Array(COLS * ROWS);
  for (let i = 0; i < _nlcdGrid.length; i++) {
    _patchGrid[i] = nlcdToPatchIndex(_nlcdGrid[i]);
  }

  // Composition summary
  _composition = computeComposition(_nlcdGrid);
  _renderComposition(_composition);

  // Draw translucent land cover grid on map
  _renderLCOverlay();

  // Notify main simulation that a grid is available
  if (_onGridReady) _onGridReady(_patchGrid);

  _setStep(4);
  const overlayRow = document.getElementById('pa-overlay-row');
  if (overlayRow) overlayRow.style.display = '';
}

/**
 * Fetch NLCD via MRLC WMS (CORS-enabled US government server), draw to canvas,
 * sample pixel colors, and reverse-map to NLCD class values.
 */
async function _fetchNLCDGrid(bounds, cols, rows) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const [west, south, east, north] = [sw.lng, sw.lat, ne.lng, ne.lat];

  // USGS MRLC GeoServer WMS — NLCD 2021 CONUS (has Access-Control-Allow-Origin: *)
  const wmsUrl = [
    'https://www.mrlc.gov/geoserver/mrlc_display/NLCD_2021_Land_Cover_L48/ows',
    '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap',
    '&LAYERS=NLCD_2021_Land_Cover_L48',
    `&BBOX=${west},${south},${east},${north}`,
    '&SRS=EPSG:4326',
    `&WIDTH=${cols}&HEIGHT=${rows}`,
    '&FORMAT=image/png&TRANSPARENT=true',
  ].join('');

  const img = await _loadCORSImage(wmsUrl);

  // Sample the rendered image into a grid of NLCD class values
  const offCanvas = document.createElement('canvas');
  offCanvas.width = cols; offCanvas.height = rows;
  const ctx = offCanvas.getContext('2d');
  ctx.drawImage(img, 0, 0, cols, rows);

  const { data } = ctx.getImageData(0, 0, cols, rows);
  const grid = new Uint8Array(cols * rows);

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const px = (i * cols + j) * 4;
      const [r, g, b, a] = [data[px], data[px + 1], data[px + 2], data[px + 3]];
      // Transparent or near-white pixels = no-data → grassland
      grid[i * cols + j] = (a < 20 || (r > 240 && g > 240 && b > 240))
        ? 71
        : colorToNlcdClass(r, g, b);
    }
  }
  return grid;
}

function _loadCORSImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => reject(new Error('Image load timeout')), 12000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = (e) => { clearTimeout(timer); reject(e); };
    img.src = url;
  });
}

// ── Land cover overlay on map ─────────────────────────────────────────────────

function _renderLCOverlay() {
  if (!_map) return;
  if (_lcOverlay) { _lcOverlay.remove(); _lcOverlay = null; }

  const canvas = document.createElement('canvas');
  canvas.width = COLS; canvas.height = ROWS;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(COLS, ROWS);
  const { data } = imgData;

  for (let i = 0; i < ROWS; i++) {
    for (let j = 0; j < COLS; j++) {
      const cls = _nlcdGrid[i * COLS + j];
      const entry = NLCD_CLASSES[cls];
      const [r, g, b] = entry ? entry.color : [180, 180, 180];
      const px = (i * COLS + j) * 4;
      data[px] = r; data[px + 1] = g; data[px + 2] = b; data[px + 3] = 185;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  const sw = _bounds.getSouthWest();
  const ne = _bounds.getNorthEast();
  _lcOverlay = L.imageOverlay(canvas.toDataURL(), [[sw.lat, sw.lng], [ne.lat, ne.lng]], {
    opacity: 1, interactive: false,
  });

  if (document.getElementById('pa-show-lc')?.checked !== false) {
    _lcOverlay.addTo(_map);
  }
}

// ── Simulation overlay (live) ─────────────────────────────────────────────────

function _startSimOverlay() {
  if (_simAnimId) cancelAnimationFrame(_simAnimId);
  if (!_map || !_bounds || !simState.renderSimToCanvas) return;

  const sw = _bounds.getSouthWest();
  const ne = _bounds.getNorthEast();

  const tick = () => {
    if (!simState.renderSimToCanvas) return;
    simState.renderSimToCanvas(_simCanvas);
    const url = _simCanvas.toDataURL();

    if (!_simOverlay) {
      _simOverlay = L.imageOverlay(url, [[sw.lat, sw.lng], [ne.lat, ne.lng]], {
        opacity: 0.78, interactive: false,
      });
      _simOverlay.addTo(_map);
    } else {
      _simOverlay.setUrl(url);
    }
    _simAnimId = requestAnimationFrame(tick);
  };

  _simAnimId = requestAnimationFrame(tick);
}

// ── Composition panel ─────────────────────────────────────────────────────────

function _renderComposition(composition) {
  const el = document.getElementById('pa-lc-comp');
  if (!el) return;
  const maxPct = composition[0]?.pct ?? 1;
  el.innerHTML = composition.slice(0, 10).map(item => `
    <div class="pa-comp-item" title="${item.name}: ${(item.pct * 100).toFixed(1)}%">
      <div class="pa-swatch" style="background:${item.hex}"></div>
      <span class="pa-comp-name">${item.name.replace('Developed, ', 'Dev. ')}</span>
      <div class="pa-bar-wrap"><div class="pa-bar" style="width:${(item.pct / maxPct) * 100}%;background:${item.hex}"></div></div>
      <span class="pa-pct">${(item.pct * 100).toFixed(0)}%</span>
    </div>
  `).join('');
}

// ── Run simulation ────────────────────────────────────────────────────────────

function _runSimulation() {
  if (!_patchGrid) return;

  // Push grid into the simulation engine
  if (simState.loadParcelGrid) simState.loadParcelGrid(_patchGrid);

  // Start live overlay if checked
  if (document.getElementById('pa-show-sim-overlay')?.checked) {
    _startSimOverlay();
  }

  // Switch to Mosaic Design tab and start simulation
  if (_onRunSim) _onRunSim();
}

// ── Export ────────────────────────────────────────────────────────────────────

function _doExport() {
  if (!_polygonGeoJson || !_patchGrid) return;

  // 1. Parcel boundary GeoJSON
  _download(
    new Blob([JSON.stringify(_polygonGeoJson, null, 2)], { type: 'application/json' }),
    'parcel-boundary.geojson'
  );

  // 2. Land cover grid CSV
  if (_nlcdGrid) {
    const rows = ['row,col,nlcd_class,nlcd_name,patch_type'];
    for (let i = 0; i < ROWS; i++) {
      for (let j = 0; j < COLS; j++) {
        const cls = _nlcdGrid[i * COLS + j];
        const entry = NLCD_CLASSES[cls] || { name: 'Unknown', patchKey: 'grass' };
        rows.push(`${i},${j},${cls},"${entry.name}",${entry.patchKey}`);
      }
    }
    setTimeout(() => _download(
      new Blob([rows.join('\n')], { type: 'text/csv' }),
      'land-cover-grid.csv'
    ), 200);
  }

  // 3. Composition summary CSV
  if (_composition) {
    const lines = ['nlcd_class,name,patch_type,pct'];
    for (const c of _composition) {
      lines.push(`${c.nlcdClass},"${c.name}",${c.patchKey},${(c.pct * 100).toFixed(2)}`);
    }
    setTimeout(() => _download(
      new Blob([lines.join('\n')], { type: 'text/csv' }),
      'land-cover-composition.csv'
    ), 400);
  }
}

function _download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── Utility ───────────────────────────────────────────────────────────────────

function _approxAreaKm2(bounds) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const midLat = (sw.lat + ne.lat) / 2;
  const dLat = ne.lat - sw.lat;
  const dLon = ne.lng - sw.lng;
  const kmLat = 111.32;
  const kmLon = 111.32 * Math.cos(midLat * Math.PI / 180);
  return Math.abs(dLat * kmLat * dLon * kmLon);
}
