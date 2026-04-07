/**
 * tabs.js — Shared tab-switching logic.
 *
 * Three tabs: Mosaic, Site Analysis, Stream Table.
 * Stream Table lazy-initializes its own module on first activation.
 */

import { initParcelAnalysis, onTabActivated, stopSimOverlay } from './parcel-analysis.js';
import { simState } from './state.js';

let _streamTableInited = false;

/**
 * Wire up tab buttons and initialize the parcel-analysis module.
 */
export function initTabs() {
  const mosaicEl      = document.getElementById('mosaic-container');
  const siteEl        = document.getElementById('site-analysis-container');
  const streamTableEl = document.getElementById('stream-table-container');
  const tabBtns       = document.querySelectorAll('.tab-btn[data-tab]');

  function hideAllPanes() {
    if (mosaicEl)      mosaicEl.style.display = 'none';
    if (siteEl)        siteEl.style.display = 'none';
    if (streamTableEl) streamTableEl.style.display = 'none';
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
}
