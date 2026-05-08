/**
 * stream-table-tab.js — Browser-based stream table channel formation analysis.
 *
 * Left column: 320px sidebar — video preview, frame sampling, calibration, actions, export.
 * Right column: channel timeline thumbnails, metrics chart, component map.
 * Analysis runs in stream-table-worker.js off the main thread.
 */

const ANALYSIS_MAX_W = 512; // max analysis resolution on the long side
let ANALYSIS_W = 512, ANALYSIS_H = 384; // updated on video load to match aspect ratio

// ── Module state ──────────────────────────────────────────────────────────
let _inited = false;
let _worker = null;

// Video
let _videoEl = null;
let _videoURL = null;
let _videoDuration = 0;
let _videoW = 0, _videoH = 0;

// Canvases
let _previewCanvas = null, _previewCtx = null;
let _compCanvas = null, _compCtx = null;
let _chartCanvas = null, _chartCtx = null;

// Sampling
let _frameCount = 50;
let _trimStart = 0;
let _trimEnd = 0;

// Analysis
let _analyzing = false;
let _frameQueue = [];
let _results = [];
let _thumbs = [];
let _selectedFrame = -1;
let _showMask = false;

// Temporal accumulation
let _historyCanvas = null, _historyCtx = null;
let _showHistory = true; // true = history view, false = component map

// Offscreen canvas for frame extraction
let _extractCanvas = null, _extractCtx = null;

// ── Public API ────────────────────────────────────────────────────────────

export function initStreamTableTab(containerId) {
  if (_inited) return;
  _inited = true;
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = buildHTML();
  injectStyles();
  wireEvents();
  _worker = new Worker('./stream-table-worker.js');
  _worker.onmessage = onWorkerMessage;
}

export function onStreamTableActivated() {
  resizeChart();
}

