/**
 * tabs.js — Shared tab-switching logic.
 *
 * Four tabs: Mosaic, Site Analysis, Stream Table, Soil Study.
 * Stream Table and Soil Study lazy-initialize their modules on first activation.
 */

import { initParcelAnalysis, onTabActivated, stopSimOverlay } from './parcel-analysis.js';
import { simState } from './state.js';
import { sharedState, addListener } from './sharedState.js';

let _streamTableInited = false;
let _soilStudyInited = false;
let _soilBadge = null;

/**
 * Wire up tab buttons and initialize the parcel-analysis module.
 */
export function initTabs() {
  const mosaicEl      = document.getElementById('mosaic-container');
  const siteEl        = document.getElementById('site-analysis-container');
  const streamTableEl = document.getElementById('stream-table-container');
  const soilStudyEl   = document.getElementById('soil-study-container');
  const tabBtns       = document.querySelectorAll('.tab-btn[data-tab]');

  function hideAllPanes() {
    if (mosaicEl)      mosaicEl.style.display = 'none';
    if (siteEl)        siteEl.style.display = 'none';
    if (streamTableEl) streamTableEl.style.display = 'none';
    if (soilStudyEl)   soilStudyEl.style.display = 'none';
  }

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const tab = btn.dataset.tab;
      hideAllPanes();

      if (tab === 'mosaic') {
        if (mosaicEl) mosaicEl.style.display = 'flex';
        stopSimOverlay();
      } else if (tab === 'site') {
        if (siteEl) siteEl.style.display = 'block';
        onTabActivated();
      } else if (tab === 'stream-table') {
        if (streamTableEl) streamTableEl.style.display = 'block';
        if (!_streamTableInited) {
          _streamTableInited = true;
          import('./stream-table-tab.js').then(mod => {
            mod.initStreamTableTab('stream-table-container');
          });
        } else {
          import('./stream-table-tab.js').then(mod => {
            if (mod.onStreamTableActivated) mod.onStreamTableActivated();
          });
        }
      } else if (tab === 'soil-study') {
        if (soilStudyEl) soilStudyEl.style.display = 'block';
        if (!_soilStudyInited) {
          _soilStudyInited = true;
          import('./soil-study.js').then(mod => {
            mod.initSoilStudy('soil-study-container');
          });
        } else {
          import('./soil-study.js').then(mod => {
            if (mod.onSoilStudyActivated) mod.onSoilStudyActivated();
          });
        }
      }
    });
  });

  // Initialize parcel analysis (Site Analysis tab)
  initParcelAnalysis('site-analysis-container', {
    onGridReady: (patchGrid) => {
      if (simState.loadParcelGrid) simState.loadParcelGrid(patchGrid);
    },
    onRunSim: () => {
      document.querySelector('[data-tab="mosaic"]')?.click();
      requestAnimationFrame(() => {
        if (simState.controls) simState.controls.running = true;
      });
    },
  });

  // ── Soil Study notification badge ──
  const soilBtn = document.querySelector('[data-tab="soil-study"]');
  if (soilBtn) {
    _soilBadge = document.createElement('span');
    _soilBadge.style.cssText = `
      display: none; width: 8px; height: 8px; border-radius: 50%;
      background: #dc503c; margin-left: 6px;
      animation: soil-badge-pulse 1.5s ease-in-out infinite;
    `;
    soilBtn.appendChild(_soilBadge);

    // Inject pulse animation if not present
    if (!document.getElementById('soil-badge-anim')) {
      const style = document.createElement('style');
      style.id = 'soil-badge-anim';
      style.textContent = `@keyframes soil-badge-pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }`;
      document.head.appendChild(style);
    }

    // Show badge when fire completes, hide when soil study tab is clicked
    addListener(() => {
      if (sharedState.scenarioPhase === 'fire-complete' && _soilBadge) {
        _soilBadge.style.display = 'inline-block';
      }
    });

    soilBtn.addEventListener('click', () => {
      if (_soilBadge) _soilBadge.style.display = 'none';
    });
  }
}
