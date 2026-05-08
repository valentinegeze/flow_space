/**
 * UI controls: Fire / Flood mode selector with focused panels per mode.
 * Light editorial theme — styles defined in styles.css.
 */

import { PATCH_TYPES, PATCH_PARAMS } from './patches.js';

function getPatchBehavior(key, p) {
  const behaviors = {
    [PATCH_TYPES.GRASS]:    'Moderate roughness; holds some water; moderate sediment source.',
    [PATCH_TYPES.FOREST]:   'High roughness, slow flow; high infiltration; traps sediment.',
    [PATCH_TYPES.WETLAND]:  'Moderate flow; very high infiltration (holds water); low erosion.',
    [PATCH_TYPES.BARE]:     'Low roughness, fast flow; minimal infiltration; high sediment source.',
    [PATCH_TYPES.URBAN]:    'Very low roughness, fast runoff; nearly no infiltration; some sediment.',
    [PATCH_TYPES.CORRIDOR]: 'Channel-like; fast flow, moderate infiltration; conveys water and sediment.',
    [PATCH_TYPES.WATER]:    'Water body; very low roughness, conveys flow; no infiltration or erosion.',
  };
  return behaviors[key] || '—';
}

// ── Shared builder helpers ────────────────────────────────────────────────────

function makeBtn(text, className, title) {
  const b = document.createElement('button');
  b.textContent = text;
  if (className) b.className = className;
  if (title) b.title = title;
  return b;
}

function makeSlider({ min, max, step, value, width = '100%' }) {
  const s = document.createElement('input');
  s.type = 'range';
  s.min = min; s.max = max;
  if (step !== undefined) s.step = step;
  s.value = value;
  s.style.width = width;
  return s;
}

function makeLabel(html) {
  const l = document.createElement('label');
  l.innerHTML = html;
  return l;
}

function sectionHead(text) {
  const d = document.createElement('div');
  d.className = 'mosaic-section-head';
  d.innerHTML = `<strong>${text}</strong>`;
  return d;
}

function buildPatchSection(controls, onUpdate) {
  const div = document.createElement('div');

  const brushLabel = makeLabel(
    `Brush size: <span id="brush-size-val">${controls.brushSize}</span>`
  );
  brushLabel.style.marginBottom = '4px';
  const brushSlider = makeSlider({ min: 1, max: 10, value: controls.brushSize });
  brushSlider.addEventListener('input', () => {
    controls.brushSize = Number(brushSlider.value);
    document.getElementById('brush-size-val').textContent = controls.brushSize;
    onUpdate?.();
  });
  div.appendChild(brushLabel);
  div.appendChild(brushSlider);

  // One row per land-cover type. Each row is a button with a colored square
  // followed by the type name — replaces the previous wrap-grid of bordered
  // pill-buttons because at small panel widths the names were getting cropped
  // and it was unclear which pill mapped to which color in the canvas.
  const list = document.createElement('div');
  list.className = 'mosaic-patch-list';
  const patchButtons = Object.entries(PATCH_PARAMS).map(([key, params]) => {
    const btn = document.createElement('button');
    btn.className = 'mosaic-patch-row';
    btn.dataset.key = key;
    btn.innerHTML = `
      <span class="mosaic-patch-swatch" style="background:${params.color};"></span>
      <span class="mosaic-patch-name">${params.name}</span>
    `;
    const refreshPatchBtn = () => {
      btn.classList.toggle('active', controls.activePatch === key);
    };
    refreshPatchBtn();
    btn.addEventListener('click', () => {
      controls.activePatch = key;
      controls.activeTool = 'paint';
      patchButtons.forEach(b => b.classList.toggle('active', b.dataset.key === controls.activePatch));
      onUpdate?.();
    });
    return btn;
  });
  patchButtons.forEach(b => list.appendChild(b));
  div.appendChild(list);

  const randomBtn = makeBtn('Randomize', 'mosaic-action-btn', 'Generate random patch landscape');
  randomBtn.style.marginTop = '8px';
  randomBtn.style.width = '100%';
  randomBtn.addEventListener('click', () => onUpdate?.('randomize'));
  div.appendChild(randomBtn);

  return div;
}

