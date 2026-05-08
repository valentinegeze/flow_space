/**
 * tabs.js — Sequential step navigation.
 *
 * Three steps: Delineate Site → Model Fire → Analyze Burn Scar.
 * Steps unlock progressively but completed steps remain freely navigable.
 */

import { initParcelAnalysis, onTabActivated, stopSimOverlay } from './parcel-analysis.js';
import { simState } from './state.js';
import { sharedState, addListener } from './sharedState.js';

let _currentStep = 'site';
let _unlockedSteps = new Set(['site']);
let _completedSteps = new Set();

/**
 * Wire up step buttons and initialize the parcel-analysis module.
 */
export function initTabs() {
  const siteEl      = document.getElementById('site-analysis-container');
  const mosaicEl    = document.getElementById('mosaic-container');
  const soilStudyEl = document.getElementById('soil-study-container');
  const stepBtns    = document.querySelectorAll('.step-btn[data-step]');

  let _soilStudyInited = false;

  const panes = { site: siteEl, mosaic: mosaicEl, 'soil-study': soilStudyEl };

  function hideAllPanes() {
    Object.values(panes).forEach(el => {
      if (el) el.classList.remove('step-active');
    });
  }

  function refreshStepBtns() {
    stepBtns.forEach(btn => {
      const step = btn.dataset.step;
      btn.classList.toggle('unlocked', _unlockedSteps.has(step));
      btn.classList.toggle('active', step === _currentStep);
      btn.classList.toggle('completed', _completedSteps.has(step));
    });
  }

  function switchToStep(step) {
    if (!_unlockedSteps.has(step)) return;
    _currentStep = step;
    sharedState.currentStep = step;
    hideAllPanes();
    refreshStepBtns();

    if (step === 'site') {
      if (siteEl) siteEl.classList.add('step-active');
      onTabActivated();
    } else if (step === 'mosaic') {
      if (mosaicEl) mosaicEl.classList.add('step-active');
      stopSimOverlay();
    } else if (step === 'soil-study') {
      if (soilStudyEl) soilStudyEl.classList.add('step-active');
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
  }

  function unlockStep(step) {
    _unlockedSteps.add(step);
    refreshStepBtns();
  }

  function completeStep(step) {
    _completedSteps.add(step);
    refreshStepBtns();
  }

  // Wire click handlers
  stepBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const step = btn.dataset.step;
      if (_unlockedSteps.has(step)) switchToStep(step);
    });
  });

  // Initialize parcel analysis (Step 1)
  initParcelAnalysis('site-analysis-container', {
    onGridReady: (patchGrid) => {
      if (simState.loadParcelGrid) simState.loadParcelGrid(patchGrid);
      // Step 1 complete, unlock step 2
      completeStep('site');
      unlockStep('mosaic');
    },
    onRunSim: () => {
      // Advance to step 2
      switchToStep('mosaic');
      requestAnimationFrame(() => {
        if (simState.controls) simState.controls.running = true;
      });
    },
  });

  // Fire-complete prompt — floating arrow that points the user toward Step 3
  // when the burn finishes. Lives inside the mosaic container so it overlays
  // the fire visualization rather than stealing screen real estate up-front.
  const continuePrompt = document.createElement('button');
  continuePrompt.className = 'fire-continue-prompt';
  continuePrompt.style.display = 'none';
  continuePrompt.innerHTML = `
    <span class="fire-continue-cta">Analyze burn scar <span class="fire-continue-arrow">→</span></span>
  `;
  continuePrompt.addEventListener('click', () => {
    continuePrompt.style.display = 'none';
    switchToStep('soil-study');
  });
  if (mosaicEl) mosaicEl.appendChild(continuePrompt);

  // Watch for fire completion → unlock step 3 + reveal the prompt.
  addListener(() => {
    if (sharedState.scenarioPhase === 'fire-complete') {
      completeStep('mosaic');
      unlockStep('soil-study');
      if (_currentStep === 'mosaic') continuePrompt.style.display = '';
    } else if (sharedState.scenarioPhase === 'pre-fire' || sharedState.scenarioPhase === 'fire-running') {
      // Fire reset / restart — hide the prompt again until the next completion.
      continuePrompt.style.display = 'none';
    }
  });

  // Entry fork: shown above everything until the user picks a path. Clicking
  // "Delineate a site" hides the fork and reveals the existing parcel-analysis
  // tool (Step 1). Clicking "Randomize a landscape" hides the fork, triggers
  // a randomize action on the simulation, unlocks Step 2, and jumps there.
  const forkEl = document.getElementById('entry-fork');

  function dismissFork() {
    if (forkEl) forkEl.classList.add('hidden');
  }

  function startWithRandomize() {
    dismissFork();
    // Mark Step 1 as completed so it appears in the step bar as a freely-
    // navigable past step; unlock Step 2 and switch to it.
    completeStep('site');
    unlockStep('mosaic');
    switchToStep('mosaic');
    // Trigger the randomize action via the same dispatcher the in-tool
    // "Randomize" button uses. Wait one frame so simState.controls is ready
    // even when boot order varies.
    requestAnimationFrame(() => {
      simState.controls?.onUpdate?.('randomize');
      if (simState.controls) simState.controls.running = true;
    });
  }

  function startWithDelineate() {
    dismissFork();
    switchToStep('site');
    // Real-parcel path: synthetic Terrain presets are irrelevant since DEM
    // is loaded from the parcel itself. Hide the whole Terrain section in the
    // mosaic panel. The element is created during sketch.js boot so it's
    // present by the time we reach here.
    const terrain = document.getElementById('mosaic-terrain-section');
    if (terrain) terrain.style.display = 'none';
  }

  if (forkEl) {
    for (const btn of forkEl.querySelectorAll('[data-fork]')) {
      btn.addEventListener('click', () => {
        if (btn.dataset.fork === 'delineate') startWithDelineate();
        else if (btn.dataset.fork === 'randomize') startWithRandomize();
      });
    }
  } else {
    // Fork element missing — fall back to the original behavior.
    switchToStep('site');
  }
}
