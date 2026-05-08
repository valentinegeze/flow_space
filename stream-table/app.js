/**
 * app.js — Multi-view synchronized stream table player + analysis integration.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Video sources
// ═══════════════════════════════════════════════════════════════════════════

const VIDEO_FILES = {
  anna:      'videos/AM_03-11_01_wide-inlet_no-obstacles.mp4',
  sophia:    'videos/skm_0311_01_wide_no-obs.mp4',
  valentine: 'videos/vmg_03-11_01.mp4',
  // Kinect: original .mkv is huge (audio-less, depth+color), so we point
  // straight at the extracted color proxy. resolveSrc() will accept this
  // path as-is; sync.json's clap_time_s=27.4 timing still applies.
  kinect:    'videos/proxies/kinect_color.mp4',
};

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════

let syncData = null;
let videos = {};            // label → { el, offset, duration, ready, stalled, errored }
let userWantsPlay = false;  // user intent (distinct from actual playing)
let selectedView = null;
let masterDuration = 0;
let masterTime = 0;         // current position on the common timeline
let rafId = null;
let allReady = false;
let stallRecoveryPending = false;
const DRIFT_THRESHOLD = 0.08;  // seconds — tighter sync during playback
const SEEK_EPSILON    = 0.05;  // don't re-seek if within this

// Analysis
let worker = null;
let analysisRunning = false;
let analysisFrames = [];

// ═══════════════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════════════

async function init() {
  await loadSyncData();
  await loadVideos();
  wireTransportControls();
  wireAnalysisControls();
  wireTileSelection();
}

async function loadSyncData() {
  const statusEl = document.getElementById('sync-status');
  try {
    const res = await fetch('data/sync.json');
    syncData = await res.json();
    statusEl.textContent = `Synced via ${syncData.method} — reference: ${syncData.reference_label}`;
    statusEl.className = 'sync-status loaded';
  } catch (e) {
    statusEl.textContent = 'Sync data not found — run scripts/sync_clap.py first';
    statusEl.className = 'sync-status error';
    syncData = { videos: {} };
    for (const label of Object.keys(VIDEO_FILES)) {
      syncData.videos[label] = { offset_s: 0 };
    }
  }
}

async function resolveSrc(originalSrc) {
  // Prefer a proxy if one exists (same filename under videos/proxies/).
  const filename = originalSrc.split('/').pop();
  const proxySrc = `videos/proxies/${filename}`;
  try {
    const res = await fetch(proxySrc, { method: 'HEAD' });
    if (res.ok) {
      console.log(`[proxy] using ${proxySrc}`);
      return proxySrc;
    }
  } catch (e) {}
  return originalSrc;
}

async function loadVideos() {
  const promises = [];
  const bufferBar = document.getElementById('buffer-bar');
  bufferBar.innerHTML = '';

  for (const [label, src] of Object.entries(VIDEO_FILES)) {
    const tile = document.querySelector(`.video-tile[data-view="${label}"]`);
    if (!tile) continue;

    const videoEl = tile.querySelector('video');
    const statusEl = tile.querySelector('.tile-status');
    // Master time 0 = the clap moment. Video time for this view = masterTime + clap_time_s.
    // Pre-clap footage is inaccessible from the master timeline by design.
    const clapTime = syncData.videos[label]?.clap_time_s ?? 0;

    videos[label] = {
      el: videoEl,
      offset: clapTime,
      clapTime,
      duration: 0,
      ready: false,
      stalled: false,
      errored: false,
      statusEl,
    };

    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.label = label;
    chip.textContent = `${label[0].toUpperCase() + label.slice(1)} —`;
    bufferBar.appendChild(chip);

    wireVideoEvents(label, videoEl);

    // Resolve source (proxy if available) then start loading.
    resolveSrc(src).then(resolvedSrc => {
      videoEl.src = resolvedSrc;
      videoEl.load();
    });

    const p = new Promise((resolve) => {
      const onLoaded = () => {
        videos[label].duration = videoEl.duration;
        videos[label].ready = true;
        setTileStatus(label, 'ready', 'Ready');
        console.log(`[${label}] ready: ${videoEl.duration.toFixed(1)}s, clap at ${clapTime}s`);
        resolve();
      };
      videoEl.addEventListener('loadedmetadata', onLoaded, { once: true });

      videoEl.addEventListener('error', (e) => {
        console.error(`[${label}] failed to load:`, e);
        videos[label].errored = true;
        setTileStatus(label, 'error', 'Failed');
        resolve();
      }, { once: true });

      setTimeout(() => {
        if (!videos[label].ready && !videos[label].errored) {
          console.warn(`[${label}] metadata timeout`);
          setTileStatus(label, 'loading', 'Slow…');
          resolve();
        }
      }, 15000);
    });

    promises.push(p);
  }

  return Promise.all(promises).then(() => {
    computeMasterDuration();
    seekAll(0);
    allReady = Object.values(videos).some(v => v.ready);
    const playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.disabled = !allReady;
    console.log(`All videos loaded. Master duration: ${masterDuration.toFixed(1)}s`);
  });
}

function setTileStatus(label, state, text) {
  const v = videos[label];
  if (!v?.statusEl) return;
  v.statusEl.dataset.state = state;
  v.statusEl.textContent = text;
}

function updateBufferChip(label) {
  const v = videos[label];
  if (!v?.el) return;
  const chip = document.querySelector(`.buffer-bar .chip[data-label="${label}"]`);
  if (!chip) return;
  const el = v.el;
  let bufferedEnd = 0;
  try {
    for (let i = 0; i < el.buffered.length; i++) {
      if (el.currentTime >= el.buffered.start(i) && el.currentTime <= el.buffered.end(i)) {
        bufferedEnd = el.buffered.end(i);
        break;
      }
    }
  } catch (e) {}
  const ahead = Math.max(0, bufferedEnd - el.currentTime);
  const name = label[0].toUpperCase() + label.slice(1);
  chip.textContent = `${name} ${v.stalled ? '⏸' : '▸'} ${ahead.toFixed(1)}s`;
  chip.classList.toggle('stalled', v.stalled);
}

function wireVideoEvents(label, videoEl) {
  videoEl.addEventListener('waiting', () => {
    const v = videos[label];
    if (!v) return;
    v.stalled = true;
    setTileStatus(label, 'buffer', 'Buffering');
    updateBufferChip(label);
    if (userWantsPlay) pauseAllForStall();
  });

  videoEl.addEventListener('stalled', () => {
    const v = videos[label];
    if (!v) return;
    v.stalled = true;
    setTileStatus(label, 'buffer', 'Stalled');
    updateBufferChip(label);
    if (userWantsPlay) pauseAllForStall();
  });

  videoEl.addEventListener('canplay', () => {
    const v = videos[label];
    if (!v) return;
    v.stalled = false;
    setTileStatus(label, userWantsPlay ? 'playing' : 'ready', userWantsPlay ? 'Playing' : 'Ready');
    updateBufferChip(label);
    maybeResumeAfterStall();
  });

  videoEl.addEventListener('playing', () => {
    const v = videos[label];
    if (!v) return;
    v.stalled = false;
    setTileStatus(label, 'playing', 'Playing');
    updateBufferChip(label);
  });

  videoEl.addEventListener('pause', () => {
    const v = videos[label];
    if (!v) return;
    if (!v.stalled) setTileStatus(label, 'ready', 'Ready');
    updateBufferChip(label);
  });
}

function pauseAllForStall() {
  for (const v of Object.values(videos)) {
    if (v.ready && !v.el.paused) v.el.pause();
  }
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function maybeResumeAfterStall() {
  if (!userWantsPlay || stallRecoveryPending) return;
  const readyVideos = Object.values(videos).filter(v => v.ready);
  const anyStalled = readyVideos.some(v => v.stalled || v.el.readyState < 3);
  if (anyStalled) return;

  stallRecoveryPending = true;
  // Re-align all videos to the current master time, then resume.
  alignAndPlay(masterTime).finally(() => { stallRecoveryPending = false; });
}

function computeMasterDuration() {
  const durations = Object.values(videos)
    .filter(v => v.ready)
    .map(v => v.duration - v.offset);

  if (durations.length === 0) return;
  masterDuration = Math.max(1, Math.min(...durations));

  const scrubber = document.getElementById('scrubber');
  scrubber.max = Math.round(masterDuration * 10); // 0.1s resolution
  scrubber.value = 0;

  console.log(`Master duration: ${masterDuration.toFixed(1)}s, scrubber max: ${scrubber.max}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Transport controls
// ═══════════════════════════════════════════════════════════════════════════

function wireTransportControls() {
  document.getElementById('play-btn').addEventListener('click', togglePlay);
  document.getElementById('resync-btn').addEventListener('click', () => {
    // Hard re-align: force seek every video to the current master time.
    for (const v of Object.values(videos)) {
      if (v.ready) v.el.currentTime = masterTime + v.offset;
    }
  });

  const scrubber = document.getElementById('scrubber');
  let wasPlaying = false;

  scrubber.addEventListener('mousedown', () => {
    wasPlaying = userWantsPlay;
    if (userWantsPlay) togglePlay();
  });
  scrubber.addEventListener('touchstart', () => {
    wasPlaying = userWantsPlay;
    if (userWantsPlay) togglePlay();
  });

  scrubber.addEventListener('input', () => {
    const t = Number(scrubber.value) / 10;
    masterTime = t;
    seekAll(t);
    updateTimecode(t);
  });

  const resume = () => { if (wasPlaying) togglePlay(); };
  scrubber.addEventListener('mouseup', resume);
  scrubber.addEventListener('touchend', resume);

  document.getElementById('step-back').addEventListener('click', () => stepFrames(-1));
  document.getElementById('step-fwd').addEventListener('click', () => stepFrames(1));

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowLeft') { e.preventDefault(); stepFrames(-3); }
    if (e.code === 'ArrowRight') { e.preventDefault(); stepFrames(3); }
  });
}

function togglePlay() {
  if (!allReady) return;

  userWantsPlay = !userWantsPlay;
  const playBtn = document.getElementById('play-btn');
  playBtn.textContent = userWantsPlay ? 'Pause' : 'Play';
  playBtn.classList.toggle('active', userWantsPlay);

  if (userWantsPlay) {
    alignAndPlay(masterTime);
  } else {
    for (const v of Object.values(videos)) {
      if (v.ready) v.el.pause();
    }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }
}

// Seek every video to (masterTime + offset), wait for all seeks to complete,
// wait for enough buffered data, then play them on the same animation frame.
async function alignAndPlay(t) {
  masterTime = Math.max(0, Math.min(t, masterDuration));

  const tasks = [];
  for (const v of Object.values(videos)) {
    if (!v.ready) continue;
    const target = masterTime + v.offset;
    tasks.push(seekAndWaitReady(v, target));
  }
  await Promise.all(tasks);
  if (!userWantsPlay) return;  // user may have cancelled during wait

  // Kick playback as close to simultaneously as possible.
  const playPromises = Object.values(videos)
    .filter(v => v.ready)
    .map(v => v.el.play().catch(err => {
      console.warn('Play blocked:', err.message);
    }));
  await Promise.all(playPromises);

  if (!rafId) rafId = requestAnimationFrame(updateLoop);
}

function seekAndWaitReady(v, target) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      v.el.removeEventListener('seeked', onSeeked);
      v.el.removeEventListener('canplay', onCanPlay);
      resolve();
    };
    const onSeeked = () => { if (v.el.readyState >= 3) finish(); };
    const onCanPlay = () => { if (Math.abs(v.el.currentTime - target) < 0.2) finish(); };

    v.el.addEventListener('seeked', onSeeked);
    v.el.addEventListener('canplay', onCanPlay);

    if (Math.abs(v.el.currentTime - target) > SEEK_EPSILON) {
      v.el.currentTime = target;
    } else if (v.el.readyState >= 3) {
      finish();
    }
    setTimeout(finish, 4000);  // don't block forever
  });
}

function seekAll(t) {
  masterTime = Math.max(0, Math.min(t, masterDuration));

  for (const [, v] of Object.entries(videos)) {
    if (!v.ready) continue;
    const videoTime = masterTime + v.offset;
    if (Math.abs(v.el.currentTime - videoTime) > SEEK_EPSILON) {
      v.el.currentTime = videoTime;
    }
  }
}

function stepFrames(n) {
  const scrubber = document.getElementById('scrubber');
  const newVal = Math.max(0, Math.min(Number(scrubber.max), Number(scrubber.value) + n));
  scrubber.value = newVal;
  masterTime = newVal / 10;
  seekAll(masterTime);
  updateTimecode(masterTime);
}

let lastChipUpdate = 0;

function updateLoop() {
  if (!userWantsPlay) { rafId = null; return; }

  const refLabel = syncData?.reference_label || Object.keys(videos).find(l => videos[l].ready);
  const refVideo = videos[refLabel];

  if (refVideo && refVideo.ready && !refVideo.el.paused) {
    masterTime = refVideo.el.currentTime - refVideo.offset;

    const scrubber = document.getElementById('scrubber');
    scrubber.value = Math.round(masterTime * 10);
    updateTimecode(masterTime);

    // Drift correction: nudge every non-reference video toward expected time.
    for (const [label, v] of Object.entries(videos)) {
      if (label === refLabel || !v.ready || v.stalled) continue;
      const expectedTime = masterTime + v.offset;
      const drift = v.el.currentTime - expectedTime;
      if (Math.abs(drift) > DRIFT_THRESHOLD) {
        // Small drift: adjust playback rate briefly. Large drift: hard seek.
        if (Math.abs(drift) > 0.4) {
          v.el.currentTime = expectedTime;
          v.el.playbackRate = 1.0;
        } else {
          v.el.playbackRate = drift > 0 ? 0.95 : 1.05;
        }
      } else if (v.el.playbackRate !== 1.0) {
        v.el.playbackRate = 1.0;
      }
    }

  
    const now = performance.now();
    if (now - lastChipUpdate > 250) {
      lastChipUpdate = now;
      for (const label of Object.keys(videos)) updateBufferChip(label);
    }

    if (masterTime >= masterDuration - 0.1) {
      togglePlay();
      return;
    }
  }

  rafId = requestAnimationFrame(updateLoop);
}

function updateTimecode(t) {
  const el = document.getElementById('timecode');
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  el.textContent = `${m}:${s}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tile selection
// ═══════════════════════════════════════════════════════════════════════════

function wireTileSelection() {
  // Tile selection still works (highlights the active video) but the
  // analysis-section dropdown / button it used to drive were removed.
  // Skip the dropdown wiring when those elements are missing.
  const tiles = document.querySelectorAll('.video-tile');
  const analysisView = document.getElementById('analysis-view');
  const analyzeBtn   = document.getElementById('analyze-btn');
  tiles.forEach(tile => {
    tile.addEventListener('click', () => {
      tiles.forEach(t => t.classList.remove('selected'));
      tile.classList.add('selected');
      selectedView = tile.dataset.view;
      if (analysisView) analysisView.value = selectedView;
      if (analyzeBtn)   analyzeBtn.disabled = false;
    });
  });

  if (analysisView) {
    analysisView.addEventListener('change', (e) => {
      selectedView = e.target.value;
      tiles.forEach(t => t.classList.toggle('selected', t.dataset.view === selectedView));
      if (analyzeBtn) analyzeBtn.disabled = !selectedView;
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Analysis
// ═══════════════════════════════════════════════════════════════════════════

function wireAnalysisControls() {
  // Analysis section was removed (sections 02 and 03). Guard against missing
  // sliders / button so this still runs without throwing on the trimmed page.
  const sliders = [
    ['n-frames', 'n-frames-val'],
    ['start-time', 'start-time-val'],
    ['dark-thresh', 'dark-thresh-val'],
    ['red-ratio', 'red-ratio-val'],
  ];
  sliders.forEach(([id, valId]) => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(valId);
    if (!el || !valEl) return;
    el.addEventListener('input', () => { valEl.textContent = el.value; });
  });

  const analyzeBtn = document.getElementById('analyze-btn');
  if (analyzeBtn) analyzeBtn.addEventListener('click', runAnalysis);
}

async function runAnalysis() {
  if (!selectedView || analysisRunning) return;

  const v = videos[selectedView];
  if (!v || !v.ready) return;

  // Pause playback
  if (userWantsPlay) togglePlay();

  analysisRunning = true;
  const btn = document.getElementById('analyze-btn');
  btn.disabled = true;
  btn.textContent = 'Analyzing...';

  const progress = document.getElementById('analysis-progress');
  const progressFill = document.getElementById('analysis-progress-fill');
  progress.style.display = 'block';
  progressFill.style.width = '0%';

  const nFrames = Number(document.getElementById('n-frames').value);
  const startTime = Number(document.getElementById('start-time').value);
  const darkThresh = Number(document.getElementById('dark-thresh').value);
  const redRatio = Number(document.getElementById('red-ratio').value);

  const endTime = v.duration - v.offset;
  const interval = Math.max(0.1, (endTime - startTime) / nFrames);

  if (!worker) {
    worker = new Worker('./stream-table-worker.js');
  }

  const resultsEl = document.getElementById('analysis-results');
  analysisFrames = [];

  // Create extraction canvas
  const maxDim = 512;
  const vw = v.el.videoWidth;
  const vh = v.el.videoHeight;
  const aspectRatio = vw / vh;
  let aw, ah;
  if (aspectRatio >= 1) { aw = maxDim; ah = Math.round(maxDim / aspectRatio); }
  else { ah = maxDim; aw = Math.round(maxDim * aspectRatio); }

  const extractCanvas = document.createElement('canvas');
  extractCanvas.width = aw;
  extractCanvas.height = ah;
  const extractCtx = extractCanvas.getContext('2d');

  for (let i = 0; i < nFrames; i++) {
    const t = startTime + v.offset + i * interval;

    await seekAndWait(v.el, t);
    extractCtx.drawImage(v.el, 0, 0, aw, ah);
    const imageData = extractCtx.getImageData(0, 0, aw, ah);

    const result = await analyzeFrame(imageData, aw, ah, i, t - v.offset, {
      darkMax: darkThresh,
      redRatio: redRatio,
    });

    analysisFrames.push(result);
    progressFill.style.width = `${((i + 1) / nFrames * 100).toFixed(0)}%`;
  }

  renderAnalysisResults(resultsEl, analysisFrames, aw, ah);

  analysisRunning = false;
  btn.disabled = false;
  btn.textContent = 'Run Analysis';
  progress.style.display = 'none';
}

function seekAndWait(videoEl, time) {
  return new Promise(resolve => {
    if (Math.abs(videoEl.currentTime - time) < 0.05) {
      resolve();
      return;
    }
    const onSeeked = () => {
      videoEl.removeEventListener('seeked', onSeeked);
      resolve();
    };
    videoEl.addEventListener('seeked', onSeeked);
    videoEl.currentTime = time;
    // Timeout fallback in case seeked never fires
    setTimeout(() => {
      videoEl.removeEventListener('seeked', onSeeked);
      resolve();
    }, 3000);
  });
}

function analyzeFrame(imageData, w, h, frameIdx, time, params) {
  return new Promise(resolve => {
    const handler = (e) => {
      if (e.data.frameIdx === frameIdx) {
        worker.removeEventListener('message', handler);
        resolve({ ...e.data, time_s: time });
      }
    };
    worker.addEventListener('message', handler);

    worker.postMessage({
      type: 'analyze',
      pixels: imageData.data.buffer,
      w, h,
      frameIdx,
      time: time,
      params: {
        darkMax: params.darkMax || 140,
        redRatio: params.redRatio || 1.25,
        wetMax: 160,
        closeKernel: 3,
        openKernel: 3,
        minBlob: 30,
        marginPct: 5,
      },
    }, [imageData.data.buffer]);
  });
}

function renderAnalysisResults(container, frames, w, h) {
  if (frames.length === 0) {
    container.innerHTML = '<div class="results-placeholder">No frames analyzed</div>';
    return;
  }

  container.innerHTML = `
    <div class="timeline-strip" id="timeline-strip"></div>
    <canvas class="metrics-chart" id="metrics-chart"></canvas>
    <div class="analysis-canvas-row">
      <canvas id="history-canvas" width="${w}" height="${h}" style="max-height:400px"></canvas>
      <canvas id="component-canvas" width="${w}" height="${h}" style="max-height:400px"></canvas>
    </div>
  `;

  const strip = document.getElementById('timeline-strip');
  frames.forEach((f, i) => {
    if (f.thumbData) {
      const c = document.createElement('canvas');
      c.width = 80; c.height = 60;
      const ctx = c.getContext('2d');
      ctx.putImageData(new ImageData(new Uint8ClampedArray(f.thumbData), 80, 60), 0, 0);
      c.addEventListener('click', () => showFrame(i));
      strip.appendChild(c);
    }
  });

  drawMetricsChart(frames);
  buildHistory(frames, w, h);
  showFrame(frames.length - 1);
}

function showFrame(idx) {
  const f = analysisFrames[idx];
  if (!f?.compMap) return;
  const canvas = document.getElementById('component-canvas');
  if (!canvas) return;
  canvas.getContext('2d').putImageData(
    new ImageData(new Uint8ClampedArray(f.compMap), canvas.width, canvas.height), 0, 0
  );
  document.querySelectorAll('#timeline-strip canvas').forEach((c, i) => {
    c.classList.toggle('selected', i === idx);
  });
}

function buildHistory(frames, w, h) {
  const canvas = document.getElementById('history-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, w, h);

  const n = frames.length;
  frames.forEach((f, i) => {
    if (!f.binaryMask) return;
    const mask = new Uint8Array(f.binaryMask);
    const t = n > 1 ? i / (n - 1) : 0;
    const r = Math.round(40 + t * 180);
    const g = Math.round(80 + t * 40 - t * t * 80);
    const b = Math.round(180 - t * 140);
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let j = 0; j < mask.length; j++) {
      if (mask[j]) {
        const px = j * 4;
        d[px]     = Math.round(d[px] * 0.65 + r * 0.35);
        d[px + 1] = Math.round(d[px + 1] * 0.65 + g * 0.35);
        d[px + 2] = Math.round(d[px + 2] * 0.65 + b * 0.35);
      }
    }
    ctx.putImageData(imgData, 0, 0);
  });
}

function drawMetricsChart(frames) {
  const canvas = document.getElementById('metrics-chart');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  const pad = { top: 20, right: 16, bottom: 24, left: 40 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  ctx.fillStyle = '#fafafa';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#eee'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ch * (1 - i / 4);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
  }

  ctx.fillStyle = '#bbb'; ctx.font = '9px Inter, system-ui'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    ctx.fillText((i * 25) + '%', pad.left - 6, pad.top + ch * (1 - i / 4) + 3);
  }

  ctx.textAlign = 'center';
  const n = frames.length;
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 5))) {
    const x = pad.left + cw * i / Math.max(1, n - 1);
    ctx.fillText(`${(frames[i].time_s || 0).toFixed(0)}s`, x, H - 4);
  }

  [
    { key: 'channelFraction', color: '#3c78b4', label: 'Coverage' },
    { key: 'largestComponentFraction', color: '#c05030', label: 'Largest' },
  ].forEach(({ key, color, label }, si) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = pad.left + cw * i / Math.max(1, n - 1);
      const y = pad.top + ch * (1 - (frames[i][key] || 0));
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(pad.left + 8 + si * 90, 6, 12, 3);
    ctx.fillStyle = '#999'; ctx.textAlign = 'left';
    ctx.fillText(label, pad.left + 24 + si * 90, 11);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════════════════════════

init();