function buildTopoSection(controls, onUpdate) {
  const div = document.createElement('div');

  const sampleDems = {
    'Simple Slope': (n) => {
      const e = new Float32Array(n * n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) e[i*n+j] = (n-j)*0.01;
      return e;
    },
    Valley: (n) => {
      const e = new Float32Array(n * n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const x = (j-n/2)/(n/2), y = (i-n/2)/(n/2);
        e[i*n+j] = 100 - 30*(x*x + y*y*0.5) + 20*Math.sin(j*0.2)*Math.cos(i*0.15);
      }
      return e;
    },
    Ridge: (n) => {
      const e = new Float32Array(n * n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const x = (j-n/2)/(n/2);
        e[i*n+j] = 80 - 40*x*x + 15*Math.sin(i*0.15);
      }
      return e;
    },
    Channel: (n) => {
      const e = new Float32Array(n * n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const d = Math.abs(j-n/2);
        e[i*n+j] = 100 - Math.exp(-d*d/100)*25 - (n-i)*0.3 + 8*Math.sin(j*0.1);
      }
      return e;
    },
    Rolling: (n) => {
      const e = new Float32Array(n * n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
        e[i*n+j] = 80 + 25*Math.sin(i*0.12)*Math.cos(j*0.1) + 18*Math.sin((i+j)*0.08) - (n-i)*0.15;
      return e;
    },
    Dome: (n) => {
      const e = new Float32Array(n * n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const r = Math.sqrt((i-n/2)**2 + (j-n/2)**2) / (n/2);
        e[i*n+j] = Math.max(0, 100 - 60*r*r) + 5*Math.sin(j*0.2);
      }
      return e;
    },
    Gully: (n) => {
      const e = new Float32Array(n * n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const y=(i-n/2)/(n/2), x=(j-n/2)/(n/2);
        e[i*n+j] = 100 - 30*Math.exp(-y*y*4)*(1-Math.abs(x)*0.5) - i*0.2 + 5*Math.sin(j*0.15);
      }
      return e;
    },
  };

  // Set initial DEM
  if (!controls.demElevations) controls.demElevations = sampleDems['Simple Slope'](64);

  const demBtnsDiv = document.createElement('div');
  demBtnsDiv.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;';
  Object.keys(sampleDems).forEach(name => {
    const btn = makeBtn(name, 'mosaic-dem-btn', `Sample ${name} terrain`);
    btn.addEventListener('click', () => {
      controls.demElevations = sampleDems[name](64);
      onUpdate?.();
    });
    demBtnsDiv.appendChild(btn);
  });

  const demInput = document.createElement('input');
  demInput.type = 'file';
  demInput.accept = '.asc,.grd,.csv,.txt,.json';
  demInput.style.display = 'none';
  demInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const { loadDemFile } = await import('./dem.js');
    const elevs = await loadDemFile(file, 64, 64);
    if (elevs) { controls.demElevations = elevs; onUpdate?.(); }
    else alert('Could not parse DEM file. Try ASCII Grid (.asc), CSV, or JSON.');
    demInput.value = '';
  });
  const loadDemBtn = makeBtn('Load DEM', 'mosaic-action-btn');
  loadDemBtn.style.marginTop = '6px';
  loadDemBtn.addEventListener('click', () => demInput.click());

  const elevLinesLabel = document.createElement('label');
  elevLinesLabel.className = 'mosaic-flag-label';
  elevLinesLabel.style.marginTop = '8px';
  const elevCheck = document.createElement('input');
  elevCheck.type = 'checkbox';
  elevCheck.checked = controls.showElevationLines;
  elevCheck.addEventListener('change', () => { controls.showElevationLines = elevCheck.checked; onUpdate?.(); });
  elevLinesLabel.appendChild(elevCheck);
  elevLinesLabel.appendChild(document.createTextNode('Elevation contours'));

  div.appendChild(demBtnsDiv);
  div.appendChild(loadDemBtn);
  div.appendChild(demInput);
  div.appendChild(elevLinesLabel);
  return div;
}

function buildRunButtons(controls, onUpdate, resetMsg, resetLabel) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:6px;margin-top:14px;';

  const runBtn = makeBtn('Run', 'mosaic-action-btn run');
  runBtn.addEventListener('click', () => {
    controls.running = !controls.running;
    runBtn.textContent = controls.running ? 'Pause' : 'Run';
    runBtn.classList.toggle('running', controls.running);
    onUpdate?.();
  });

  const resetBtn = makeBtn(resetLabel, 'mosaic-action-btn');
  resetBtn.addEventListener('click', () => {
    controls.running = false;
    runBtn.textContent = 'Run';
    runBtn.classList.remove('running');
    onUpdate?.(resetMsg);
  });

  wrap.appendChild(runBtn);
  wrap.appendChild(resetBtn);
  return wrap;
}

