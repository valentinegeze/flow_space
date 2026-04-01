/**
 * UI controls: Fire / Flood mode selector with focused panels per mode.
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

function makeBtn(text, css, title) {
  const b = document.createElement('button');
  b.textContent = text;
  b.style.cssText = css;
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

function makeLabel(html, css = '') {
  const l = document.createElement('label');
  l.innerHTML = html;
  l.style.cssText = `display:block;${css}`;
  return l;
}

function sectionHead(text) {
  const d = document.createElement('div');
  d.style.cssText = 'margin-top:14px;margin-bottom:6px;border-top:1px solid #2a2a36;padding-top:10px;';
  d.innerHTML = `<strong style="color:#c8c8d8;font-size:12px;letter-spacing:.05em">${text}</strong>`;
  return d;
}

function buildPatchSection(controls, onUpdate) {
  const div = document.createElement('div');

  const brushLabel = makeLabel(
    `Brush size: <span id="brush-size-val">${controls.brushSize}</span>`,
    'margin-bottom:4px;font-size:12px;'
  );
  const brushSlider = makeSlider({ min: 1, max: 10, value: controls.brushSize });
  brushSlider.addEventListener('input', () => {
    controls.brushSize = Number(brushSlider.value);
    document.getElementById('brush-size-val').textContent = controls.brushSize;
    onUpdate?.();
  });
  div.appendChild(brushLabel);
  div.appendChild(brushSlider);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin-top:6px;';
  const patchButtons = Object.entries(PATCH_PARAMS).map(([key, params]) => {
    const btn = makeBtn(params.name, `
      padding:5px 9px; border:2px solid ${params.color};
      background:${controls.activePatch === key ? params.color + '40' : 'transparent'};
      color:${params.color}; border-radius:4px; cursor:pointer; font-size:11px;
    `);
    btn.dataset.key = key;
    btn.addEventListener('click', () => {
      controls.activePatch = key;
      controls.activeTool = 'paint';
      patchButtons.forEach(b => {
        const k = b.dataset.key;
        const p = PATCH_PARAMS[k];
        b.style.background = controls.activePatch === k ? p.color + '40' : 'transparent';
      });
      onUpdate?.();
    });
    return btn;
  });
  patchButtons.forEach(b => grid.appendChild(b));
  div.appendChild(grid);

  const randomBtn = makeBtn('Randomize', `
    margin-top:8px; padding:6px 12px; background:#4a4a6a;
    color:white; border:none; border-radius:4px; cursor:pointer;
    font-size:12px; width:100%;
  `, 'Generate random patch landscape');
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
  demBtnsDiv.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin-top:4px;';
  Object.keys(sampleDems).forEach(name => {
    const btn = makeBtn(name, `
      padding:3px 7px; background:#4a6a5a; color:white;
      border:none; border-radius:3px; cursor:pointer; font-size:10px;
    `, `Sample ${name} terrain`);
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
  const loadDemBtn = makeBtn('Load DEM', `
    padding:4px 10px; background:#3a5a7a; color:white;
    border:none; border-radius:3px; cursor:pointer; font-size:11px; margin-top:6px;
  `);
  loadDemBtn.addEventListener('click', () => demInput.click());

  const elevLinesLabel = document.createElement('label');
  elevLinesLabel.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer;font-size:12px;';
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

  const runBtn = makeBtn('Run', `
    flex:1; padding:8px 0; background:#4a7c59; color:white;
    border:none; border-radius:4px; cursor:pointer; font-size:13px;
  `);
  runBtn.addEventListener('click', () => {
    controls.running = !controls.running;
    runBtn.textContent = controls.running ? 'Pause' : 'Run';
    runBtn.style.background = controls.running ? '#c75a3a' : '#4a7c59';
    onUpdate?.();
  });

  const resetBtn = makeBtn(resetLabel, `
    flex:1; padding:8px 0; background:#555; color:white;
    border:none; border-radius:4px; cursor:pointer; font-size:12px;
  `);
  resetBtn.addEventListener('click', () => {
    controls.running = false;
    runBtn.textContent = 'Run';
    runBtn.style.background = '#4a7c59';
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

  const exportBtn = makeBtn('Export', `
    flex:1; padding:6px 0; background:#3d5a7d; color:white;
    border:none; border-radius:4px; cursor:pointer; font-size:12px;
  `, 'Export patch config as JSON');
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
  const importBtn = makeBtn('Import', `
    flex:1; padding:6px 0; background:#3d5a7d; color:white;
    border:none; border-radius:4px; cursor:pointer; font-size:12px;
  `, 'Import patch config from JSON');
  importBtn.addEventListener('click', () => fileInput.click());

  row.appendChild(exportBtn);
  row.appendChild(importBtn);
  row.appendChild(fileInput);
  outer.appendChild(row);

  const resetAllBtn = makeBtn('Reset All', `
    display:block; width:100%; margin-top:6px; padding:6px 0;
    background:#4a2020; color:#cc8888; border:1px solid #7a3030;
    border-radius:4px; cursor:pointer; font-size:12px;
  `, 'Reload page — clears everything');
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
    activeTool:          'paint',   // 'paint' | 'ignite' | 'water-source'
    waterSourceRate:     0.04,
  };

  const mosaicContainer = document.getElementById('mosaic-container');
  if (!mosaicContainer) return { controls: {}, updateMetrics: () => {} };

  // ── Outer panel container ─────────────────────────────────────────────────
  const container = document.createElement('div');
  container.id = 'mosaic-controls';
  container.style.cssText = `
    position: absolute; top: 10px; left: 10px;
    background: rgba(22, 22, 32, 0.98);
    padding: 0; border-radius: 8px;
    font-family: system-ui, sans-serif; font-size: 13px; color: #e0e0e0;
    z-index: 100; max-width: 270px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.6);
    overflow: hidden; pointer-events: auto;
  `;
  mosaicContainer.appendChild(container);

  // ── Mode selector bar ─────────────────────────────────────────────────────
  const modeBar = document.createElement('div');
  modeBar.style.cssText = `
    display: flex; gap: 0;
    background: rgba(16, 16, 24, 0.98);
    border-bottom: 1px solid #2a2a40;
  `;

  const fireModeBtn  = document.createElement('button');
  const floodModeBtn = document.createElement('button');
  const modeBtnBase = `
    flex:1; padding:9px 0; border:none; cursor:pointer;
    font-size:13px; font-weight:600; letter-spacing:.03em;
    transition: background 0.15s, color 0.15s;
  `;
  fireModeBtn.textContent  = 'Fire';
  floodModeBtn.textContent = 'Flood';
  fireModeBtn.style.cssText  = modeBtnBase;
  floodModeBtn.style.cssText = modeBtnBase;

  const arrowBtn = document.createElement('button');
  arrowBtn.innerHTML = '&#9664;';
  arrowBtn.title = 'Collapse panel';
  arrowBtn.style.cssText = `
    background:transparent; border:none; color:#888;
    font-size:13px; cursor:pointer; padding:9px 10px;
  `;

  const refreshModeBtns = () => {
    const isFire = controls.simMode === 'fire';
    fireModeBtn.style.background  = isFire  ? 'rgba(200,80,30,0.25)' : 'transparent';
    fireModeBtn.style.color        = isFire  ? '#ff8c42' : '#666';
    fireModeBtn.style.borderRight  = isFire  ? 'none' : '1px solid #2a2a40';
    floodModeBtn.style.background  = !isFire ? 'rgba(40,100,200,0.25)' : 'transparent';
    floodModeBtn.style.color       = !isFire ? '#4a9eff' : '#666';
    floodModeBtn.style.borderRight = 'none';
  };

  modeBar.appendChild(fireModeBtn);
  modeBar.appendChild(floodModeBtn);
  modeBar.appendChild(arrowBtn);
  container.appendChild(modeBar);

  // ── Collapsible menu content ──────────────────────────────────────────────
  const menuContent = document.createElement('div');
  menuContent.style.cssText = 'padding:10px 14px 14px;';
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

  // Topography
  firePanelDiv.appendChild(sectionHead('Terrain'));
  firePanelDiv.appendChild(buildTopoSection(controls, onUpdate));

  // Ignite tool
  firePanelDiv.appendChild(sectionHead('Fire'));

  const igniteToolBtn = makeBtn('Ignite Tool', `
    display:block; width:100%; padding:7px 10px;
    border:2px solid #ff6a20; background:transparent; color:#ff8c42;
    border-radius:4px; cursor:pointer; font-size:12px; margin-bottom:8px;
  `);
  const refreshIgniteBtn = () => {
    const active = controls.activeTool === 'ignite';
    igniteToolBtn.style.background  = active ? '#ff6a2040' : 'transparent';
    igniteToolBtn.style.fontWeight  = active ? 'bold' : 'normal';
    igniteToolBtn.textContent       = active ? 'Ignite Tool (ON)' : 'Ignite Tool';
  };
  igniteToolBtn.addEventListener('click', () => {
    controls.activeTool = controls.activeTool === 'ignite' ? 'paint' : 'ignite';
    refreshIgniteBtn();
    onUpdate?.();
  });
  firePanelDiv.appendChild(igniteToolBtn);

  // Wind direction
  const windAngleLbl = makeLabel(
    `Wind from: <span id="wind-angle-val">${controls.windAngle}</span>&deg;`,
    'font-size:12px;margin-bottom:2px;'
  );
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
    `Wind speed: <span id="wind-speed-val">${controls.windSpeed.toFixed(1)}</span>`,
    'font-size:12px;margin-top:6px;margin-bottom:2px;'
  );
  const windSpeedSlider = makeSlider({ min: 0, max: 5, step: 0.1, value: controls.windSpeed });
  windSpeedSlider.addEventListener('input', () => {
    controls.windSpeed = Number(windSpeedSlider.value);
    document.getElementById('wind-speed-val').textContent = controls.windSpeed.toFixed(1);
    onUpdate?.();
  });
  firePanelDiv.appendChild(windSpeedLbl);
  firePanelDiv.appendChild(windSpeedSlider);

  const clearFireBtn = makeBtn('Clear Fire', `
    margin-top:8px; padding:6px 10px; background:#5a2a20;
    color:#ff9977; border:1px solid #8a4030;
    border-radius:4px; cursor:pointer; font-size:12px; width:100%;
  `);
  clearFireBtn.addEventListener('click', () => onUpdate?.('clear-fire'));
  firePanelDiv.appendChild(clearFireBtn);

  // View modes — fire
  firePanelDiv.appendChild(sectionHead('View'));
  const fireViewDiv = document.createElement('div');
  fireViewDiv.style.cssText = 'display:flex;gap:4px;';
  const fireViewModes = [
    { id: 'design', label: 'Design', title: 'Patch colors with fire overlay' },
    { id: 'fuel',   label: 'Fuel Risk', title: 'Heatmap of fuelLoad — blue=firebreak, red=high fuel' },
  ];
  const fireViewBtns = fireViewModes.map(({ id, label, title }) => {
    const btn = makeBtn(label, `
      flex:1; padding:5px 4px; border:1px solid #444;
      background:transparent; color:#888;
      border-radius:4px; cursor:pointer; font-size:11px;
    `, title);
    const refresh = () => {
      const active = controls.viewMode === id;
      btn.style.background   = active ? '#4a3a5d' : 'transparent';
      btn.style.color        = active ? '#cc99ff' : '#888';
      btn.style.borderColor  = active ? '#7a5aad' : '#444';
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
    `Rainfall: <span id="rain-val">${controls.rainfall}</span> mm/hr`,
    'font-size:12px;margin-bottom:2px;'
  );
  const rainSlider = makeSlider({ min: 0, max: 150, value: controls.rainfall });
  rainSlider.addEventListener('input', () => {
    controls.rainfall = Number(rainSlider.value);
    document.getElementById('rain-val').textContent = controls.rainfall;
    onUpdate?.();
  });
  floodPanelDiv.appendChild(rainLbl);
  floodPanelDiv.appendChild(rainSlider);

  // Point source tool
  const waterSourceToolBtn = makeBtn('Point Source', `
    display:block; width:100%; margin-top:8px; padding:6px 10px;
    border:2px solid #4a9eff; background:transparent; color:#4a9eff;
    border-radius:4px; cursor:pointer; font-size:12px;
  `);
  const refreshWaterSourceBtn = () => {
    const active = controls.activeTool === 'water-source';
    waterSourceToolBtn.style.background = active ? '#4a9eff30' : 'transparent';
    waterSourceToolBtn.style.fontWeight = active ? 'bold' : 'normal';
    waterSourceToolBtn.textContent      = active ? 'Point Source (ON)' : 'Point Source';
  };
  waterSourceToolBtn.addEventListener('click', () => {
    controls.activeTool = controls.activeTool === 'water-source' ? 'paint' : 'water-source';
    refreshWaterSourceBtn();
    onUpdate?.();
  });
  floodPanelDiv.appendChild(waterSourceToolBtn);

  const floodHint = document.createElement('div');
  floodHint.textContent = 'Shift+drag on canvas to flood an area';
  floodHint.style.cssText = 'font-size:10px;color:#666;margin-top:4px;';
  floodPanelDiv.appendChild(floodHint);

  const wsRateLbl = makeLabel(
    `Source rate: <span id="ws-rate-val">${controls.waterSourceRate.toFixed(2)}</span> m/step`,
    'font-size:12px;margin-top:8px;margin-bottom:2px;'
  );
  const wsRateSlider = makeSlider({ min: 0.01, max: 0.2, step: 0.01, value: controls.waterSourceRate });
  wsRateSlider.addEventListener('input', () => {
    controls.waterSourceRate = Number(wsRateSlider.value);
    document.getElementById('ws-rate-val').textContent = controls.waterSourceRate.toFixed(2);
    onUpdate?.();
  });
  floodPanelDiv.appendChild(wsRateLbl);
  floodPanelDiv.appendChild(wsRateSlider);

  const clearSourcesBtn = makeBtn('Clear Sources', `
    margin-top:6px; padding:5px 10px; background:#2a3a4a;
    color:#8acaff; border:1px solid #3a5a7a;
    border-radius:4px; cursor:pointer; font-size:12px; width:100%;
  `);
  clearSourcesBtn.addEventListener('click', () => onUpdate?.('clear-sources'));
  floodPanelDiv.appendChild(clearSourcesBtn);

  // Extra toggles
  floodPanelDiv.appendChild(sectionHead('Options'));

  const makeFlagLabel = (text, initial, onChange) => {
    const lbl = document.createElement('label');
    lbl.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:5px;cursor:pointer;font-size:12px;';
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
    `Sediment rate: <span id="sediment-val">${controls.sedimentMultiplier}</span>&times;`,
    'font-size:12px;margin-top:8px;margin-bottom:2px;'
  );
  const sedSlider = makeSlider({ min: 0.5, max: 5, step: 0.25, value: controls.sedimentMultiplier });
  sedSlider.addEventListener('input', () => {
    controls.sedimentMultiplier = Number(sedSlider.value);
    document.getElementById('sediment-val').textContent = controls.sedimentMultiplier;
    onUpdate?.();
  });
  floodPanelDiv.appendChild(sedLbl);
  floodPanelDiv.appendChild(sedSlider);

  const speedLbl = makeLabel(
    `Speed: <span id="speed-val">${controls.speedMultiplier}</span>&times;`,
    'font-size:12px;margin-top:8px;margin-bottom:2px;'
  );
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
    const btn = makeBtn(label, `
      flex:1; padding:5px 4px; border:1px solid #444;
      background:transparent; color:#888;
      border-radius:4px; cursor:pointer; font-size:11px;
    `, title);
    const refresh = () => {
      const active = controls.viewMode === id;
      btn.style.background  = active ? '#4a5a7d' : 'transparent';
      btn.style.color       = active ? '#fff'    : '#888';
      btn.style.borderColor = active ? '#6a7aad' : '#444';
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

  const restoreBtn = makeBtn('Restore Landscape', `
    margin-top:6px; padding:6px 12px; background:#2d5a3d;
    color:#7dcc9d; border:none; border-radius:4px; cursor:pointer;
    font-size:12px; width:100%;
  `, 'Replace ~30% of patches with wetland/forest');
  restoreBtn.addEventListener('click', () => onUpdate?.('restore'));
  floodPanelDiv.appendChild(restoreBtn);

  floodPanelDiv.appendChild(buildExportImport(onUpdate));

  // ── Mount panels, set initial visibility ─────────────────────────────────
  menuContent.appendChild(firePanelDiv);
  menuContent.appendChild(floodPanelDiv);

  const switchMode = (mode) => {
    controls.simMode  = mode;
    controls.activeTool = 'paint';
    // Reset running when switching modes
    controls.running = false;
    // Set sensible viewMode defaults per mode
    if (mode === 'fire')  controls.viewMode = 'design';
    if (mode === 'flood') controls.viewMode = 'design';

    firePanelDiv.style.display   = mode === 'fire'  ? 'block' : 'none';
    floodPanelDiv.style.display  = mode === 'flood' ? 'block' : 'none';
    // Hide chart in fire mode (fire has no hydrology metrics)
    if (chartCanvas) chartCanvas.style.display = mode === 'fire' ? 'none' : 'block';

    refreshModeBtns();
    refreshIgniteBtn();
    refreshWaterSourceBtn();
    onUpdate?.();
  };

  fireModeBtn.addEventListener('click',  () => switchMode('fire'));
  floodModeBtn.addEventListener('click', () => switchMode('flood'));

  // ── Metrics div ───────────────────────────────────────────────────────────
  const metricsDiv = document.createElement('div');
  metricsDiv.id = 'mosaic-metrics';
  metricsDiv.style.cssText = 'padding:0 14px 10px;';
  const metricsText = document.createElement('div');
  metricsText.id = 'mosaic-metrics-text';
  metricsText.style.cssText = 'font-size:11px;color:#aaa;line-height:1.6;';
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
  chartCanvas.style.cssText = `
    position: absolute; top: 10px; right: 10px;
    background: rgba(12, 12, 16, 0.95);
    border: 1px solid #2a2a3a; border-radius: 6px;
    z-index: 100; pointer-events: none;
    display: none;
  `;
  mosaicContainer.appendChild(chartCanvas);

  // Initialise to fire mode (must be after chartCanvas is defined)
  switchMode('fire');

  // ── Info button / modal ───────────────────────────────────────────────────
  const infoBtn = makeBtn('i Info', `
    position:absolute; bottom:16px; right:16px; padding:8px 14px;
    background:rgba(50,50,65,0.9); border:1px solid #555;
    border-radius:6px; color:#bbb; font-size:13px;
    cursor:pointer; z-index:100; box-shadow:0 2px 8px rgba(0,0,0,0.3);
  `, 'Model documentation');
  mosaicContainer.appendChild(infoBtn);

  const infoModal = document.createElement('div');
  infoModal.id = 'mosaic-info-modal';
  infoModal.style.cssText = `
    display:none; position:fixed; top:0;left:0;right:0;bottom:0;
    background:rgba(0,0,0,0.7); z-index:10000;
    justify-content:center; align-items:center;
    padding:24px; overflow-y:auto;
  `;
  const infoPanel = document.createElement('div');
  infoPanel.style.cssText = `
    background:#1e1e26; color:#e0e0e0; max-width:640px;
    max-height:85vh; overflow-y:auto; padding:24px;
    border-radius:10px; font-family:system-ui,sans-serif;
    font-size:13px; line-height:1.5;
    box-shadow:0 8px 32px rgba(0,0,0,0.5);
  `;

  const patchTable = Object.entries(PATCH_PARAMS).map(([key, p]) =>
    `<tr>
      <td style="color:${p.color};font-weight:bold">${p.name}</td>
      <td>${p.manningN}</td>
      <td>${p.infiltration}</td>
      <td>${p.erodibility}</td>
      <td style="color:#a0a0b8;font-size:10px">${p.fuelLoad ?? 0}</td>
      <td style="font-size:11px;color:#aaa">${getPatchBehavior(key, p)}</td>
    </tr>`
  ).join('');

  infoPanel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="margin:0;font-size:18px">Land Mosaic Flow Model</h2>
      <button id="info-modal-close" style="background:#555;border:none;color:#fff;padding:6px 12px;border-radius:4px;cursor:pointer">Close</button>
    </div>

    <h3 style="margin-top:20px;font-size:14px">Model overview</h3>
    <p>This model combines Richard T.T. Forman's patch-matrix-corridor framework with overland flow physics and a FireSweep-style percolation wildfire model.</p>

    <h3 style="margin-top:20px;font-size:14px">Fire model — percolation / FireSweep</h3>
    <p style="font-size:12px">Fire spread is a cellular automaton on a 64&times;64 grid. Each tick, every BURNING cell attempts to ignite its 8 unburned neighbors exactly once. The ignition probability is:</p>
    <p style="font-size:12px"><code style="background:#2a2a32;padding:2px 6px;border-radius:4px">P = min(1, fuelLoad &times; continuity &times; windFactor &times; slopeFactor)</code></p>
    <p style="font-size:12px">Each unburned cell receives <em>one roll only</em> regardless of how many burning neighbors it has. This makes <strong>fuelLoad = density p</strong> in site-percolation theory (8-neighbor threshold p<sub>c</sub> &asymp; 0.41). Below p<sub>c</sub>: fire burns out. Above: fire sweeps the landscape.</p>

    <h3 style="margin-top:20px;font-size:14px">Flood model — Manning's equation</h3>
    <p style="font-size:12px"><code style="background:#2a2a32;padding:2px 6px;border-radius:4px">v = (1/n) &times; R<sup>2/3</sup> &times; S<sup>1/2</sup></code><br>
    Lower roughness <em>n</em> = faster flow. Flux routes via D8 proportional to gradient.</p>

    <h3 style="margin-top:20px;font-size:14px">Patch parameters</h3>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr style="text-align:left;border-bottom:1px solid #444">
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
    { key: 'runoffRatio',   label: 'RUNOFF',  unit: '0–1',      color: '#4a9eff', fmt: v => v.toFixed(2) },
    { key: 'meanStorage',   label: 'STORAGE', unit: 'mm depth', color: '#3dd6a3', fmt: v => (v*1000).toFixed(2) },
    { key: 'etFraction',    label: 'ET',      unit: '0–1',      color: '#7dd87d', fmt: v => v.toFixed(2) },
    { key: 'concentration', label: 'CONCEN.', unit: '0–1',      color: '#f0b429', fmt: v => v.toFixed(2) },
  ];

  function drawChartPanel(chartHistory, interventionMarkers, running) {
    if (chartCanvas.style.display === 'none') return;
    const ctx = chartCanvas.getContext('2d');
    ctx.clearRect(0, 0, CHART_W, CHART_H);
    ctx.fillStyle = 'rgba(12, 12, 16, 0.95)';
    ctx.fillRect(0, 0, CHART_W, CHART_H);
    if (!running) {
      ctx.fillStyle = '#444'; ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('PAUSED', CHART_W/2, CHART_H/2);
      ctx.textAlign = 'left';
    }
    const n = chartHistory.length;
    const PAD = 4;
    PANELS_CFG.forEach((panel, pi) => {
      const py = pi * PANEL_H;
      if (pi > 0) {
        ctx.strokeStyle = '#2a2a3a'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(CHART_W, py); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, py + PANEL_H*0.5); ctx.lineTo(CHART_W, py + PANEL_H*0.5); ctx.stroke();
      if (n < 2) {
        ctx.fillStyle = panel.color; ctx.font = 'bold 9px system-ui';
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
        ctx.strokeStyle = 'rgba(255,200,50,0.2)'; ctx.lineWidth = 1;
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
      ctx.fillStyle = panel.color; ctx.font = 'bold 9px system-ui';
      ctx.fillText(panel.label, PAD, py + 12);
      ctx.fillStyle = '#ccc'; ctx.font = '9px system-ui';
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
