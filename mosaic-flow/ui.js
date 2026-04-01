/**
 * UI controls: patch brush, sliders, metrics panel.
 */

import { PATCH_TYPES, PATCH_PARAMS } from './patches.js';

function getPatchBehavior(key, p) {
  const behaviors = {
    [PATCH_TYPES.GRASS]: 'Moderate roughness; holds some water; moderate sediment source.',
    [PATCH_TYPES.FOREST]: 'High roughness, slow flow; high infiltration; traps sediment.',
    [PATCH_TYPES.WETLAND]: 'Moderate flow; very high infiltration (holds water); low erosion.',
    [PATCH_TYPES.BARE]: 'Low roughness, fast flow; minimal infiltration; high sediment source.',
    [PATCH_TYPES.URBAN]: 'Very low roughness, fast runoff; nearly no infiltration; some sediment.',
    [PATCH_TYPES.CORRIDOR]: 'Channel-like; fast flow, moderate infiltration; conveys water and sediment.',
    [PATCH_TYPES.WATER]: 'Water body; very low roughness, conveys flow; no infiltration or erosion.',
  };
  return behaviors[key] || '—';
}

export function createUI(onUpdate) {
  const controls = {
    activePatch: PATCH_TYPES.GRASS,
    rainfall: 50,
    slopeAngle: 270,
    slopeMagnitude: 0.01,
    running: false,
    elevationMode: 'dem',
    demElevations: null,
    showElevationLines: true,
    showDrainageHeatmap: false,
    useLBM: false,
    viewMode: 'design',
    sedimentMultiplier: 1,
    menuExpanded: true,
    brushSize: 3,
    speedMultiplier: 1,
    simMode: 'water',        // 'water' | 'fire'
    windAngle: 225,          // compass degrees 0=N, 90=E
    windSpeed: 2.5,          // 0–5
    activeTool: 'paint',     // 'paint' | 'ignite' | 'water-source'
    waterSourceRate: 0.04,   // meters of water added per step per source cell
  };

  const mosaicContainer = document.getElementById('mosaic-container');
  if (!mosaicContainer) return { controls: {}, updateMetrics: () => {} };

  const container = document.createElement('div');
  container.id = 'mosaic-controls';
  container.style.cssText = `
    position: absolute;
    top: 10px;
    left: 10px;
    background: rgba(30, 30, 40, 0.98);
    padding: 0;
    border-radius: 8px;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    color: #e0e0e0;
    z-index: 100;
    max-width: 280px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    overflow: hidden;
    pointer-events: auto;
  `;

  const headerBar = document.createElement('div');
  headerBar.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: rgba(40, 40, 50, 0.98);
    cursor: pointer;
    user-select: none;
  `;
  headerBar.innerHTML = '<span>Controls</span>';
  const arrowBtn = document.createElement('button');
  arrowBtn.id = 'mosaic-arrow-btn';
  arrowBtn.innerHTML = '&#9664;';
  arrowBtn.title = 'Collapse menu';
  arrowBtn.style.cssText = `
    background: transparent;
    border: none;
    color: #e0e0e0;
    font-size: 14px;
    cursor: pointer;
    padding: 4px 8px;
    transition: transform 0.2s ease;
  `;
  headerBar.appendChild(arrowBtn);

  const menuContent = document.createElement('div');
  menuContent.id = 'mosaic-menu-content';
  menuContent.style.cssText = 'padding: 12px 16px; padding-top: 8px;';

  const toggleMenu = () => {
    controls.menuExpanded = !controls.menuExpanded;
    menuContent.style.display = controls.menuExpanded ? 'block' : 'none';
    arrowBtn.innerHTML = controls.menuExpanded ? '&#9664;' : '&#9654;';
    arrowBtn.title = controls.menuExpanded ? 'Collapse menu' : 'Expand menu';
  };
  headerBar.addEventListener('click', (e) => {
    if (e.target !== arrowBtn && !arrowBtn.contains(e.target)) toggleMenu();
  });
  arrowBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  mosaicContainer.appendChild(container);
  container.appendChild(headerBar);
  container.appendChild(menuContent);

  const patchSection = document.createElement('div');
  patchSection.innerHTML = '<strong>Patch Brush</strong>';
  patchSection.style.marginBottom = '8px';

  const brushLabel = document.createElement('label');
  brushLabel.innerHTML = `Size: <span id="brush-size-val">${controls.brushSize}</span>`;
  brushLabel.style.display = 'block';
  brushLabel.style.marginBottom = '4px';
  const brushSlider = document.createElement('input');
  brushSlider.type = 'range';
  brushSlider.min = 1;
  brushSlider.max = 10;
  brushSlider.value = controls.brushSize;
  brushSlider.style.width = '100%';
  brushSlider.addEventListener('input', () => {
    controls.brushSize = Number(brushSlider.value);
    document.getElementById('brush-size-val').textContent = controls.brushSize;
    onUpdate?.();
  });
  patchSection.appendChild(brushLabel);
  patchSection.appendChild(brushSlider);

  const patchButtons = Object.entries(PATCH_PARAMS).map(([key, params]) => {
    const btn = document.createElement('button');
    btn.textContent = params.name;
    btn.style.cssText = `
      padding: 6px 10px;
      margin: 2px;
      border: 2px solid ${params.color};
      background: ${controls.activePatch === key ? params.color + '40' : 'transparent'};
      color: ${params.color};
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    `;
    btn.addEventListener('click', () => {
      controls.activePatch = key;
      patchButtons.forEach(b => {
        const k = Object.keys(PATCH_PARAMS).indexOf(b.dataset.key) >= 0 ? b.dataset.key : null;
        if (k) {
          const p = PATCH_PARAMS[k];
          b.style.background = controls.activePatch === k ? p.color + '40' : 'transparent';
        }
      });
      btn.style.background = params.color + '40';
      onUpdate?.();
    });
    btn.dataset.key = key;
    return btn;
  });

  patchButtons.forEach(btn => patchSection.appendChild(btn));

  const randomBtn = document.createElement('button');
  randomBtn.textContent = 'Randomize';
  randomBtn.style.cssText = `
    margin-top: 8px;
    padding: 6px 12px;
    background: #4a4a6a;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    width: 100%;
  `;
  randomBtn.title = 'Generate random patches with varied sizes';
  randomBtn.addEventListener('click', () => onUpdate?.('randomize'));
  patchSection.appendChild(randomBtn);

  menuContent.appendChild(patchSection);

  // ── Simulation Mode toggle ──────────────────────────────────────────────────
  const simModeSection = document.createElement('div');
  simModeSection.style.cssText = 'margin-top: 12px; margin-bottom: 4px;';
  simModeSection.innerHTML = '<strong>Simulation Mode</strong>';

  const simModeDiv = document.createElement('div');
  simModeDiv.style.cssText = 'display: flex; gap: 6px; margin-top: 6px;';

  const waterModeBtn = document.createElement('button');
  waterModeBtn.textContent = 'Water / Sediment';
  waterModeBtn.style.cssText = `
    flex: 1; padding: 6px 8px; border: 1px solid #4a9eff;
    background: #4a9eff30; color: #4a9eff;
    border-radius: 4px; cursor: pointer; font-size: 12px;
  `;

  const fireModeBtn = document.createElement('button');
  fireModeBtn.textContent = 'Fire';
  fireModeBtn.style.cssText = `
    flex: 1; padding: 6px 8px; border: 1px solid #444;
    background: transparent; color: #888;
    border-radius: 4px; cursor: pointer; font-size: 12px;
  `;

  const refreshSimModeBtns = () => {
    const isWater = controls.simMode === 'water';
    waterModeBtn.style.background = isWater ? '#4a9eff30' : 'transparent';
    waterModeBtn.style.color = isWater ? '#4a9eff' : '#888';
    waterModeBtn.style.borderColor = isWater ? '#4a9eff' : '#444';
    fireModeBtn.style.background = !isWater ? '#ff6a2030' : 'transparent';
    fireModeBtn.style.color = !isWater ? '#ff8c42' : '#888';
    fireModeBtn.style.borderColor = !isWater ? '#ff6a20' : '#444';
  };

  waterModeBtn.addEventListener('click', () => {
    controls.simMode = 'water';
    controls.activeTool = 'paint';
    refreshSimModeBtns();
    if (typeof fireSectionDiv !== 'undefined') fireSectionDiv.style.display = 'none';
    if (typeof waterSourceSectionDiv !== 'undefined') waterSourceSectionDiv.style.display = 'block';
    onUpdate?.();
  });
  fireModeBtn.addEventListener('click', () => {
    controls.simMode = 'fire';
    controls.activeTool = 'paint';
    refreshSimModeBtns();
    if (typeof fireSectionDiv !== 'undefined') fireSectionDiv.style.display = 'block';
    if (typeof waterSourceSectionDiv !== 'undefined') waterSourceSectionDiv.style.display = 'none';
    onUpdate?.();
  });

  simModeDiv.appendChild(waterModeBtn);
  simModeDiv.appendChild(fireModeBtn);
  simModeSection.appendChild(simModeDiv);
  menuContent.appendChild(simModeSection);

  const rainLabel = document.createElement('label');
  rainLabel.innerHTML = `Rainfall: <span id="rain-val">${controls.rainfall}</span> mm/hr`;
  rainLabel.style.display = 'block';
  rainLabel.style.marginTop = '12px';

  const rainSlider = document.createElement('input');
  rainSlider.type = 'range';
  rainSlider.min = 0;
  rainSlider.max = 150;
  rainSlider.value = controls.rainfall;
  rainSlider.style.width = '100%';
  rainSlider.addEventListener('input', () => {
    controls.rainfall = Number(rainSlider.value);
    document.getElementById('rain-val').textContent = controls.rainfall;
    onUpdate?.();
  });

  menuContent.appendChild(rainLabel);
  menuContent.appendChild(rainSlider);

  // ── Water Sources section ───────────────────────────────────────────────────
  var waterSourceSectionDiv = document.createElement('div');
  waterSourceSectionDiv.style.cssText = 'margin-top: 12px;';
  waterSourceSectionDiv.innerHTML = '<strong>Water Sources</strong>';

  const waterSourceToolBtn = document.createElement('button');
  waterSourceToolBtn.textContent = 'Point Source';
  waterSourceToolBtn.style.cssText = `
    display: block; width: 100%; margin-top: 6px; padding: 6px 10px;
    border: 1px solid #4a9eff; background: transparent; color: #4a9eff;
    border-radius: 4px; cursor: pointer; font-size: 12px;
  `;
  const refreshWaterSourceBtn = () => {
    const active = controls.activeTool === 'water-source';
    waterSourceToolBtn.style.background = active ? '#4a9eff40' : 'transparent';
    waterSourceToolBtn.style.fontWeight = active ? 'bold' : 'normal';
  };
  waterSourceToolBtn.addEventListener('click', () => {
    controls.activeTool = controls.activeTool === 'water-source' ? 'paint' : 'water-source';
    refreshWaterSourceBtn();
    if (typeof igniteToolBtn !== 'undefined') refreshIgniteBtn();
  });
  waterSourceSectionDiv.appendChild(waterSourceToolBtn);

  const floodHint = document.createElement('div');
  floodHint.textContent = 'Shift+drag on canvas to flood area';
  floodHint.style.cssText = 'font-size: 10px; color: #888; margin-top: 4px;';
  waterSourceSectionDiv.appendChild(floodHint);

  const wsRateLabel = document.createElement('label');
  wsRateLabel.innerHTML = `Source rate: <span id="ws-rate-val">${controls.waterSourceRate}</span> m/step`;
  wsRateLabel.style.cssText = 'display: block; margin-top: 6px; font-size: 12px;';
  const wsRateSlider = document.createElement('input');
  wsRateSlider.type = 'range';
  wsRateSlider.min = 0.01;
  wsRateSlider.max = 0.2;
  wsRateSlider.step = 0.01;
  wsRateSlider.value = controls.waterSourceRate;
  wsRateSlider.style.width = '100%';
  wsRateSlider.addEventListener('input', () => {
    controls.waterSourceRate = Number(wsRateSlider.value);
    document.getElementById('ws-rate-val').textContent = controls.waterSourceRate.toFixed(2);
    onUpdate?.();
  });
  waterSourceSectionDiv.appendChild(wsRateLabel);
  waterSourceSectionDiv.appendChild(wsRateSlider);

  const clearSourcesBtn = document.createElement('button');
  clearSourcesBtn.textContent = 'Clear Sources';
  clearSourcesBtn.style.cssText = `
    margin-top: 6px; padding: 5px 10px; background: #555;
    color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;
  `;
  clearSourcesBtn.addEventListener('click', () => onUpdate?.('clear-sources'));
  waterSourceSectionDiv.appendChild(clearSourcesBtn);
  menuContent.appendChild(waterSourceSectionDiv);

  // ── Fire Controls section ───────────────────────────────────────────────────
  var fireSectionDiv = document.createElement('div');
  fireSectionDiv.style.cssText = 'margin-top: 12px; display: none;';
  fireSectionDiv.innerHTML = '<strong>Fire Controls</strong>';

  var igniteToolBtn = document.createElement('button');
  igniteToolBtn.textContent = 'Ignite Tool';
  igniteToolBtn.style.cssText = `
    display: block; width: 100%; margin-top: 6px; padding: 6px 10px;
    border: 1px solid #ff6a20; background: transparent; color: #ff8c42;
    border-radius: 4px; cursor: pointer; font-size: 12px;
  `;
  const refreshIgniteBtn = () => {
    const active = controls.activeTool === 'ignite';
    igniteToolBtn.style.background = active ? '#ff6a2040' : 'transparent';
    igniteToolBtn.style.fontWeight = active ? 'bold' : 'normal';
  };
  igniteToolBtn.addEventListener('click', () => {
    controls.activeTool = controls.activeTool === 'ignite' ? 'paint' : 'ignite';
    refreshIgniteBtn();
    refreshWaterSourceBtn();
  });
  fireSectionDiv.appendChild(igniteToolBtn);

  const windAngleLabelEl = document.createElement('label');
  windAngleLabelEl.innerHTML = `Wind direction: <span id="wind-angle-val">${controls.windAngle}</span>&deg;`;
  windAngleLabelEl.style.cssText = 'display: block; margin-top: 8px; font-size: 12px;';
  const windAngleSlider = document.createElement('input');
  windAngleSlider.type = 'range';
  windAngleSlider.min = 0;
  windAngleSlider.max = 360;
  windAngleSlider.step = 5;
  windAngleSlider.value = controls.windAngle;
  windAngleSlider.style.width = '100%';
  windAngleSlider.addEventListener('input', () => {
    controls.windAngle = Number(windAngleSlider.value);
    document.getElementById('wind-angle-val').textContent = controls.windAngle;
    onUpdate?.();
  });
  fireSectionDiv.appendChild(windAngleLabelEl);
  fireSectionDiv.appendChild(windAngleSlider);

  const windSpeedLabelEl = document.createElement('label');
  windSpeedLabelEl.innerHTML = `Wind speed: <span id="wind-speed-val">${controls.windSpeed}</span>`;
  windSpeedLabelEl.style.cssText = 'display: block; margin-top: 6px; font-size: 12px;';
  const windSpeedSlider = document.createElement('input');
  windSpeedSlider.type = 'range';
  windSpeedSlider.min = 0;
  windSpeedSlider.max = 5;
  windSpeedSlider.step = 0.1;
  windSpeedSlider.value = controls.windSpeed;
  windSpeedSlider.style.width = '100%';
  windSpeedSlider.addEventListener('input', () => {
    controls.windSpeed = Number(windSpeedSlider.value);
    document.getElementById('wind-speed-val').textContent = controls.windSpeed.toFixed(1);
    onUpdate?.();
  });
  fireSectionDiv.appendChild(windSpeedLabelEl);
  fireSectionDiv.appendChild(windSpeedSlider);

  const clearFireBtn = document.createElement('button');
  clearFireBtn.textContent = 'Clear Fire';
  clearFireBtn.style.cssText = `
    margin-top: 6px; padding: 5px 10px; background: #5a3030;
    color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;
  `;
  clearFireBtn.addEventListener('click', () => onUpdate?.('clear-fire'));
  fireSectionDiv.appendChild(clearFireBtn);
  menuContent.appendChild(fireSectionDiv);

  const topoSection = document.createElement('div');
  topoSection.style.marginTop = '12px';
  topoSection.innerHTML = '<strong>Topography</strong>';
  menuContent.appendChild(topoSection);

  const topoDemDiv = document.createElement('div');
  topoDemDiv.id = 'topo-dem-div';
  topoDemDiv.style.marginTop = '8px';

  const demInput = document.createElement('input');
  demInput.type = 'file';
  demInput.accept = '.asc,.grd,.csv,.txt,.json';
  demInput.style.display = 'none';
  demInput.title = 'ASCII Grid (.asc), CSV, or JSON elevation data. Resampled to 64×64.';

  const demBtn = document.createElement('button');
  demBtn.textContent = 'Load DEM';
  demBtn.style.cssText = `
    padding: 6px 12px;
    background: #4a6a8a;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  `;
  demBtn.addEventListener('click', () => demInput.click());

  const sampleDems = {
    'Simple Slope': (n) => {
      const elevs = new Float32Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          elevs[i * n + j] = (n - j) * 0.01;
        }
      }
      return elevs;
    },
    Valley: (n) => {
      const elevs = new Float32Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const x = (j - n / 2) / (n / 2);
          const y = (i - n / 2) / (n / 2);
          elevs[i * n + j] = 100 - 30 * (x * x + y * y * 0.5) + 20 * Math.sin(j * 0.2) * Math.cos(i * 0.15);
        }
      }
      return elevs;
    },
    Ridge: (n) => {
      const elevs = new Float32Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const x = (j - n / 2) / (n / 2);
          elevs[i * n + j] = 80 - 40 * (x * x) + 15 * Math.sin(i * 0.15);
        }
      }
      return elevs;
    },
    Channel: (n) => {
      const elevs = new Float32Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const distFromCenter = Math.abs(j - n / 2);
          const channelDepth = Math.exp(-distFromCenter * distFromCenter / 100) * 25;
          elevs[i * n + j] = 100 - channelDepth - (n - i) * 0.3 + 8 * Math.sin(j * 0.1);
        }
      }
      return elevs;
    },
    Rolling: (n) => {
      const elevs = new Float32Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          elevs[i * n + j] = 80 + 25 * Math.sin(i * 0.12) * Math.cos(j * 0.1) +
            18 * Math.sin((i + j) * 0.08) - (n - i) * 0.15;
        }
      }
      return elevs;
    },
    Dome: (n) => {
      const elevs = new Float32Array(n * n);
      const cx = n / 2;
      const cy = n / 2;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const r = Math.sqrt((i - cy) ** 2 + (j - cx) ** 2) / (n / 2);
          elevs[i * n + j] = Math.max(0, 100 - 60 * r * r) + 5 * Math.sin(j * 0.2);
        }
      }
      return elevs;
    },
    Gully: (n) => {
      const elevs = new Float32Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const y = (i - n / 2) / (n / 2);
          const x = (j - n / 2) / (n / 2);
          const gully = 30 * Math.exp(-y * y * 4) * (1 - Math.abs(x) * 0.5);
          elevs[i * n + j] = 100 - gully - i * 0.2 + 5 * Math.sin(j * 0.15);
        }
      }
      return elevs;
    },
  };

  // Set the initial DEM to simple slope
  controls.demElevations = sampleDems['Simple Slope'](64);

  const sampleDemDiv = document.createElement('div');
  sampleDemDiv.style.marginTop = '6px';
  sampleDemDiv.style.display = 'flex';
  sampleDemDiv.style.flexWrap = 'wrap';
  sampleDemDiv.style.gap = '4px';
  Object.keys(sampleDems).forEach((name) => {
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.style.cssText = `
      padding: 4px 8px;
      background: #5a7a6a;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    `;
    btn.title = `Sample ${name} DEM`;
    btn.addEventListener('click', () => {
      controls.demElevations = sampleDems[name](64);
      onUpdate?.();
    });
    sampleDemDiv.appendChild(btn);
  });

  demInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const targetCols = 64;
    const targetRows = 64;
    const { loadDemFile } = await import('./dem.js');
    const elevations = await loadDemFile(file, targetCols, targetRows);
    if (elevations) {
      controls.demElevations = elevations;
      onUpdate?.();
    } else {
      alert('Could not parse DEM file. Try ASCII Grid (.asc), CSV, or JSON.');
    }
    demInput.value = '';
  });

  const demBtnRow = document.createElement('div');
  demBtnRow.appendChild(demBtn);
  topoDemDiv.appendChild(demBtnRow);
  topoDemDiv.appendChild(sampleDemDiv);
  topoDemDiv.appendChild(demInput);
  menuContent.appendChild(topoDemDiv);

  const elevationLinesLabel = document.createElement('label');
  elevationLinesLabel.style.display = 'flex';
  elevationLinesLabel.style.alignItems = 'center';
  elevationLinesLabel.style.marginTop = '12px';
  elevationLinesLabel.style.gap = '8px';
  elevationLinesLabel.style.cursor = 'pointer';
  const elevationLinesCheck = document.createElement('input');
  elevationLinesCheck.type = 'checkbox';
  elevationLinesCheck.checked = controls.showElevationLines;
  elevationLinesCheck.addEventListener('change', () => {
    controls.showElevationLines = elevationLinesCheck.checked;
    onUpdate?.();
  });
  elevationLinesLabel.appendChild(elevationLinesCheck);
  elevationLinesLabel.appendChild(document.createTextNode('Show elevation contours'));
  menuContent.appendChild(elevationLinesLabel);

  // Fix 4: drainage heatmap toggle
  const drainageHeatmapLabel = document.createElement('label');
  drainageHeatmapLabel.style.display = 'flex';
  drainageHeatmapLabel.style.alignItems = 'center';
  drainageHeatmapLabel.style.marginTop = '6px';
  drainageHeatmapLabel.style.gap = '8px';
  drainageHeatmapLabel.style.cursor = 'pointer';
  const drainageHeatmapCheck = document.createElement('input');
  drainageHeatmapCheck.type = 'checkbox';
  drainageHeatmapCheck.checked = controls.showDrainageHeatmap;
  drainageHeatmapCheck.addEventListener('change', () => {
    controls.showDrainageHeatmap = drainageHeatmapCheck.checked;
  });
  drainageHeatmapLabel.appendChild(drainageHeatmapCheck);
  drainageHeatmapLabel.appendChild(document.createTextNode('Show drainage network'));
  menuContent.appendChild(drainageHeatmapLabel);

  // LBM density field toggle
  const lbmLabel = document.createElement('label');
  lbmLabel.style.display = 'flex';
  lbmLabel.style.alignItems = 'center';
  lbmLabel.style.marginTop = '6px';
  lbmLabel.style.gap = '8px';
  lbmLabel.style.cursor = 'pointer';
  const lbmCheck = document.createElement('input');
  lbmCheck.type = 'checkbox';
  lbmCheck.checked = controls.useLBM;
  lbmCheck.addEventListener('change', () => {
    controls.useLBM = lbmCheck.checked;
  });
  lbmLabel.appendChild(lbmCheck);
  lbmLabel.appendChild(document.createTextNode('LBM density field'));
  menuContent.appendChild(lbmLabel);

  const sedimentLabel = document.createElement('label');
  sedimentLabel.innerHTML = `Sediment rate: <span id="sediment-val">${controls.sedimentMultiplier}</span>×`;
  sedimentLabel.style.display = 'block';
  sedimentLabel.style.marginTop = '12px';
  const sedimentSlider = document.createElement('input');
  sedimentSlider.type = 'range';
  sedimentSlider.min = 0.5;
  sedimentSlider.max = 5;
  sedimentSlider.step = 0.25;
  sedimentSlider.value = controls.sedimentMultiplier;
  sedimentSlider.style.width = '100%';
  sedimentSlider.addEventListener('input', () => {
    controls.sedimentMultiplier = Number(sedimentSlider.value);
    document.getElementById('sediment-val').textContent = controls.sedimentMultiplier;
    onUpdate?.();
  });
  menuContent.appendChild(sedimentLabel);
  menuContent.appendChild(sedimentSlider);

  const speedLabel = document.createElement('label');
  speedLabel.innerHTML = `Speed: <span id="speed-val">${controls.speedMultiplier}</span>×`;
  speedLabel.style.display = 'block';
  speedLabel.style.marginTop = '12px';
  const speedSlider = document.createElement('input');
  speedSlider.type = 'range';
  speedSlider.min = 1;
  speedSlider.max = 8;
  speedSlider.value = controls.speedMultiplier;
  speedSlider.style.width = '100%';
  speedSlider.addEventListener('input', () => {
    controls.speedMultiplier = Number(speedSlider.value);
    document.getElementById('speed-val').textContent = controls.speedMultiplier;
    onUpdate?.();
  });
  menuContent.appendChild(speedLabel);
  menuContent.appendChild(speedSlider);

  const runBtn = document.createElement('button');
  runBtn.textContent = 'Run';
  runBtn.style.cssText = `
    margin-top: 12px;
    padding: 8px 16px;
    background: #4a7c59;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  `;
  runBtn.addEventListener('click', () => {
    controls.running = !controls.running;
    runBtn.textContent = controls.running ? 'Pause' : 'Run';
    runBtn.style.background = controls.running ? '#c75a3a' : '#4a7c59';
    onUpdate?.();
  });
  menuContent.appendChild(runBtn);

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset Water';
  resetBtn.style.cssText = `
    margin-left: 8px;
    padding: 8px 16px;
    background: #555;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  `;
  resetBtn.addEventListener('click', () => onUpdate?.('reset'));
  menuContent.appendChild(resetBtn);

  const resetAllBtn = document.createElement('button');
  resetAllBtn.textContent = 'Reset All';
  resetAllBtn.title = 'Clear patches, water, and sediment back to defaults';
  resetAllBtn.style.cssText = `
    display: block;
    margin-top: 6px;
    padding: 8px 16px;
    background: #6b3030;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    width: 100%;
  `;
  resetAllBtn.addEventListener('click', () => onUpdate?.('resetAll'));
  menuContent.appendChild(resetAllBtn);

  // View mode cycle buttons: Design / Flow / Sediment
  const viewModeDiv = document.createElement('div');
  viewModeDiv.style.cssText = 'display: flex; gap: 4px; margin-top: 8px;';
  const viewModes = [
    { id: 'design', label: 'Design', title: 'Full patch colors with water overlay' },
    { id: 'flow',   label: 'Flow',   title: 'Desaturated patches, prominent streamlines' },
    { id: 'sediment', label: 'Sediment', title: 'Amplified sediment deposition view' },
    { id: 'fire', label: 'Fire', title: 'Fire spread states and ember particles' },
  ];
  const viewBtns = viewModes.map(({ id, label, title }) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.title = title;
    const isActive = () => controls.viewMode === id;
    const refresh = () => {
      btn.style.background = isActive() ? '#4a5a7d' : 'transparent';
      btn.style.color = isActive() ? '#fff' : '#888';
      btn.style.borderColor = isActive() ? '#6a7aad' : '#444';
    };
    btn.style.cssText = `
      flex: 1;
      padding: 5px 4px;
      border: 1px solid #444;
      background: transparent;
      color: #888;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      transition: background 0.15s;
    `;
    btn.addEventListener('click', () => {
      controls.viewMode = id;
      viewBtns.forEach(b => b._refresh());
    });
    btn._refresh = refresh;
    refresh();
    return btn;
  });
  viewBtns.forEach(btn => viewModeDiv.appendChild(btn));
  menuContent.appendChild(viewModeDiv);

  const restoreBtn = document.createElement('button');
  restoreBtn.textContent = 'Restore';
  restoreBtn.style.cssText = `
    display: block;
    margin-top: 8px;
    padding: 8px 16px;
    background: #2d5a3d;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    width: 100%;
  `;
  restoreBtn.title = 'Replace ~30% of patches with wetland/forest';
  restoreBtn.addEventListener('click', () => onUpdate?.('restore'));
  menuContent.appendChild(restoreBtn);


  const exportBtn = document.createElement('button');
  exportBtn.textContent = 'Export';
  exportBtn.style.cssText = `
    margin-top: 8px;
    padding: 6px 12px;
    background: #3d5a7d;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    margin-right: 4px;
  `;
  exportBtn.title = 'Export patch configuration as JSON';
  exportBtn.addEventListener('click', () => onUpdate?.('export'));
  menuContent.appendChild(exportBtn);

  const importBtn = document.createElement('button');
  importBtn.textContent = 'Import';
  importBtn.style.cssText = `
    padding: 6px 12px;
    background: #3d5a7d;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  `;
  importBtn.title = 'Import patch configuration from JSON';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) {
      const r = new FileReader();
      r.onload = () => {
        try {
          const data = JSON.parse(r.result);
          onUpdate?.('import', data);
        } catch (err) {
          alert('Invalid JSON file');
        }
      };
      r.readAsText(f);
    }
    fileInput.value = '';
  });
  importBtn.addEventListener('click', () => fileInput.click());
  menuContent.appendChild(importBtn);
  menuContent.appendChild(fileInput);

  const metricsDiv = document.createElement('div');
  metricsDiv.id = 'mosaic-metrics';
  metricsDiv.style.cssText = 'margin-top: 12px;';

  const metricsText = document.createElement('div');
  metricsText.id = 'mosaic-metrics-text';
  metricsText.style.cssText = 'font-size: 11px; color: #aaa; line-height: 1.6;';
  metricsText.innerHTML = 'Conn: — | Particles: —';
  metricsDiv.appendChild(metricsText);

  menuContent.appendChild(metricsDiv);

  // ── Right-side time-series chart panel ──────────────────────────────────
  const CHART_W = 220;
  const CHART_H = 400;
  const PANEL_H = CHART_H / 4;

  const chartCanvas = document.createElement('canvas');
  chartCanvas.width = CHART_W;
  chartCanvas.height = CHART_H;
  chartCanvas.style.cssText = `
    position: absolute;
    top: 10px;
    right: 10px;
    background: rgba(12, 12, 16, 0.95);
    border: 1px solid #2a2a3a;
    border-radius: 6px;
    z-index: 100;
    pointer-events: none;
  `;
  mosaicContainer.appendChild(chartCanvas);

  const infoBtn = document.createElement('button');
  infoBtn.textContent = 'ℹ Info';
  infoBtn.title = 'Model documentation';
  infoBtn.style.cssText = `
    position: absolute;
    bottom: 16px;
    right: 16px;
    padding: 8px 14px;
    background: rgba(50, 50, 65, 0.9);
    border: 1px solid #555;
    border-radius: 6px;
    color: #bbb;
    font-size: 13px;
    cursor: pointer;
    z-index: 100;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  `;
  mosaicContainer.appendChild(infoBtn);

  const infoModal = document.createElement('div');
  infoModal.id = 'mosaic-info-modal';
  infoModal.style.cssText = `
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7);
    z-index: 10000;
    justify-content: center;
    align-items: center;
    padding: 24px;
    overflow-y: auto;
  `;
  const infoPanel = document.createElement('div');
  infoPanel.style.cssText = `
    background: #1e1e26;
    color: #e0e0e0;
    max-width: 640px;
    max-height: 85vh;
    overflow-y: auto;
    padding: 24px;
    border-radius: 10px;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  `;

  const patchTable = Object.entries(PATCH_PARAMS).map(([key, p]) =>
    `<tr>
      <td style="color:${p.color};font-weight:bold">${p.name}</td>
      <td>${p.manningN}</td>
      <td>${p.infiltration}</td>
      <td>${p.erodibility}</td>
      <td style="font-size:11px;color:#aaa">${getPatchBehavior(key, p)}</td>
    </tr>`
  ).join('');

  infoPanel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="margin:0;font-size:18px">Land Mosaic Flow Model</h2>
      <button id="info-modal-close" style="background:#555;border:none;color:#fff;padding:6px 12px;border-radius:4px;cursor:pointer">Close</button>
    </div>
    <h3 style="margin-top:20px;font-size:14px">Model overview</h3>
    <p>This model combines Richard T.T. Forman's patch-matrix-corridor framework with overland flow physics. Rainfall falls uniformly; water flows downhill via steepest descent. Each patch type has distinct hydraulic properties that govern flow velocity, infiltration, and sediment transport.</p>
    <h3 style="margin-top:20px;font-size:14px">Equations</h3>
    <p><strong>Manning's equation</strong> (flow velocity):<br>
    <code style="background:#2a2a32;padding:2px 6px;border-radius:4px">v = (1/n) × R<sup>2/3</sup> × S<sup>1/2</sup></code><br>
    where <em>n</em> = roughness, <em>R</em> ≈ depth <em>h</em>, <em>S</em> = slope. Lower <em>n</em> → faster flow.</p>
    <p style="margin-top:10px"><strong>Continuity</strong>:<br>
    <code style="background:#2a2a32;padding:2px 6px;border-radius:4px">∂h/∂t = P − I − ∇·q</code><br>
    Change in depth = rainfall − infiltration − outflow.</p>
    <p style="margin-top:10px"><strong>Sediment</strong>: Particles spawn in erodible patches when depth and flow velocity exceed thresholds. They advect with flow and settle when velocity drops below ~0.005 m/s.</p>
    <h3 style="margin-top:20px;font-size:14px">Patch parameters</h3>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr style="text-align:left;border-bottom:1px solid #444">
          <th>Patch</th>
          <th>n</th>
          <th>Infilt (mm/hr)</th>
          <th>Erod.</th>
          <th>Behavior</th>
        </tr>
      </thead>
      <tbody>${patchTable}</tbody>
    </table>

    <h3 style="margin-top:28px;font-size:14px;border-top:1px solid #333;padding-top:20px">Agent system</h3>
    <p style="color:#888;font-size:12px;margin-bottom:14px">This model is developed with a set of specialized Claude agents. Each agent has a focused role and persistent memory across sessions. Invoke them from the Claude Code CLI inside this project directory.</p>

    <div style="display:grid;gap:10px">

      <div style="background:#16161e;border:1px solid #2a2a3a;border-radius:6px;padding:12px">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
          <span style="color:#7ab3ff;font-weight:bold;font-size:12px">orchestrator</span>
          <span style="color:#555;font-size:10px">entry point</span>
        </div>
        <p style="margin:0;font-size:11px;color:#aaa">Routes any question to the right specialist agents, collects their outputs, and returns a synthesized response. Start here for broad or multi-domain questions — e.g. "my flow outputs feel wrong, what should I fix?"</p>
      </div>

      <div style="background:#16161e;border:1px solid #2a2a3a;border-radius:6px;padding:12px">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
          <span style="color:#ff7a7a;font-weight:bold;font-size:12px">model-diagnostician</span>
          <span style="color:#555;font-size:10px">diagnosis</span>
        </div>
        <p style="margin:0;font-size:11px;color:#aaa">Audits the model code and returns exactly: one genuine strength, three specific failure modes (naming files, functions, data structures), and the hardest question the model cannot currently answer. Run this first before any dev sprint or crit.</p>
      </div>

      <div style="background:#16161e;border:1px solid #2a2a3a;border-radius:6px;padding:12px">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
          <span style="color:#ff7a7a;font-weight:bold;font-size:12px">representation-critic</span>
          <span style="color:#555;font-size:10px">diagnosis</span>
        </div>
        <p style="margin:0;font-size:11px;color:#aaa">Evaluates whether the visualization actually communicates the dynamics it models. Asks: can a viewer see how changing a patch changes a corridor? Returns three specific representational changes ranked by legibility impact. Run before every studio review.</p>
      </div>

      <div style="background:#16161e;border:1px solid #2a2a3a;border-radius:6px;padding:12px">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
          <span style="color:#b8e04a;font-weight:bold;font-size:12px">theory-scout</span>
          <span style="color:#555;font-size:10px">theory</span>
        </div>
        <p style="margin:0;font-size:11px;color:#aaa">Finds the 2–3 most relevant theoretical frameworks for a specific model question (e.g. "how should patch permeability affect corridor width?") and translates them into computational terms. Flags where the literature is contested or silent. Feed output to flow-physics-translator.</p>
      </div>

      <div style="background:#16161e;border:1px solid #2a2a3a;border-radius:6px;padding:12px">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
          <span style="color:#b8e04a;font-weight:bold;font-size:12px">flow-physics-translator</span>
          <span style="color:#555;font-size:10px">theory → code</span>
        </div>
        <p style="margin:0;font-size:11px;color:#aaa">Translates ecological concepts (corridor connectivity, resistance surfaces, percolation thresholds) into data structures and algorithms. Returns a recommended approach with rationale, a minimal code sketch, and key parameters to calibrate. Flags computational bottlenecks before you hit them.</p>
      </div>

      <div style="background:#16161e;border:1px solid #2a2a3a;border-radius:6px;padding:12px">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
          <span style="color:#b8e04a;font-weight:bold;font-size:12px">flow-specialist</span>
          <span style="color:#555;font-size:10px">hydrology</span>
        </div>
        <p style="margin:0;font-size:11px;color:#aaa">Deep technical grounding in how water moves through heterogeneous landscapes — surface runoff, infiltration, subsurface lateral flow, patch-edge effects. Use when flow logic feels too simple or when outputs don't match physical intuition. Keeps advice implementation-ready.</p>
      </div>

      <div style="background:#16161e;border:1px solid #2a2a3a;border-radius:6px;padding:12px">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
          <span style="color:#ffa84a;font-weight:bold;font-size:12px">scenario-logic-generator</span>
          <span style="color:#555;font-size:10px">testing</span>
        </div>
        <p style="margin:0;font-size:11px;color:#aaa">Generates 5–10 graduated what-if test scenarios ordered by complexity (single-patch edits → cascading multi-patch disturbances). Each scenario specifies the input change, expected output, and what a broken model response looks like. Use to build a validation suite before any major revision.</p>
      </div>

      <div style="background:#16161e;border:1px solid #2a2a3a;border-radius:6px;padding:12px">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
          <span style="color:#7ab3ff;font-weight:bold;font-size:12px">design-fix</span>
          <span style="color:#555;font-size:10px">roadmap</span>
        </div>
        <p style="margin:0;font-size:11px;color:#aaa">Synthesizes outputs from all other agents into a prioritized development roadmap: immediate fixes (this week), medium-term restructuring, longer-term extensions. Each item includes root cause, minimum change, expected improvement, and a success criterion. Run before any dev sprint or crit prep.</p>
      </div>

    </div>
  `;

  infoModal.appendChild(infoPanel);
  document.body.appendChild(infoModal);

  infoBtn.addEventListener('click', () => {
    infoModal.style.display = 'flex';
  });
  infoPanel.querySelector('#info-modal-close').addEventListener('click', () => {
    infoModal.style.display = 'none';
  });
  infoModal.addEventListener('click', (e) => {
    if (e.target === infoModal) infoModal.style.display = 'none';
  });

  // Chart panel config
  const PANELS = [
    { key: 'runoffRatio',  label: 'RUNOFF',  unit: '0–1',      color: '#4a9eff', fmt: v => v.toFixed(2) },
    { key: 'meanStorage',  label: 'STORAGE', unit: 'mm depth', color: '#3dd6a3', fmt: v => (v * 1000).toFixed(2) },
    { key: 'etFraction',   label: 'ET',      unit: '0–1',      color: '#7dd87d', fmt: v => v.toFixed(2) },
    { key: 'concentration',label: 'CONCEN.', unit: '0–1',      color: '#f0b429', fmt: v => v.toFixed(2) },
  ];

  function drawChartPanel(chartHistory, interventionMarkers, running) {
    const ctx = chartCanvas.getContext('2d');
    ctx.clearRect(0, 0, CHART_W, CHART_H);
    ctx.fillStyle = 'rgba(12, 12, 16, 0.95)';
    ctx.fillRect(0, 0, CHART_W, CHART_H);

    if (!running) {
      ctx.fillStyle = '#444';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('PAUSED', CHART_W / 2, CHART_H / 2);
      ctx.textAlign = 'left';
    }

    const n = chartHistory.length;
    const PAD = 4;

    PANELS.forEach((panel, pi) => {
      const py = pi * PANEL_H;

      // Panel divider
      if (pi > 0) {
        ctx.strokeStyle = '#2a2a3a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, py);
        ctx.lineTo(CHART_W, py);
        ctx.stroke();
      }

      // Mid-level faint rule
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, py + PANEL_H * 0.5);
      ctx.lineTo(CHART_W, py + PANEL_H * 0.5);
      ctx.stroke();

      if (n < 2) {
        // Labels only
        ctx.fillStyle = panel.color;
        ctx.font = 'bold 9px system-ui';
        ctx.fillText(panel.label, PAD, py + 12);
        return;
      }

      // Auto-scale y to visible window
      let maxVal = 1e-9;
      for (const d of chartHistory) { if (d[panel.key] > maxVal) maxVal = d[panel.key]; }
      maxVal *= 1.12; // 12% headroom

      const chartTop = py + PAD + 16;
      const chartBot = py + PANEL_H - PAD;
      const chartH = chartBot - chartTop;
      const chartLeft = PAD;
      const chartRight = CHART_W - PAD;
      const chartW = chartRight - chartLeft;

      // Intervention tick lines (across full panel height)
      if (interventionMarkers?.length > 0) {
        for (const m of interventionMarkers) {
          const x = chartLeft + (1 - m.framesAgo / 300) * chartW;
          if (x < chartLeft) continue;
          ctx.strokeStyle = 'rgba(255, 210, 80, 0.3)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(x, py);
          ctx.lineTo(x, py + PANEL_H);
          ctx.stroke();
          ctx.setLineDash([]);
          // Label only on top panel
          if (pi === 0) {
            ctx.fillStyle = 'rgba(255, 210, 80, 0.75)';
            ctx.font = '7px system-ui';
            ctx.fillText(m.patchKey.slice(0, 3), x + 2, py + 10);
          }
        }
      }

      // Area fill under curve
      ctx.beginPath();
      ctx.fillStyle = panel.color.replace(')', ', 0.12)').replace('rgb', 'rgba').replace('#', '');
      // Use a simpler approach for hex color fill
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = panel.color;
      ctx.moveTo(chartLeft, chartBot);
      for (let k = 0; k < n; k++) {
        const x = chartLeft + (k / (n - 1)) * chartW;
        const v = chartHistory[k][panel.key];
        const y = chartBot - Math.min(1, v / maxVal) * chartH;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(chartRight, chartBot);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;

      // Line
      ctx.beginPath();
      ctx.strokeStyle = panel.color;
      ctx.lineWidth = 1.5;
      for (let k = 0; k < n; k++) {
        const x = chartLeft + (k / (n - 1)) * chartW;
        const v = chartHistory[k][panel.key];
        const y = chartBot - Math.min(1, v / maxVal) * chartH;
        k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Panel label (top-left)
      ctx.fillStyle = panel.color;
      ctx.font = 'bold 9px system-ui';
      ctx.fillText(panel.label, PAD, py + 12);

      // Current value (top-right)
      const cur = chartHistory[n - 1][panel.key];
      const valStr = panel.fmt(cur);
      ctx.font = '9px system-ui';
      const tw = ctx.measureText(valStr).width;
      ctx.fillText(valStr, CHART_W - PAD - tw, py + 12);
    });

    // Bottom legend
    ctx.fillStyle = '#444';
    ctx.font = '7px system-ui';
    ctx.fillText('runoff · storage(mm) · ET · concentration', PAD, CHART_H - 3);
  }

  return {
    controls,
    updateMetrics: ({ chartHistory, interventionMarkers, connectivity, sedimentCount }) => {
      // Left panel metrics text
      const last = chartHistory?.length > 0 ? chartHistory[chartHistory.length - 1] : null;
      metricsText.innerHTML = last
        ? `Runoff: ${last.runoffRatio.toFixed(2)} | ET: ${last.etFraction.toFixed(2)} | Conn: ${(connectivity ?? 0).toFixed(2)} | Sed: ${sedimentCount ?? 0}`
        : `Conn: ${(connectivity ?? 0).toFixed(2)} | Particles: ${sedimentCount ?? 0}`;

      // Right chart panel
      drawChartPanel(chartHistory ?? [], interventionMarkers ?? [], true);
    },
  };
}
