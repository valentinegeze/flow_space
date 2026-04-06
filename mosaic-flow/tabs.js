/**
 * tabs.js — Shared tab-switching logic.
 *
 * Used by both index.html (ES module) and build-standalone.js (bundled).
 * Avoids duplicating the show/hide logic in two places.
 */

import { initParcelAnalysis, onTabActivated, stopSimOverlay } from './parcel-analysis.js';
import { simState } from './state.js';

/**
 * Wire up tab buttons and initialize the parcel-analysis module.
 *
 * @param {Object} opts
 * @param {boolean} [opts.enableFireSweep]  If true, also wire the FireSweep tab
 *   (requires firesweep-tab.js to be loaded separately).
 */
export function initTabs({ enableFireSweep = false } = {}) {
  const mosaicEl    = document.getElementById('mosaic-container');
  const siteEl      = document.getElementById('site-analysis-container');
  const firesweepEl = document.getElementById('firesweep-container');
  const tabBtns     = document.querySelectorAll('.tab-btn[data-tab]');

  function hideAllPanes() {
    if (mosaicEl)    mosaicEl.style.display = 'none';
    if (siteEl)      siteEl.style.display = 'none';
    if (firesweepEl) firesweepEl.style.display = 'none';
  }

  // Lazy references for firesweep (only resolved if enableFireSweep is true)
  let _fsInit = null;
  let _fsPause = null;
  let _fsActivated = null;

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const tab = btn.dataset.tab;
      hideAllPanes();
      if (_fsPause) _fsPause();

      if (tab === 'mosaic') {
        if (mosaicEl) mosaicEl.style.display = 'flex';
        stopSimOverlay();
      } else if (tab === 'site') {
        if (siteEl) siteEl.style.display = 'block';
        onTabActivated();
      } else if (tab === 'firesweep' && enableFireSweep) {
        if (firesweepEl) firesweepEl.style.display = 'block';
        if (_fsInit)      _fsInit('firesweep-container');
        if (_fsActivated) _fsActivated();
      }
    });
  });

  // Initialize parcel analysis
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

  // Return a handle so the caller can register firesweep callbacks
  return {
    /**
     * Register FireSweep tab callbacks after dynamic import.
     */
    setFireSweep(initFn, pauseFn, activatedFn) {
      _fsInit = initFn;
      _fsPause = pauseFn;
      _fsActivated = activatedFn;
    },
  };
}
