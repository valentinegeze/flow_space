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
import { sharedState, emit } from './sharedState.js';
import { fetchSSURGOSimple } from './ssurgo-fetch.js';

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
    // Delay init slightly so the container has real dimensions after display change
    setTimeout(() => {
      _initMap();
      // Invalidate once more after tiles load
      setTimeout(() => _map && _map.invalidateSize(), 200);
    }, 50);
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
        shapeOptions: { color: '#c05030', weight: 2, fillOpacity: 0.06 },
      },
      rectangle: {
        shapeOptions: { color: '#c05030', weight: 2, fillOpacity: 0.06 },
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
  <div id="pa-map-wrap">
    <div id="pa-map"></div>

    <!-- Floating search bar (optional, top-left) -->
    <div id="pa-search-float">
      <div id="pa-search-row">
        <input id="pa-search-input" type="text" placeholder="Search location (optional)…" autocomplete="off"/>
        <button id="pa-search-btn">Go</button>
      </div>
      <div id="pa-search-results"></div>
    </div>

    <!-- Draw hint -->
    <div id="pa-draw-hint">Use the polygon or rectangle tool to delineate your site</div>

    <!-- Floating info panel (appears after polygon drawn) -->
    <div id="pa-info-float">
      <div class="pa-panel-title">Site Details</div>
      <div id="pa-parcel-info"></div>

      <div id="pa-lc-status"></div>
      <div id="pa-lc-comp"></div>

      <div class="pa-row" id="pa-confirm-row">
        <button id="pa-load-btn">Load Land Cover</button>
        <button id="pa-redraw-btn" class="pa-secondary">Redraw</button>
      </div>

      <label class="pa-check-row" id="pa-lc-check-row" style="display:none">
        <input type="checkbox" id="pa-show-lc" checked> Show land cover overlay
      </label>

      <div class="pa-row" id="pa-sim-row" style="display:none">
        <button id="pa-run-btn">Proceed to Fire Model</button>
        <button id="pa-export-btn" class="pa-secondary">Export</button>
      </div>

      <label class="pa-check-row" id="pa-overlay-row" style="display:none">
        <input type="checkbox" id="pa-show-sim-overlay" checked> Live simulation overlay
      </label>

      <button id="pa-clear-btn" class="pa-secondary" style="display:none;margin-top:8px;width:100%">Clear Shape</button>
    </div>
  </div>
</div>`;
}

// Styles are now in styles.css — no injection needed.

// ── Workflow step management ──────────────────────────────────────────────────

function _setStep(step) {
  const infoFloat = document.getElementById('pa-info-float');
  const drawHint = document.getElementById('pa-draw-hint');
  const confirmRow = document.getElementById('pa-confirm-row');
  const lcCheckRow = document.getElementById('pa-lc-check-row');
  const simRow = document.getElementById('pa-sim-row');
  const overlayRow = document.getElementById('pa-overlay-row');

  // Step 0/1: waiting for polygon — show draw hint, hide info panel
  if (step <= 1) {
    if (infoFloat) infoFloat.style.display = 'none';
    if (drawHint) drawHint.style.display = 'block';
    return;
  }

  // Step 2+: polygon drawn — show info panel, hide draw hint
  if (drawHint) drawHint.style.display = 'none';
  if (infoFloat) infoFloat.style.display = 'block';

  // Show/hide sections within the floating panel based on step
  if (confirmRow) confirmRow.style.display = step === 2 ? 'flex' : 'none';
  if (lcCheckRow) lcCheckRow.style.display = step >= 4 ? 'flex' : 'none';
  if (simRow) simRow.style.display = step >= 4 ? 'flex' : 'none';
  if (overlayRow) overlayRow.style.display = step >= 4 ? 'flex' : 'none';
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
  const clearBtn = document.getElementById('pa-clear-btn');
  if (clearBtn) clearBtn.style.display = 'block';
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
    const b = { west: sw.lng, south: sw.lat, east: ne.lng, north: ne.lat };
    simState.parcelBounds = b;

    // Fetch real SSURGO soil data for this parcel
    fetchSSURGOSimple(b).then(data => {
      if (data) {
        sharedState.ssurgoData = data;
        emit();
      }
    });
  } else {
    simState.parcelBounds = null;
    sharedState.ssurgoData = null;
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
  if (resetToStep1) _setStep(0);
}

function _updateParcelInfo() {
  const infoEl = document.getElementById('pa-parcel-info');
  if (!infoEl || !_bounds) return;
  const sw = _bounds.getSouthWest();
  const ne = _bounds.getNorthEast();
  const km2 = _approxAreaKm2(_bounds);
  infoEl.innerHTML = `
    <div>${sw.lat.toFixed(4)}°N, ${sw.lng.toFixed(4)}°E  →  ${ne.lat.toFixed(4)}°N, ${ne.lng.toFixed(4)}°E</div>
    <div style="color:#c05030;margin-top:3px">≈ ${km2.toFixed(2)} km² · ${(km2 * 100).toFixed(0)} ha</div>
  `;
}

// ── NLCD land cover fetch ─────────────────────────────────────────────────────

async function _loadLandCover() {
  if (!_polygon || !_bounds) return;
  // Show loading state
  const confirmRow = document.getElementById('pa-confirm-row');
  if (confirmRow) confirmRow.style.display = 'none';

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