function buildExportImport(onUpdate) {
  const outer = document.createElement('div');

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;margin-top:10px;';

  const exportBtn = makeBtn('Export', 'mosaic-action-btn', 'Export patch config as JSON');
  exportBtn.addEventListener('click', () => onUpdate?.('export'));

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try { onUpdate?.('import', JSON.parse(r.result)); }
      catch { alert('Invalid JSON file'); }
    };
    r.readAsText(f);
    fileInput.value = '';
  });
  const importBtn = makeBtn('Import', 'mosaic-action-btn', 'Import patch config from JSON');
  importBtn.addEventListener('click', () => fileInput.click());

  row.appendChild(exportBtn);
  row.appendChild(importBtn);
  row.appendChild(fileInput);
  outer.appendChild(row);

  const resetAllBtn = makeBtn('Reset All', 'mosaic-action-btn danger', 'Reload page — clears everything');
  resetAllBtn.style.cssText = 'display:block;width:100%;margin-top:6px;';
  resetAllBtn.addEventListener('click', () => onUpdate?.('resetAll'));
  outer.appendChild(resetAllBtn);

  return outer;
}

// ── Main UI factory ───────────────────────────────────────────────────────────

export function createUI(onUpdate) {
  const controls = {
    activePatch:         PATCH_TYPES.GRASS,
    rainfall:            50,
    slopeAngle:          270,
    slopeMagnitude:      0.01,
    running:             false,
    elevationMode:       'dem',
    demElevations:       null,
    showElevationLines:  true,
    showDrainageHeatmap: false,
    useLBM:              false,
    viewMode:            'design',
    sedimentMultiplier:  1,
    menuExpanded:        true,
    brushSize:           3,
    speedMultiplier:     1,
    simMode:             'fire',    // 'fire' | 'flood'
    windAngle:           225,
    windSpeed:           2.5,
    activeTool:          'paint',   // 'paint' | 'ignite' | 'water-source' | 'select'
    waterSourceRate:     0.04,
  };

  const mosaicContainer = document.getElementById('mosaic-container');
  if (!mosaicContainer) return { controls: {}, updateMetrics: () => {} };

  // ── Outer panel container (styled via #mosaic-controls in CSS) ────────────
  const container = document.createElement('div');
  container.id = 'mosaic-controls';
  mosaicContainer.appendChild(container);

  // ── Mode selector bar ─────────────────────────────────────────────────────
  const modeBar = document.createElement('div');
  modeBar.className = 'mosaic-mode-bar';

  // Step 2 (Model Fire) is fire-only now — the user-facing Flood toggle was
  // removed. Pre/post-fire flood comparison happens in Step 3 via the soil-
  // study runner. fireModeBtn is kept (as a label) so the existing event-
  // wiring further down still has a target without breaking; floodModeBtn is
  // never rendered.
  const fireModeBtn  = document.createElement('button');
  const floodModeBtn = document.createElement('button');   // not appended; kept for handler wiring
  fireModeBtn.className  = 'mosaic-mode-btn fire-active';
  fireModeBtn.textContent  = 'Fire';

  const arrowBtn = document.createElement('button');
  arrowBtn.className = 'mosaic-collapse-btn';
  arrowBtn.innerHTML = '&#9664;';
  arrowBtn.title = 'Collapse panel';

  const refreshModeBtns = () => {
    // Fire-only — keep the badge active styling.
    fireModeBtn.className = 'mosaic-mode-btn fire-active';
  };

  modeBar.appendChild(fireModeBtn);
  modeBar.appendChild(arrowBtn);
  container.appendChild(modeBar);

  // ── Collapsible menu content ──────────────────────────────────────────────
  const menuContent = document.createElement('div');
  menuContent.className = 'mosaic-menu-content';
  container.appendChild(menuContent);

  const toggleMenu = () => {
    controls.menuExpanded = !controls.menuExpanded;
    menuContent.style.display = controls.menuExpanded ? 'block' : 'none';
    arrowBtn.innerHTML = controls.menuExpanded ? '&#9664;' : '&#9654;';
    arrowBtn.title = controls.menuExpanded ? 'Collapse panel' : 'Expand panel';
  };
  arrowBtn.addEventListener('click', toggleMenu);

  // ── Fire panel ────────────────────────────────────────────────────────────
  const firePanelDiv = document.createElement('div');

  // Patch brush
  firePanelDiv.appendChild(sectionHead('Landscape'));
  firePanelDiv.appendChild(buildPatchSection(controls, onUpdate));

  // Topography. Wrapped so the entry-fork "Delineate a site" path can hide
  // it — when the parcel is real, the elevation comes from DEM and the
  // synthetic Terrain presets aren't useful.
  const terrainWrap = document.createElement('div');
  terrainWrap.id = 'mosaic-terrain-section';
  terrainWrap.appendChild(sectionHead('Terrain'));
  terrainWrap.appendChild(buildTopoSection(controls, onUpdate));
  firePanelDiv.appendChild(terrainWrap);

  // Ignite tool
  firePanelDiv.appendChild(sectionHead('Fire'));

  const igniteToolBtn = makeBtn('Ignite Tool', 'mosaic-tool-btn');
  const refreshIgniteBtn = () => {
    const active = controls.activeTool === 'ignite';
    igniteToolBtn.classList.toggle('active', active);
    igniteToolBtn.textContent = 'Ignite Tool';
  };
  igniteToolBtn.addEventListener('click', () => {
    controls.activeTool = controls.activeTool === 'ignite' ? 'paint' : 'ignite';
    refreshIgniteBtn();
    refreshSelectBtn();
    onUpdate?.();
  });
  firePanelDiv.appendChild(igniteToolBtn);

  // Wind direction
  const windAngleLbl = makeLabel(
    `Wind from: <span id="wind-angle-val">${controls.windAngle}</span>&deg;`
  );
  windAngleLbl.style.marginBottom = '2px';
  const windAngleSlider = makeSlider({ min: 0, max: 360, step: 5, value: controls.windAngle });
  windAngleSlider.addEventListener('input', () => {
    controls.windAngle = Number(windAngleSlider.value);
    document.getElementById('wind-angle-val').textContent = controls.windAngle;
    onUpdate?.();
  });
  firePanelDiv.appendChild(windAngleLbl);
  firePanelDiv.appendChild(windAngleSlider);

  // Wind speed
  const windSpeedLbl = makeLabel(
    `Wind speed: <span id="wind-speed-val">${controls.windSpeed.toFixed(1)}</span>`
  );
  windSpeedLbl.style.cssText = 'margin-top:6px;margin-bottom:2px;';
  const windSpeedSlider = makeSlider({ min: 0, max: 5, step: 0.1, value: controls.windSpeed });
  windSpeedSlider.addEventListener('input', () => {
    controls.windSpeed = Number(windSpeedSlider.value);
    document.getElementById('wind-speed-val').textContent = controls.windSpeed.toFixed(1);
    onUpdate?.();
  });
  firePanelDiv.appendChild(windSpeedLbl);
  firePanelDiv.appendChild(windSpeedSlider);

  const clearFireBtn = makeBtn('Clear Fire', 'mosaic-action-btn danger');
  clearFireBtn.style.cssText = 'margin-top:8px;width:100%;';
  clearFireBtn.addEventListener('click', () => onUpdate?.('clear-fire'));
  firePanelDiv.appendChild(clearFireBtn);

  // View modes — fire
  firePanelDiv.appendChild(sectionHead('View'));
  const fireViewDiv = document.createElement('div');
  fireViewDiv.style.cssText = 'display:flex;gap:4px;';
  const fireViewModes = [
    { id: 'design', label: 'Land cover', title: 'Patch colors with fire overlay' },
    { id: 'fuel',   label: 'Fuel Risk',  title: 'Heatmap of fuelLoad' },
  ];
  const fireViewBtns = fireViewModes.map(({ id, label, title }) => {
    const btn = makeBtn(label, 'mosaic-view-btn', title);
    const refresh = () => {
      btn.classList.toggle('active', controls.viewMode === id);
      // Toggle the fuel-risk legend's visibility based on current view.
      const legend = document.getElementById('fuel-risk-legend');
      if (legend) legend.style.display = controls.viewMode === 'fuel' ? '' : 'none';
    };
    btn.addEventListener('click', () => {
      controls.viewMode = id;
      fireViewBtns.forEach(b => b._r());
    });
    btn._r = refresh;
    refresh();
    return btn;
  });
  fireViewBtns.forEach(b => fireViewDiv.appendChild(b));
  firePanelDiv.appendChild(fireViewDiv);

  // Fuel-risk legend — visible only when the Fuel Risk view is active. Mirrors
  // the colormap from the draw loop in sketch.js (Layer 1, viewMode === 'fuel'):
  //   no fuel  → deep blue
  //   below percolation threshold (~0.41) → blue → green
  //   above threshold  → yellow → red (high risk)
  const fuelLegend = document.createElement('div');
  fuelLegend.id = 'fuel-risk-legend';
  fuelLegend.className = 'mosaic-fuel-legend';
  fuelLegend.style.display = controls.viewMode === 'fuel' ? '' : 'none';
  fuelLegend.innerHTML = `
    <div class="fuel-legend-title">Fuel risk · fuelLoad colormap</div>
    <div class="fuel-legend-bar">
      <span class="fuel-legend-stop" style="background:#2864c8;"></span>
      <span class="fuel-legend-stop" style="background:#3585c8;"></span>
      <span class="fuel-legend-stop" style="background:#6da2a0;"></span>
      <span class="fuel-legend-stop" style="background:#a0c060;"></span>
      <span class="fuel-legend-stop" style="background:#e6e600;"></span>
      <span class="fuel-legend-stop" style="background:#ff7a00;"></span>
      <span class="fuel-legend-stop" style="background:#ff0000;"></span>
    </div>
    <div class="fuel-legend-axis">
      <span>0.0<br>no fuel</span>
      <span style="text-align:center;">0.41<br>φ<sub>c</sub> threshold</span>
      <span style="text-align:right;">1.0<br>max</span>
    </div>
    <div class="fuel-legend-note">
      Below the percolation threshold φ<sub>c</sub> ≈ 0.41 the fuel can't form a
      connected cluster — fires fizzle. Above it, ignition can sweep the parcel.
    </div>
  `;
  firePanelDiv.appendChild(fuelLegend);

  // Run/Reset
  firePanelDiv.appendChild(buildRunButtons(controls, onUpdate, 'clear-fire', 'Reset Fire'));
  firePanelDiv.appendChild(buildExportImport(onUpdate));

  // ── Flood panel ───────────────────────────────────────────────────────────
  const floodPanelDiv = document.createElement('div');

  // Patch brush
  floodPanelDiv.appendChild(sectionHead('Landscape'));
  floodPanelDiv.appendChild(buildPatchSection(controls, onUpdate));

  // Topography
  floodPanelDiv.appendChild(sectionHead('Terrain'));
  floodPanelDiv.appendChild(buildTopoSection(controls, onUpdate));

  // Rainfall
  floodPanelDiv.appendChild(sectionHead('Water'));

  const rainLbl = makeLabel(
    `Rainfall: <span id="rain-val">${controls.rainfall}</span> mm/hr`
  );
  rainLbl.style.marginBottom = '2px';
  const rainSlider = makeSlider({ min: 0, max: 150, value: controls.rainfall });
  rainSlider.addEventListener('input', () => {
    controls.rainfall = Number(rainSlider.value);
    document.getElementById('rain-val').textContent = controls.rainfall;
    onUpdate?.();
  });
  floodPanelDiv.appendChild(rainLbl);
  floodPanelDiv.appendChild(rainSlider);

  // Point source tool
  const waterSourceToolBtn = makeBtn('Point Source', 'mosaic-tool-btn');
  const refreshWaterSourceBtn = () => {
    const active = controls.activeTool === 'water-source';
    waterSourceToolBtn.classList.toggle('active', active);
    waterSourceToolBtn.textContent = 'Point Source';
  };
  waterSourceToolBtn.addEventListener('click', () => {
    controls.activeTool = controls.activeTool === 'water-source' ? 'paint' : 'water-source';
    refreshWaterSourceBtn();
    refreshSelectBtn();
    onUpdate?.();
  });
  floodPanelDiv.appendChild(waterSourceToolBtn);

  const floodHint = document.createElement('div');
  floodHint.textContent = 'Shift+drag on canvas to flood an area';
  floodHint.style.cssText = 'font-size:10px;color:#999;margin-top:4px;';
  floodPanelDiv.appendChild(floodHint);

  const wsRateLbl = makeLabel(
    `Source rate: <span id="ws-rate-val">${controls.waterSourceRate.toFixed(2)}</span> m/step`
  );
  wsRateLbl.style.cssText = 'margin-top:8px;margin-bottom:2px;';
  const wsRateSlider = makeSlider({ min: 0.01, max: 0.2, step: 0.01, value: controls.waterSourceRate });
  wsRateSlider.addEventListener('input', () => {
    controls.waterSourceRate = Number(wsRateSlider.value);
    document.getElementById('ws-rate-val').textContent = controls.waterSourceRate.toFixed(2);
    onUpdate?.();
  });
  floodPanelDiv.appendChild(wsRateLbl);
  floodPanelDiv.appendChild(wsRateSlider);

  const clearSourcesBtn = makeBtn('Clear Sources', 'mosaic-action-btn');
  clearSourcesBtn.style.cssText = 'margin-top:6px;width:100%;';
  clearSourcesBtn.addEventListener('click', () => onUpdate?.('clear-sources'));
  floodPanelDiv.appendChild(clearSourcesBtn);

  // Extra toggles
  floodPanelDiv.appendChild(sectionHead('Options'));

  const makeFlagLabel = (text, initial, onChange) => {
    const lbl = document.createElement('label');
    lbl.className = 'mosaic-flag-label';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = initial;
    chk.addEventListener('change', () => onChange(chk.checked));
    lbl.appendChild(chk);
    lbl.appendChild(document.createTextNode(text));
    return lbl;
  };

  floodPanelDiv.appendChild(makeFlagLabel('Drainage network',    controls.showDrainageHeatmap, v => { controls.showDrainageHeatmap = v; }));
  floodPanelDiv.appendChild(makeFlagLabel('LBM density field',   controls.useLBM,              v => { controls.useLBM = v; }));

  const sedLbl = makeLabel(
    `Sediment rate: <span id="sediment-val">${controls.sedimentMultiplier}</span>&times;`
  );
  sedLbl.style.cssText = 'margin-top:8px;margin-bottom:2px;';
  const sedSlider = makeSlider({ min: 0.5, max: 5, step: 0.25, value: controls.sedimentMultiplier });
  sedSlider.addEventListener('input', () => {
    controls.sedimentMultiplier = Number(sedSlider.value);
    document.getElementById('sediment-val').textContent = controls.sedimentMultiplier;
    onUpdate?.();
  });
  floodPanelDiv.appendChild(sedLbl);
  floodPanelDiv.appendChild(sedSlider);

  const speedLbl = makeLabel(
    `Speed: <span id="speed-val">${controls.speedMultiplier}</span>&times;`
  );
  speedLbl.style.cssText = 'margin-top:8px;margin-bottom:2px;';
  const speedSlider = makeSlider({ min: 1, max: 8, value: controls.speedMultiplier });
  speedSlider.addEventListener('input', () => {
    controls.speedMultiplier = Number(speedSlider.value);
    document.getElementById('speed-val').textContent = controls.speedMultiplier;
    onUpdate?.();
  });
  floodPanelDiv.appendChild(speedLbl);
  floodPanelDiv.appendChild(speedSlider);

  // View modes — flood
  floodPanelDiv.appendChild(sectionHead('View'));
  const floodViewDiv = document.createElement('div');
  floodViewDiv.style.cssText = 'display:flex;gap:4px;';
  const floodViewModes = [
    { id: 'design',   label: 'Design',   title: 'Full patch colors with water overlay' },
    { id: 'flow',     label: 'Flow',     title: 'Desaturated patches, prominent streamlines' },
    { id: 'sediment', label: 'Sediment', title: 'Amplified sediment deposition view' },
  ];
  const floodViewBtns = floodViewModes.map(({ id, label, title }) => {
    const btn = makeBtn(label, 'mosaic-view-btn', title);
    const refresh = () => {
      btn.classList.toggle('active', controls.viewMode === id);
    };
    btn.addEventListener('click', () => {
      controls.viewMode = id;
      floodViewBtns.forEach(b => b._r());
    });
    btn._r = refresh;
    refresh();
    return btn;
  });
  floodViewBtns.forEach(b => floodViewDiv.appendChild(b));
  floodPanelDiv.appendChild(floodViewDiv);

  // Run/Reset + extra flood actions
  floodPanelDiv.appendChild(buildRunButtons(controls, onUpdate, 'reset', 'Reset Water'));

  const restoreBtn = makeBtn('Restore Landscape', 'mosaic-action-btn', 'Replace ~30% of patches with wetland/forest');
  restoreBtn.style.cssText = 'margin-top:6px;width:100%;';
  restoreBtn.addEventListener('click', () => onUpdate?.('restore'));
  floodPanelDiv.appendChild(restoreBtn);

  floodPanelDiv.appendChild(buildExportImport(onUpdate));

  // ── Select tool (shared across modes) ────────────────────────────────────
  const selectToolBtn = makeBtn('Pick cells (tree zoom)', 'mosaic-tool-btn');
  const refreshSelectBtn = () => {
    const active = controls.activeTool === 'select';
    selectToolBtn.classList.toggle('active', active);
    selectToolBtn.textContent = 'Pick cells (tree zoom)';
  };
  selectToolBtn.addEventListener('click', () => {
    controls.activeTool = controls.activeTool === 'select' ? 'paint' : 'select';
    refreshSelectBtn();
    refreshIgniteBtn();
    refreshWaterSourceBtn();
    onUpdate?.();
  });
  menuContent.appendChild(selectToolBtn);

  // ── Mount panels, set initial visibility ─────────────────────────────────
  menuContent.appendChild(firePanelDiv);
  menuContent.appendChild(floodPanelDiv);

  const switchMode = (mode) => {
    controls.simMode  = mode;
    controls.activeTool = 'paint';
    controls.running = false;
    if (mode === 'fire')  controls.viewMode = 'design';
    if (mode === 'flood') controls.viewMode = 'design';

    firePanelDiv.style.display   = mode === 'fire'  ? 'block' : 'none';
    floodPanelDiv.style.display  = mode === 'flood' ? 'block' : 'none';
    if (chartCanvas) chartCanvas.style.display = mode === 'fire' ? 'none' : 'block';

    refreshModeBtns();
    refreshSelectBtn();
    refreshIgniteBtn();
    refreshWaterSourceBtn();
    onUpdate?.();
  };

  fireModeBtn.addEventListener('click',  () => switchMode('fire'));
  floodModeBtn.addEventListener('click', () => switchMode('flood'));

  // ── Metrics div ───────────────────────────────────────────────────────────
  const metricsDiv = document.createElement('div');
  metricsDiv.id = 'mosaic-metrics';
  const metricsText = document.createElement('div');
  metricsText.id = 'mosaic-metrics-text';
  metricsText.innerHTML = 'Conn: — | Particles: —';
  metricsDiv.appendChild(metricsText);
  container.appendChild(metricsDiv);

  // ── Time-series chart canvas ──────────────────────────────────────────────
  const CHART_W = 220;
  const CHART_H = 400;
  const PANEL_H = CHART_H / 4;

  const chartCanvas = document.createElement('canvas');
  chartCanvas.width  = CHART_W;
  chartCanvas.height = CHART_H;
  chartCanvas.className = 'mosaic-chart-canvas';
  mosaicContainer.appendChild(chartCanvas);

  // Initialise to fire mode (must be after chartCanvas is defined)
  switchMode('fire');

  // ── Info button / modal ───────────────────────────────────────────────────
  const infoBtn = makeBtn('i Info', 'mosaic-info-btn', 'Model documentation');
  mosaicContainer.appendChild(infoBtn);

  const infoModal = document.createElement('div');
  infoModal.id = 'mosaic-info-modal';
  const infoPanel = document.createElement('div');
  infoPanel.className = 'info-panel';

  const patchTable = Object.entries(PATCH_PARAMS).map(([key, p]) =>
    `<tr>
      <td style="color:${p.color};font-weight:600">${p.name}</td>
      <td>${p.manningN}</td>
      <td>${p.infiltration}</td>
      <td>${p.erodibility}</td>
      <td style="color:#999;font-size:10px">${p.fuelLoad ?? 0}</td>
      <td style="font-size:11px;color:#666">${getPatchBehavior(key, p)}</td>
    </tr>`
  ).join('');

  infoPanel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
      <h2>Land Mosaic Flow Model</h2>
      <button id="info-modal-close" class="info-close-btn">Close</button>
    </div>

    <h3>Model overview</h3>
    <p>This model combines Richard T.T. Forman's patch-matrix-corridor framework with overland flow physics and a FireSweep-style percolation wildfire model.</p>

    <h3>Fire model — percolation / FireSweep</h3>
    <p>Fire spread is a cellular automaton on a 64&times;64 grid. Each tick, every BURNING cell attempts to ignite its 8 unburned neighbors exactly once. The ignition probability is:</p>
    <p><code>P = min(1, fuelLoad &times; continuity &times; windFactor &times; slopeFactor)</code></p>
    <p>Each unburned cell receives <em>one roll only</em> regardless of how many burning neighbors it has. This makes <strong>fuelLoad = density p</strong> in site-percolation theory (8-neighbor threshold p<sub>c</sub> &asymp; 0.41). Below p<sub>c</sub>: fire burns out. Above: fire sweeps the landscape.</p>

    <h3>Flood model — Manning's equation</h3>
    <p><code>v = (1/n) &times; R<sup>2/3</sup> &times; S<sup>1/2</sup></code><br>
    Lower roughness <em>n</em> = faster flow. Flux routes via D8 proportional to gradient.</p>

    <h3>Patch parameters</h3>
    <table>
      <thead>
        <tr>
          <th>Patch</th><th>n</th><th>Infilt</th><th>Erod.</th><th>FuelLoad</th><th>Behavior</th>
        </tr>
      </thead>
      <tbody>${patchTable}</tbody>
    </table>
  `;

  infoModal.appendChild(infoPanel);
  document.body.appendChild(infoModal);
  infoBtn.addEventListener('click', () => { infoModal.style.display = 'flex'; });
  infoPanel.querySelector('#info-modal-close').addEventListener('click', () => { infoModal.style.display = 'none'; });
  infoModal.addEventListener('click', e => { if (e.target === infoModal) infoModal.style.display = 'none'; });

  // ── Chart drawing ─────────────────────────────────────────────────────────
  const PANELS_CFG = [
    { key: 'runoffRatio',   label: 'RUNOFF',  unit: '0–1',      color: '#3c78b4', fmt: v => v.toFixed(2) },
    { key: 'meanStorage',   label: 'STORAGE', unit: 'mm depth', color: '#2a9a7a', fmt: v => (v*1000).toFixed(2) },
    { key: 'etFraction',    label: 'ET',      unit: '0–1',      color: '#5a9a5a', fmt: v => v.toFixed(2) },
    { key: 'concentration', label: 'CONCEN.', unit: '0–1',      color: '#c08830', fmt: v => v.toFixed(2) },
  ];

  function drawChartPanel(chartHistory, interventionMarkers, running) {
    if (chartCanvas.style.display === 'none') return;
    const ctx = chartCanvas.getContext('2d');
    ctx.clearRect(0, 0, CHART_W, CHART_H);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillRect(0, 0, CHART_W, CHART_H);
    if (!running) {
      ctx.fillStyle = '#bbb'; ctx.font = '11px Inter, system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('PAUSED', CHART_W/2, CHART_H/2);
      ctx.textAlign = 'left';
    }
    const n = chartHistory.length;
    const PAD = 4;
    PANELS_CFG.forEach((panel, pi) => {
      const py = pi * PANEL_H;
      if (pi > 0) {
        ctx.strokeStyle = '#e5e5e5'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(CHART_W, py); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.04)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, py + PANEL_H*0.5); ctx.lineTo(CHART_W, py + PANEL_H*0.5); ctx.stroke();
      if (n < 2) {
        ctx.fillStyle = panel.color; ctx.font = 'bold 9px Inter, system-ui';
        ctx.fillText(panel.label, PAD, py + 12); return;
      }
      let maxVal = 1e-9;
      for (const d of chartHistory) if (d[panel.key] > maxVal) maxVal = d[panel.key];
      maxVal *= 1.12;
      const chartTop = py + PAD + 16, chartBot = py + PANEL_H - PAD;
      const chartH = chartBot - chartTop;
      const chartLeft = PAD, chartRight = CHART_W - PAD;
      const cW = chartRight - chartLeft;

      if (interventionMarkers?.length > 0) {
        ctx.strokeStyle = 'rgba(192,80,48,0.15)'; ctx.lineWidth = 1;
        for (const m of interventionMarkers) {
          const x = chartLeft + cW * (1 - m.framesAgo / 300);
          if (x < chartLeft || x > chartRight) continue;
          ctx.beginPath(); ctx.moveTo(x, chartTop); ctx.lineTo(x, chartBot); ctx.stroke();
        }
      }

      ctx.strokeStyle = panel.color + '44'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const x = chartLeft + cW * k / Math.max(1, n-1);
        const y = chartBot - chartH * Math.min(1, chartHistory[k][panel.key] / maxVal);
        k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.strokeStyle = panel.color; ctx.lineWidth = 1.5;
      const smooth = 8;
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        let sum = 0, cnt = 0;
        for (let s = Math.max(0, k-smooth); s <= Math.min(n-1, k+smooth); s++) {
          sum += chartHistory[s][panel.key]; cnt++;
        }
        const x = chartLeft + cW * k / Math.max(1, n-1);
        const y = chartBot - chartH * Math.min(1, (sum/cnt) / maxVal);
        k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      const last = chartHistory[n-1][panel.key];
      ctx.fillStyle = panel.color; ctx.font = 'bold 9px Inter, system-ui';
      ctx.fillText(panel.label, PAD, py + 12);
      ctx.fillStyle = '#666'; ctx.font = '9px Inter, system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(panel.fmt(last), CHART_W - PAD, py + 12);
      ctx.textAlign = 'left';
    });
  }

  // ── Metrics updater ───────────────────────────────────────────────────────
  function updateMetrics({ chartHistory, interventionMarkers, connectivity, sedimentCount }) {
    if (controls.simMode === 'flood') {
      metricsText.innerHTML = `Conn: ${connectivity?.toFixed(3) ?? '—'} | Particles: ${sedimentCount ?? '—'}`;
      drawChartPanel(chartHistory, interventionMarkers, controls.running);
    } else {
      metricsText.innerHTML = '';
    }
  }

  return { controls, updateMetrics };
}