// ═══════════════════════════════════════════════════════════════════════════
// HTML
// ═══════════════════════════════════════════════════════════════════════════
function buildHTML() {
  return `<div id="st-layout">
  <!-- ═══ LEFT SIDEBAR ═══ -->
  <div id="st-left">
    <!-- 1. Video drop zone -->
    <div id="st-upload-zone">
      <div id="st-upload-label">Drop video here or click to browse</div>
      <div id="st-upload-sub">.mov .mp4 .webm</div>
      <input type="file" id="st-file-input" accept=".mov,.mp4,.webm,video/*" hidden>
    </div>

    <!-- Workspace (hidden until video loaded) -->
    <div id="st-workspace" style="display:none">
      <!-- 1. Preview -->
      <canvas id="st-preview-canvas"></canvas>
      <video id="st-video" style="display:none" muted></video>
      <div id="st-video-meta"></div>

      <!-- 2. Frame sampling -->
      <div class="st-section">
        <div class="st-section-head">Frame sampling</div>
        <div class="st-field">
          <div class="st-field-label">Frames to analyze</div>
          <div class="st-field-row"><input type="range" id="st-frame-count" min="10" max="200" value="50"><span class="st-field-val" id="st-frame-count-val">50</span></div>
        </div>
        <div class="st-field">
          <div class="st-field-label">Start (s)</div>
          <div class="st-field-row"><input type="range" id="st-trim-start" min="0" max="1" step="0.1" value="0"><span class="st-field-val" id="st-trim-start-val">0.0</span></div>
        </div>
        <div class="st-field">
          <div class="st-field-label">End (s)</div>
          <div class="st-field-row"><input type="range" id="st-trim-end" min="0" max="1" step="0.1" value="1"><span class="st-field-val" id="st-trim-end-val">&mdash;</span></div>
        </div>
        <div id="st-interval-label"></div>
      </div>

      <!-- 3. Calibration (always visible) -->
      <div class="st-section">
        <div class="st-section-head">Calibration</div>
        <div class="st-field">
          <div class="st-field-label">Dark channel sensitivity</div>
          <div class="st-field-row"><input type="range" id="st-cal-dark" min="100" max="180" value="140"><span class="st-field-val" id="st-cal-dark-val">140</span></div>
        </div>
        <div class="st-field">
          <div class="st-field-label">Red channel sensitivity</div>
          <div class="st-field-row"><input type="range" id="st-cal-red" min="1.1" max="1.8" step="0.05" value="1.25"><span class="st-field-val" id="st-cal-red-val">1.25</span></div>
        </div>
        <div class="st-field">
          <div class="st-field-label">Wet particle sensitivity</div>
          <div class="st-field-row"><input type="range" id="st-cal-wet" min="120" max="200" value="160"><span class="st-field-val" id="st-cal-wet-val">160</span></div>
        </div>
        <button id="st-preview-mask-btn">Preview mask</button>
      </div>

      <!-- 4. Actions -->
      <div class="st-section">
        <button id="st-analyze-btn">Analyze</button>
        <button id="st-mask-toggle-btn">Show mask</button>
        <div id="st-progress-wrap" style="display:none">
          <div id="st-progress-text">0 / 0 frames</div>
          <div id="st-progress-bar"><div id="st-progress-fill"></div></div>
        </div>
      </div>

      <!-- 5. Export (shown after analysis) -->
      <div id="st-export-section" style="display:none">
        <div class="st-export-row">
          <button id="st-export-csv">Export CSV</button>
          <button id="st-export-json">Export for Mosaic tab</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ═══ RIGHT COLUMN ═══ -->
  <div id="st-right">
    <!-- Top row: thumbnail strip + chart -->
    <div id="st-top-row">
      <div id="st-timeline-section">
        <div id="st-timeline-strip"></div>
      </div>
      <div id="st-chart-section">
        <div id="st-chart-wrap"><canvas id="st-chart-canvas"></canvas></div>
      </div>
    </div>

    <!-- Bottom row: viz + cards side by side -->
    <div id="st-bottom-row">
      <div id="st-bottom-viz">
        <button id="st-viz-toggle-btn">Show current</button>
        <canvas id="st-comp-canvas" style="display:none"></canvas>
        <canvas id="st-history-canvas"></canvas>
        <div id="st-history-legend">
          <span style="color:rgb(30,60,180)">early</span>
          <span class="st-ramp-bar"></span>
          <span style="color:rgb(230,80,40)">recent</span>
        </div>
      </div>
      <div id="st-cards">
        <div class="st-card"><div class="st-card-label">Channel coverage</div><div class="st-card-value" id="st-card-coverage">&mdash;</div></div>
        <div class="st-card"><div class="st-card-label">Largest channel</div><div class="st-card-value" id="st-card-largest">&mdash;</div></div>
        <div class="st-card"><div class="st-card-label">Channel blobs</div><div class="st-card-value" id="st-card-blobs">&mdash;</div></div>
        <div class="st-card"><div class="st-card-label">Spanning</div><div class="st-card-value" id="st-card-spanning">&mdash;</div></div>
      </div>
    </div>
  </div>
</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Styles
// ═══════════════════════════════════════════════════════════════════════════
function injectStyles() {
  if (document.getElementById('st-tab-styles')) return;
  const s = document.createElement('style');
  s.id = 'st-tab-styles';
  s.textContent = `
#st-layout { display:flex; flex-direction:row; width:100%; height:calc(100vh - 36px); overflow:hidden; font-family:system-ui,-apple-system,sans-serif; color:#c8c8d8; background:#0d0d14; }

/* ── Left sidebar ── */
#st-left { flex:0 0 320px; flex-shrink:0; display:flex; flex-direction:column; border-right:1px solid rgba(255,255,255,0.06); overflow-y:auto; padding:14px; gap:0; }
#st-workspace { display:flex; flex-direction:column; gap:0; }

/* Upload zone */
#st-upload-zone { min-height:180px; border:2px dashed rgba(255,255,255,0.15); border-radius:8px; padding:40px 16px; text-align:center; cursor:pointer; display:flex; flex-direction:column; align-items:center; justify-content:center; transition:border-color .2s,background .2s; }
#st-upload-zone:hover,#st-upload-zone.dragover { border-color:rgba(80,200,180,0.5); background:rgba(80,200,180,0.04); }
#st-upload-label { font-size:13px; color:#aaa; }
#st-upload-sub { font-size:10px; color:#555; margin-top:6px; }

/* Preview */
#st-preview-canvas { width:100%; background:#000; border-radius:5px; display:block; }
#st-video-meta { font-size:10px; color:#555; margin:3px 0 10px; }

/* Sections */
.st-section { padding:10px 0; border-top:1px solid rgba(255,255,255,0.05); }
.st-section-head { font-size:10px; color:#777; text-transform:uppercase; letter-spacing:.05em; margin-bottom:8px; }

/* Slider fields — label on own line, slider + value on next line */
.st-field { margin-bottom:8px; }
.st-field-label { font-size:10px; color:#888; margin-bottom:3px; }
.st-field-row { display:flex; align-items:center; gap:8px; }
.st-field-row input[type="range"] { flex:1; }
.st-field-val { font-size:10px; color:#aaa; min-width:32px; text-align:right; font-variant-numeric:tabular-nums; }
#st-interval-label { font-size:10px; color:#555; margin-top:2px; }

/* Buttons */
#st-analyze-btn { width:100%; padding:9px 0; border-radius:5px; border:1px solid rgba(80,200,180,0.4); background:rgba(80,200,180,0.12); color:#50c8b4; font-size:12px; font-weight:600; font-family:inherit; cursor:pointer; margin-bottom:6px; }
#st-analyze-btn:hover { background:rgba(80,200,180,0.22); }
#st-analyze-btn:disabled { opacity:.4; cursor:default; }
#st-mask-toggle-btn { width:100%; padding:7px 0; border-radius:4px; border:1px solid rgba(255,255,255,0.1); background:transparent; color:#888; font-size:11px; font-family:inherit; cursor:pointer; transition:all .15s; }
#st-mask-toggle-btn.active { background:rgba(80,200,180,0.1); border-color:rgba(80,200,180,0.3); color:#50c8b4; }
#st-preview-mask-btn { width:100%; padding:6px 0; border-radius:4px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.03); color:#999; font-size:11px; font-family:inherit; cursor:pointer; }
#st-preview-mask-btn:hover { background:rgba(255,255,255,0.07); color:#ccc; }

/* Progress */
#st-progress-wrap { margin-top:8px; }
#st-progress-text { font-size:10px; color:#888; margin-bottom:4px; font-variant-numeric:tabular-nums; }
#st-progress-bar { height:5px; background:rgba(255,255,255,0.07); border-radius:3px; overflow:hidden; }
#st-progress-fill { height:100%; width:0%; background:#50c8b4; transition:width .3s; }

/* Export */
#st-export-section { padding:10px 0; border-top:1px solid rgba(255,255,255,0.05); }
.st-export-row { display:flex; gap:6px; }
.st-export-row button { flex:1; padding:7px 0; border-radius:4px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.03); color:#999; font-size:10px; font-family:inherit; cursor:pointer; }
.st-export-row button:hover { background:rgba(255,255,255,0.07); color:#ccc; }

/* ── Right column ── */
#st-right { flex:1; min-width:0; display:flex; flex-direction:column; padding:10px; gap:0; overflow:hidden; }

/* Top row: thumbnails + chart, fixed height */
#st-top-row { flex:0 0 260px; display:flex; flex-direction:column; min-height:0; }
#st-timeline-section { flex:0 0 auto; }
#st-timeline-strip { display:flex; gap:3px; overflow-x:auto; padding:4px 0; height:72px; }
#st-timeline-strip canvas { border-radius:3px; cursor:pointer; border:2px solid transparent; flex-shrink:0; }
#st-timeline-strip canvas.selected { border-color:#f0643c; }
#st-chart-section { flex:1; min-height:0; display:flex; flex-direction:column; }
#st-chart-wrap { flex:1; min-height:0; }
#st-chart-canvas { width:100%; height:100%; display:block; }

/* Bottom row: viz + cards side by side, fills remaining height */
#st-bottom-row { flex:1; min-height:0; display:flex; flex-direction:row; gap:10px; margin-top:10px; }

/* Viz panel (left of bottom row) */
#st-bottom-viz { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; position:relative; }
#st-viz-toggle-btn { position:absolute; top:4px; right:4px; z-index:2; padding:3px 10px; border-radius:3px; border:1px solid rgba(255,255,255,0.1); background:rgba(15,15,20,0.8); color:#888; font-size:10px; font-family:inherit; cursor:pointer; }
#st-viz-toggle-btn:hover { background:rgba(255,255,255,0.08); color:#ccc; }
#st-comp-canvas, #st-history-canvas { width:100%; height:100%; object-fit:contain; border-radius:4px; display:block; min-height:0; }
#st-history-legend { flex:0 0 auto; display:flex; align-items:center; gap:6px; margin-top:3px; font-size:9px; }
.st-ramp-bar { flex:1; height:4px; border-radius:2px; background:linear-gradient(to right, rgb(30,60,180), rgb(30,160,140), rgb(220,160,30), rgb(230,80,40)); }

/* Cards column (right of bottom row) */
#st-cards { flex:0 0 220px; display:flex; flex-direction:column; gap:8px; }
.st-card { flex:1; padding:10px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); border-radius:6px; text-align:center; display:flex; flex-direction:column; justify-content:center; }
.st-card-label { font-size:10px; color:#888; text-transform:uppercase; letter-spacing:.04em; }
.st-card-value { font-size:20px; font-weight:700; color:#e8e8f0; margin-top:3px; font-variant-numeric:tabular-nums; }

/* Range inputs */
#st-layout input[type="range"] { -webkit-appearance:none; appearance:none; height:4px; background:rgba(255,255,255,0.1); border-radius:2px; outline:none; }
#st-layout input[type="range"]::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:12px; height:12px; border-radius:50%; background:#ccc; cursor:pointer; border:2px solid #444; }
#st-layout ::-webkit-scrollbar { width:4px; height:4px; }
#st-layout ::-webkit-scrollbar-track { background:transparent; }
#st-layout ::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.12); border-radius:2px; }
  `;
  document.head.appendChild(s);
}

// ═══════════════════════════════════════════════════════════════════════════
// Events
// ═══════════════════════════════════════════════════════════════════════════
function wireEvents() {
  const zone = document.getElementById('st-upload-zone');
  const fileInput = document.getElementById('st-file-input');
  zone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadVideo(fileInput.files[0]); });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('dragover'); if (e.dataTransfer.files[0]) loadVideo(e.dataTransfer.files[0]); });

  const fcSlider = document.getElementById('st-frame-count');
  fcSlider.addEventListener('input', () => { _frameCount = parseInt(fcSlider.value); document.getElementById('st-frame-count-val').textContent = _frameCount; updateIntervalLabel(); });
  const tsSlider = document.getElementById('st-trim-start');
  tsSlider.addEventListener('input', () => { _trimStart = parseFloat(tsSlider.value); document.getElementById('st-trim-start-val').textContent = _trimStart.toFixed(1); updateIntervalLabel(); });
  const teSlider = document.getElementById('st-trim-end');
  teSlider.addEventListener('input', () => { _trimEnd = parseFloat(teSlider.value); document.getElementById('st-trim-end-val').textContent = _trimEnd.toFixed(1); updateIntervalLabel(); });

  document.getElementById('st-analyze-btn').addEventListener('click', startAnalysis);
  document.getElementById('st-mask-toggle-btn').addEventListener('click', () => {
    _showMask = !_showMask;
    document.getElementById('st-mask-toggle-btn').classList.toggle('active', _showMask);
    document.getElementById('st-mask-toggle-btn').textContent = _showMask ? 'Showing mask' : 'Show mask';
  });
  document.getElementById('st-preview-mask-btn').addEventListener('click', previewMask);

  for (const [id, valId] of [['st-cal-dark','st-cal-dark-val'],['st-cal-red','st-cal-red-val'],['st-cal-wet','st-cal-wet-val']]) {
    const sl = document.getElementById(id);
    sl.addEventListener('input', () => { document.getElementById(valId).textContent = sl.value; });
  }

  // History / current toggle
  document.getElementById('st-viz-toggle-btn').addEventListener('click', () => {
    _showHistory = !_showHistory;
    document.getElementById('st-viz-toggle-btn').textContent = _showHistory ? 'Show current' : 'Show history';
    document.getElementById('st-history-canvas').style.display = _showHistory ? 'block' : 'none';
    document.getElementById('st-comp-canvas').style.display = _showHistory ? 'none' : 'block';
    document.getElementById('st-history-legend').style.display = _showHistory ? 'flex' : 'none';
  });

  document.getElementById('st-export-csv').addEventListener('click', exportCSV);
  document.getElementById('st-export-json').addEventListener('click', exportJSON);
  window.addEventListener('resize', resizeChart);

  // ResizeObserver for chart canvas — redraws when flex layout settles
  const chartWrap = document.getElementById('st-chart-wrap');
  if (chartWrap && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => resizeChart()).observe(chartWrap);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Video loading
// ═══════════════════════════════════════════════════════════════════════════
function loadVideo(file) {
  if (_videoURL) URL.revokeObjectURL(_videoURL);

  // Read entire file into memory — Blob URLs support seeking without HTTP range requests
  const reader = new FileReader();
  reader.onload = (e) => {
    const arrayBuffer = e.target.result;

    // Try multiple MIME types: the browser may accept one but not others
    // .mov from iPhone can be H.264 (plays as video/mp4) or HEVC (needs video/quicktime or won't play)
    const isMov = file.name.toLowerCase().endsWith('.mov');
    const typesToTry = isMov
      ? ['video/mp4', 'video/quicktime']
      : [file.type || 'video/mp4'];

    tryLoadWithTypes(arrayBuffer, typesToTry, 0);
  };
  reader.readAsArrayBuffer(file);
}

function tryLoadWithTypes(arrayBuffer, types, index) {
  if (index >= types.length) {
    // All types failed
    document.getElementById('st-upload-zone').style.display = 'none';
    document.getElementById('st-workspace').style.display = 'flex';
    const meta = document.getElementById('st-video-meta');
    meta.style.color = '#e55';
    meta.innerHTML =
      'Could not play this video &mdash; the codec is likely unsupported by your browser (e.g. HEVC/H.265).<br>' +
      '<span style="color:#999;font-size:9px">Convert with: <code style="background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:3px">ffmpeg -i input.mov -c:v libx264 -crf 23 output.mp4</code></span>';
    return;
  }

  const blob = new Blob([arrayBuffer.slice(0)], { type: types[index] });
  const url = URL.createObjectURL(blob);

  const video = document.getElementById('st-video');

  // Clean up any previous listeners
  const onError = () => {
    console.warn(`Video failed with type "${types[index]}", trying next...`);
    video.removeEventListener('error', onError);
    video.removeEventListener('loadedmetadata', onMeta);
    URL.revokeObjectURL(url);
    tryLoadWithTypes(arrayBuffer, types, index + 1);
  };
  const onMeta = () => {
    video.removeEventListener('error', onError);
    video.removeEventListener('loadedmetadata', onMeta);
    // Success — proceed with this URL
    _videoURL = url;
    _videoEl = video;

    document.getElementById('st-upload-zone').style.display = 'none';
    document.getElementById('st-workspace').style.display = 'flex';

    _previewCanvas = document.getElementById('st-preview-canvas');
    _previewCtx = _previewCanvas.getContext('2d');
    _compCanvas = document.getElementById('st-comp-canvas');
    _compCtx = _compCanvas.getContext('2d');
    _historyCanvas = document.getElementById('st-history-canvas');
    _historyCtx = _historyCanvas.getContext('2d');
    _extractCanvas = document.createElement('canvas');

    onVideoReady();
  };

  video.addEventListener('error', onError);
  video.addEventListener('loadedmetadata', onMeta);
  video.src = url;
  video.load();
}

function onVideoReady() {
  _videoW = _videoEl.videoWidth;
  _videoH = _videoEl.videoHeight;
  _videoDuration = _videoEl.duration;

  // Set analysis resolution to match video aspect ratio, capped at ANALYSIS_MAX_W
  const aspect = _videoW / _videoH;
  if (aspect >= 1) {
    ANALYSIS_W = ANALYSIS_MAX_W;
    ANALYSIS_H = Math.round(ANALYSIS_MAX_W / aspect);
  } else {
    ANALYSIS_H = ANALYSIS_MAX_W;
    ANALYSIS_W = Math.round(ANALYSIS_MAX_W * aspect);
  }
  // Ensure even dimensions
  ANALYSIS_W = ANALYSIS_W & ~1;
  ANALYSIS_H = ANALYSIS_H & ~1;

  _extractCanvas.width = ANALYSIS_W;
  _extractCanvas.height = ANALYSIS_H;
  _extractCtx = _extractCanvas.getContext('2d');

  // Preview fits the 320px sidebar width
  _previewCanvas.width = 320;
  _previewCanvas.height = Math.round(320 / aspect);

  // Size the right-column canvases to match analysis aspect ratio
  _compCanvas.width = ANALYSIS_W;
  _compCanvas.height = ANALYSIS_H;
  _historyCanvas.width = ANALYSIS_W;
  _historyCanvas.height = ANALYSIS_H;

  document.getElementById('st-video-meta').textContent =
    `${_videoW}\u00D7${_videoH} \u00B7 ${_videoDuration.toFixed(1)}s`;

  const teSlider = document.getElementById('st-trim-end');
  teSlider.max = _videoDuration;
  teSlider.value = _videoDuration;
  _trimEnd = _videoDuration;
  document.getElementById('st-trim-end-val').textContent = _videoDuration.toFixed(1);
  document.getElementById('st-trim-start').max = _videoDuration;

  seekAndDraw(0);
  updateIntervalLabel();
  resizeChart();
}

async function seekTo(t) {
  _videoEl.currentTime = t;
  await new Promise(r => _videoEl.addEventListener('seeked', r, { once: true }));
}

async function seekAndDraw(t) {
  await seekTo(t);
  _previewCtx.drawImage(_videoEl, 0, 0, _previewCanvas.width, _previewCanvas.height);
}

// ═══════════════════════════════════════════════════════════════════════════
// Sampling
// ═══════════════════════════════════════════════════════════════════════════
function updateIntervalLabel() {
  const span = _trimEnd - _trimStart;
  if (span <= 0 || _frameCount <= 0) return;
  const interval = span / _frameCount;
  document.getElementById('st-interval-label').textContent =
    `1 frame every ${interval.toFixed(1)}s across ${span.toFixed(1)}s`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Analysis
// ═══════════════════════════════════════════════════════════════════════════
function getParams() {
  return {
    darkMax: parseInt(document.getElementById('st-cal-dark').value),
    redRatioG: parseFloat(document.getElementById('st-cal-red').value),
    redRatioB: parseFloat(document.getElementById('st-cal-red').value),
    wetVMax: parseInt(document.getElementById('st-cal-wet').value),
    margin: 0.05,
    minBlob: MIN_BLOB_PX_DEFAULT,
  };
}
const MIN_BLOB_PX_DEFAULT = 30;

async function startAnalysis() {
  if (_analyzing || !_videoEl) return;
  _analyzing = true;
  document.getElementById('st-analyze-btn').disabled = true;
  document.getElementById('st-analyze-btn').textContent = 'Analyzing\u2026';

  _results = [];
  _thumbs = [];
  _selectedFrame = -1;
  document.getElementById('st-timeline-strip').innerHTML = '';
  resetHistory();
  document.getElementById('st-progress-wrap').style.display = '';
  document.getElementById('st-export-section').style.display = 'none';

  const span = _trimEnd - _trimStart;
  _frameQueue = [];
  for (let i = 0; i < _frameCount; i++) {
    const t = _trimStart + (i / Math.max(1, _frameCount - 1)) * span;
    _frameQueue.push({ frameIndex: i, timeS: t });
  }

  sendNextFrame();
}

async function sendNextFrame() {
  if (_frameQueue.length === 0) { onAnalysisComplete(); return; }
  const { frameIndex, timeS } = _frameQueue.shift();

  await seekTo(timeS);
  _extractCtx.drawImage(_videoEl, 0, 0, ANALYSIS_W, ANALYSIS_H);
  const imageData = _extractCtx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);

  if (!_showMask) {
    _previewCtx.drawImage(_videoEl, 0, 0, _previewCanvas.width, _previewCanvas.height);
  }

  _worker.postMessage({
    type: 'analyze',
    imageData: imageData.data,
    width: ANALYSIS_W,
    height: ANALYSIS_H,
    frameIndex,
    timeS,
    params: getParams(),
  }, [imageData.data.buffer]);
}

function onWorkerMessage(e) {
  const msg = e.data;

  if (msg.type === 'result') {
    const r = {
      frameIndex: msg.frameIndex,
      timeS: msg.timeS,
      channelFraction: msg.channelFraction,
      largestComponentFraction: msg.largestComponentFraction,
      nComponents: msg.nComponents,
      spanning: msg.spanning,
      compMap: msg.compMap,
    };
    _results.push(r);
    _results.sort((a, b) => a.frameIndex - b.frameIndex);

    // Update temporal accumulation
    if (msg.binaryMask) {
      updateHistoryAccumulation(new Uint8Array(msg.binaryMask), msg.frameIndex);
    }

    addThumb(msg.thumbData, msg.frameIndex, msg.timeS);

    if (_showMask && msg.compMap) {
      const tmpC = document.createElement('canvas');
      tmpC.width = ANALYSIS_W; tmpC.height = ANALYSIS_H;
      tmpC.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(msg.compMap), ANALYSIS_W, ANALYSIS_H), 0, 0);
      _previewCtx.drawImage(tmpC, 0, 0, _previewCanvas.width, _previewCanvas.height);
    }

    updateCards(r);
    updateProgress();
    renderChart();
    selectFrame(msg.frameIndex);
    sendNextFrame();
  }

  if (msg.type === 'preview-result') {
    const img = new ImageData(new Uint8ClampedArray(msg.compMap), ANALYSIS_W, ANALYSIS_H);
    const tmpC = document.createElement('canvas');
    tmpC.width = ANALYSIS_W; tmpC.height = ANALYSIS_H;
    tmpC.getContext('2d').putImageData(img, 0, 0);
    _previewCtx.drawImage(tmpC, 0, 0, _previewCanvas.width, _previewCanvas.height);
    _compCtx.putImageData(img, 0, 0);
    // Update cards with preview result
    updateCards(msg);
  }
}

function onAnalysisComplete() {
  _analyzing = false;
  document.getElementById('st-analyze-btn').disabled = false;
  document.getElementById('st-analyze-btn').textContent = 'Analyze';
  document.getElementById('st-progress-wrap').style.display = 'none';
  document.getElementById('st-export-section').style.display = '';

  // Default to history view after analysis
  _showHistory = true;
  document.getElementById('st-viz-toggle-btn').textContent = 'Show current';
  document.getElementById('st-history-canvas').style.display = 'block';
  document.getElementById('st-comp-canvas').style.display = 'none';
  document.getElementById('st-history-legend').style.display = 'flex';
}

function updateProgress() {
  const done = _results.length;
  const pct = _frameCount > 0 ? (done / _frameCount * 100) : 0;
  document.getElementById('st-progress-fill').style.width = pct + '%';
  document.getElementById('st-progress-text').textContent = `${done} / ${_frameCount} frames`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Time ramp color (cool → warm)
// ═══════════════════════════════════════════════════════════════════════════
// 4-stop ramp: deep blue → teal → amber → coral
const TIME_RAMP = [
  { t: 0.0, r: 30, g: 60, b: 180 },
  { t: 0.33, r: 30, g: 160, b: 140 },
  { t: 0.66, r: 220, g: 160, b: 30 },
  { t: 1.0, r: 230, g: 80, b: 40 },
];

function timeRampColor(fraction) {
  const t = Math.max(0, Math.min(1, fraction));
  let i = 0;
  while (i < TIME_RAMP.length - 2 && TIME_RAMP[i + 1].t < t) i++;
  const a = TIME_RAMP[i], b = TIME_RAMP[i + 1];
  const f = (t - a.t) / (b.t - a.t || 1);
  return {
    r: Math.round(a.r + (b.r - a.r) * f),
    g: Math.round(a.g + (b.g - a.g) * f),
    b: Math.round(a.b + (b.b - a.b) * f),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Temporal accumulation
// ═══════════════════════════════════════════════════════════════════════════
function updateHistoryAccumulation(binaryMask, frameIndex) {
  if (!_historyCtx) return;
  const total = _frameCount;
  const frac = total > 1 ? frameIndex / (total - 1) : 0;
  const c = timeRampColor(frac);

  // Paint channel pixels with time-ramp color at low opacity
  const imgData = _historyCtx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);
  const d = imgData.data;
  const alpha = 0.35;
  const n = ANALYSIS_W * ANALYSIS_H;
  for (let i = 0; i < n; i++) {
    if (!binaryMask[i]) continue;
    const off = i * 4;
    // Alpha-blend over existing pixel
    d[off]     = Math.round(d[off]     * (1 - alpha) + c.r * alpha);
    d[off + 1] = Math.round(d[off + 1] * (1 - alpha) + c.g * alpha);
    d[off + 2] = Math.round(d[off + 2] * (1 - alpha) + c.b * alpha);
  }
  _historyCtx.putImageData(imgData, 0, 0);
}

function resetHistory() {
  if (!_historyCtx) return;
  // Fill with dark background
  _historyCtx.fillStyle = 'rgb(30,30,35)';
  _historyCtx.fillRect(0, 0, ANALYSIS_W, ANALYSIS_H);
}

// ═══════════════════════════════════════════════════════════════════════════
// Calibration preview
// ═══════════════════════════════════════════════════════════════════════════
async function previewMask() {
  if (!_videoEl || !_extractCtx) return;
  _extractCtx.drawImage(_videoEl, 0, 0, ANALYSIS_W, ANALYSIS_H);
  const imageData = _extractCtx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);

  _worker.postMessage({
    type: 'preview',
    imageData: imageData.data,
    width: ANALYSIS_W,
    height: ANALYSIS_H,
    params: getParams(),
  }, [imageData.data.buffer]);
}

// ═══════════════════════════════════════════════════════════════════════════
// Timeline thumbnails
// ═══════════════════════════════════════════════════════════════════════════
function addThumb(thumbData, frameIndex, timeS) {
  const strip = document.getElementById('st-timeline-strip');
  const c = document.createElement('canvas');
  c.width = 80; c.height = 60;
  c.title = `t=${timeS.toFixed(1)}s`;
  c.dataset.frame = frameIndex;
  const ctx = c.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(thumbData), 80, 60), 0, 0);

  // Tint with time-ramp color at low opacity
  const frac = _frameCount > 1 ? frameIndex / (_frameCount - 1) : 0;
  const tc = timeRampColor(frac);
  ctx.fillStyle = `rgba(${tc.r},${tc.g},${tc.b},0.15)`;
  ctx.fillRect(0, 0, 80, 60);

  c.addEventListener('click', () => selectFrame(frameIndex));
  strip.appendChild(c);
  _thumbs.push({ canvas: c, frameIndex, timeS });
}

function selectFrame(frameIndex) {
  _selectedFrame = frameIndex;
  for (const t of _thumbs) t.canvas.classList.toggle('selected', t.frameIndex === frameIndex);
  const r = _results.find(r => r.frameIndex === frameIndex);
  if (r) {
    if (r.compMap) {
      _compCtx.putImageData(new ImageData(new Uint8ClampedArray(r.compMap), ANALYSIS_W, ANALYSIS_H), 0, 0);
    }
    updateCards(r);
    // Switch to component map view when user clicks a specific frame
    if (!_analyzing) {
      _showHistory = false;
      document.getElementById('st-viz-toggle-btn').textContent = 'Show history';
      document.getElementById('st-history-canvas').style.display = 'none';
      document.getElementById('st-comp-canvas').style.display = 'block';
      document.getElementById('st-history-legend').style.display = 'none';
    }
  }
  renderChart();
}

// ═══════════════════════════════════════════════════════════════════════════
// Cards
// ═══════════════════════════════════════════════════════════════════════════
function updateCards(r) {
  document.getElementById('st-card-coverage').textContent = (r.channelFraction * 100).toFixed(1) + '%';
  document.getElementById('st-card-largest').textContent = (r.largestComponentFraction * 100).toFixed(1) + '%';
  document.getElementById('st-card-blobs').textContent = r.nComponents;
  const sp = document.getElementById('st-card-spanning');
  if (r.spanning) { sp.textContent = 'YES'; sp.style.color = '#f0643c'; }
  else { sp.textContent = 'NO'; sp.style.color = '#666'; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Channel metrics chart (unchanged)
// ═══════════════════════════════════════════════════════════════════════════
function resizeChart() {
  _chartCanvas = document.getElementById('st-chart-canvas');
  if (!_chartCanvas) return;
  const wrap = document.getElementById('st-chart-wrap');
  if (!wrap) return;
  _chartCanvas.width = wrap.clientWidth;
  _chartCanvas.height = wrap.clientHeight;
  _chartCtx = _chartCanvas.getContext('2d');
  renderChart();
}

function renderChart() {
  if (!_chartCanvas || !_chartCtx) return;
  const ctx = _chartCtx;
  const w = _chartCanvas.width, h = _chartCanvas.height;
  if (w === 0 || h === 0) return;
  ctx.clearRect(0, 0, w, h);
  if (_results.length === 0) return;

  const pad = { top: 14, right: 45, bottom: 24, left: 36 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  if (plotW <= 0 || plotH <= 0) return;

  const tMin = _results[0].timeS;
  const tMax = _results[_results.length - 1].timeS;
  const tRange = tMax - tMin || 1;

  let maxN = 1;
  for (const r of _results) if (r.nComponents > maxN) maxN = r.nComponents;

  ctx.strokeStyle = '#555'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + plotH); ctx.lineTo(pad.left + plotW, pad.top + plotH);
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pad.left + plotW, pad.top); ctx.lineTo(pad.left + plotW, pad.top + plotH); ctx.stroke();

  ctx.fillStyle = '#888'; ctx.font = '9px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('time (s)', pad.left + plotW / 2, h - 2);
  ctx.textAlign = 'left'; ctx.fillStyle = '#6688bb'; ctx.fillText('frac', 2, pad.top + 4);
  ctx.textAlign = 'right'; ctx.fillStyle = '#6a9'; ctx.fillText('n', w - 2, pad.top + 4);

  ctx.fillStyle = '#666'; ctx.textAlign = 'center'; ctx.font = '8px system-ui';
  for (let i = 0; i <= 4; i++) {
    const t = tMin + (i / 4) * tRange;
    ctx.fillText(t.toFixed(0) + 's', pad.left + (i / 4) * plotW, pad.top + plotH + 14);
  }

  function plotLine(key, color, maxVal) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let i = 0; i < _results.length; i++) {
      const r = _results[i];
      const x = pad.left + ((r.timeS - tMin) / tRange) * plotW;
      const y = pad.top + plotH - (r[key] / maxVal) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  plotLine('channelFraction', 'rgba(100,140,200,0.8)', 1);
  plotLine('largestComponentFraction', 'rgba(240,100,60,0.8)', 1);
  plotLine('nComponents', 'rgba(100,170,140,0.6)', maxN);

  if (_selectedFrame >= 0) {
    const r = _results.find(r => r.frameIndex === _selectedFrame);
    if (r) {
      const x = pad.left + ((r.timeS - tMin) / tRange) * plotW;
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  ctx.font = '8px system-ui'; ctx.textAlign = 'left';
  const ly = pad.top + plotH + 18;
  for (const [label, color, lx] of [['coverage','#6488c8',pad.left],['largest','#f0643c',pad.left+60],['blobs','#6a9',pad.left+115]]) {
    ctx.fillStyle = color; ctx.fillRect(lx, ly, 8, 3); ctx.fillText(label, lx + 10, ly + 3);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Export (unchanged)
// ═══════════════════════════════════════════════════════════════════════════
function exportCSV() {
  if (_results.length === 0) return;
  const header = 'frame,time_s,channel_fraction,largest_component_fraction,n_components,spanning';
  let csv = header + '\n';
  for (const r of _results)
    csv += `${r.frameIndex},${r.timeS.toFixed(2)},${r.channelFraction.toFixed(6)},${r.largestComponentFraction.toFixed(6)},${r.nComponents},${r.spanning ? 1 : 0}\n`;
  dl(csv, 'stream_table_output.csv', 'text/csv');
}

function exportJSON() {
  if (_results.length === 0) return;
  const pts = [];
  let lastPhi = null, phiStar = null, spanTime = null, spanFrame = null;
  for (const r of _results) {
    if (lastPhi === null || Math.abs(r.channelFraction - lastPhi) >= 0.01) {
      pts.push({ phi: parseFloat(r.channelFraction.toFixed(4)), spreadExtent: parseFloat(r.largestComponentFraction.toFixed(4)) });
      lastPhi = r.channelFraction;
    }
    if (r.spanning && phiStar === null) { phiStar = r.channelFraction; spanTime = r.timeS; spanFrame = r.frameIndex; }
  }
  dl(JSON.stringify({
    empiricalPoints: pts,
    phiStar: phiStar != null ? parseFloat(phiStar.toFixed(4)) : null,
    spanningFrame: spanFrame, spanningTime: spanTime != null ? parseFloat(spanTime.toFixed(1)) : null,
    source: 'stream_table',
  }, null, 2), 'stream_table_scurve.json', 'application/json');
}

function dl(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
