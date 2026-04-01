/**
 * FireSweep-style percolation lab (standalone tab).
 * 8-neighbor site dynamics; p_c ≈ 0.41 on the square lattice.
 * States: EMPTY · TREE · BURNING · BURNED
 */

const COLS = 72;
const ROWS = 72;

const S = { EMPTY: 0, TREE: 1, BURNING: 2, BURNED: 3 };

const D8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

let _inited = false;
let _p5Inst = null;

/** Pause stepping when user leaves tab */
let _running = false;
let _tickAccum = 0;

export function pauseFireSweep() {
  _running = false;
}

export function initFireSweepTab(containerId) {
  if (_inited) return;
  _inited = true;

  const root = document.getElementById(containerId);
  if (!root) return;

  root.innerHTML = `
    <div id="fs-layout" style="position:absolute;inset:0;display:flex;background:#0a0a0f;color:#e0e0e0;font-family:system-ui,sans-serif;font-size:13px;">
      <aside id="fs-side" style="width:260px;min-width:260px;padding:14px 16px;border-right:1px solid rgba(255,255,255,0.08);overflow-y:auto;background:rgba(14,14,20,0.98);">
        <div style="font-weight:700;color:#ff8c42;margin-bottom:4px">FireSweep</div>
        <p style="font-size:11px;color:#888;line-height:1.45;margin:0 0 14px">
          Forest cells burn and spread to tree neighbors with probability <strong>p</strong> each tick.
          Near the 8-neighbor percolation threshold <strong>p<sub>c</sub> ≈ 0.41</strong>: below it fires usually die out; above, they can sweep the grid.
        </p>
        <label style="display:block;margin-top:10px;font-size:12px">
          Spread probability <strong>p</strong> = <span id="fs-p-val">0.45</span>
          <input type="range" id="fs-p" min="0.05" max="0.95" step="0.01" value="0.45" style="width:100%;margin-top:4px"/>
        </label>
        <label style="display:block;margin-top:12px;font-size:12px">
          Initial forest density <strong>ρ</strong> = <span id="fs-rho-val">0.60</span>
          <input type="range" id="fs-rho" min="0.1" max="0.95" step="0.01" value="0.60" style="width:100%;margin-top:4px"/>
        </label>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          <button type="button" id="fs-fill" style="flex:1;min-width:100px;padding:6px 10px;border-radius:5px;border:1px solid #555;background:#222;color:#ccc;cursor:pointer;font-size:12px">Fill forest</button>
          <button type="button" id="fs-clear" style="flex:1;min-width:100px;padding:6px 10px;border-radius:5px;border:1px solid #555;background:#222;color:#ccc;cursor:pointer;font-size:12px">Clear all</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button type="button" id="fs-run" style="flex:1;padding:8px 10px;border-radius:5px;border:1px solid #ff6a20;background:rgba(255,106,32,0.15);color:#ff9a60;cursor:pointer;font-size:12px;font-weight:600">Run</button>
          <button type="button" id="fs-step" style="flex:1;padding:8px 10px;border-radius:5px;border:1px solid #666;background:#2a2a32;color:#ddd;cursor:pointer;font-size:12px">Step</button>
        </div>
        <p style="font-size:10px;color:#666;margin-top:12px;line-height:1.4">
          <strong>Click</strong> a tree to ignite. <strong>Shift+click</strong> removes a tree (firebreak). Empty cells stay empty until you refill.
        </p>
        <div id="fs-stats" style="margin-top:14px;padding:10px;background:rgba(0,0,0,0.25);border-radius:6px;font-size:11px;color:#aaa;line-height:1.5"></div>
      </aside>
      <div id="fs-canvas-host" style="flex:1;position:relative;min-width:0;display:flex;align-items:center;justify-content:center;"></div>
    </div>
  `;

  const pSlider = root.querySelector('#fs-p');
  const rhoSlider = root.querySelector('#fs-rho');
  const pVal = root.querySelector('#fs-p-val');
  const rhoVal = root.querySelector('#fs-rho-val');
  const btnFill = root.querySelector('#fs-fill');
  const btnClear = root.querySelector('#fs-clear');
  const btnRun = root.querySelector('#fs-run');
  const btnStep = root.querySelector('#fs-step');
  const statsEl = root.querySelector('#fs-stats');

  let grid = new Uint8Array(COLS * ROWS);
  let pSpread = 0.45;
  let rho = 0.6;

  function randFill() {
    grid.fill(S.EMPTY);
    for (let i = 0; i < grid.length; i++) {
      if (Math.random() < rho) grid[i] = S.TREE;
    }
  }

  function clearAll() {
    grid.fill(S.EMPTY);
  }

  function stepFireSweep() {
    const next = new Uint8Array(grid);
    const ignitions = [];

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const idx = r * COLS + c;
        if (grid[idx] !== S.BURNING) continue;

        for (const [dr, dc] of D8) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
          const nidx = nr * COLS + nc;
          if (grid[nidx] !== S.TREE) continue;
          if (Math.random() < pSpread) ignitions.push(nidx);
        }
      }
    }

    const igniteSet = new Set(ignitions);

    for (let i = 0; i < grid.length; i++) {
      if (grid[i] === S.BURNING) next[i] = S.BURNED;
    }
    for (const ix of igniteSet) {
      if (next[ix] === S.BURNED) continue;
      next[ix] = S.BURNING;
    }

    grid = next;
  }

  function countStats() {
    let t = 0, b = 0, f = 0, e = 0;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] === S.TREE) t++;
      else if (grid[i] === S.BURNING) b++;
      else if (grid[i] === S.BURNED) f++;
      else e++;
    }
    return { t, b, f, e };
  }

  function updateStats() {
    const { t, b, f } = countStats();
    const burnedFrac = t + b + f > 0 ? f / (t + b + f) : 0;
    statsEl.innerHTML = `
      Trees: <span style="color:#6ab04c">${t}</span> ·
      Burning: <span style="color:#ff6b35">${b}</span> ·
      Burned: <span style="color:#3d2a22">${f}</span><br/>
      Burned / (forest) ≈ ${(burnedFrac * 100).toFixed(1)}%
    `;
  }

  pSlider.addEventListener('input', () => {
    pSpread = Number(pSlider.value);
    pVal.textContent = pSpread.toFixed(2);
  });
  rhoSlider.addEventListener('input', () => {
    rho = Number(rhoSlider.value);
    rhoVal.textContent = rho.toFixed(2);
  });

  btnFill.addEventListener('click', () => {
    randFill();
    _p5Inst?.redraw?.();
    updateStats();
  });
  btnClear.addEventListener('click', () => {
    clearAll();
    _p5Inst?.redraw?.();
    updateStats();
  });
  btnRun.addEventListener('click', () => {
    _running = !_running;
    btnRun.textContent = _running ? 'Pause' : 'Run';
    btnRun.style.background = _running ? 'rgba(255,106,32,0.35)' : 'rgba(255,106,32,0.15)';
  });
  btnStep.addEventListener('click', () => {
    stepFireSweep();
    _p5Inst?.redraw?.();
    updateStats();
  });

  randFill();

  const sketch = (p) => {
    let cell = 8;

    p.setup = () => {
      const host = document.getElementById('fs-canvas-host');
      const w = host.clientWidth || 600;
      const h = host.clientHeight || 500;
      cell = Math.max(4, Math.floor(Math.min(w / COLS, h / ROWS)));
      const cw = COLS * cell;
      const ch = ROWS * cell;
      p.createCanvas(cw, ch).parent('fs-canvas-host');
      updateStats();
    };

    p.windowResized = () => {
      const host = document.getElementById('fs-canvas-host');
      if (!host) return;
      const w = host.clientWidth;
      const h = host.clientHeight;
      cell = Math.max(4, Math.floor(Math.min(w / COLS, h / ROWS)));
      p.resizeCanvas(COLS * cell, ROWS * cell);
    };

    p.draw = () => {
      p.background(12, 14, 18);

      if (_running) {
        _tickAccum += 1;
        if (_tickAccum >= 2) {
          _tickAccum = 0;
          stepFireSweep();
          updateStats();
        }
      }

      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const v = grid[r * COLS + c];
          if (v === S.EMPTY) p.fill(22, 24, 30);
          else if (v === S.TREE) p.fill(45, 110, 55);
          else if (v === S.BURNING) {
            const flick = 0.75 + 0.25 * Math.sin(p.frameCount * 0.25 + r * 0.2 + c * 0.15);
            p.fill(Math.floor(200 + 55 * flick), Math.floor(60 + 80 * flick), 25);
          } else p.fill(35, 28, 22);

          p.noStroke();
          p.rect(c * cell, r * cell, cell + 0.5, cell + 0.5);
        }
      }

      p.noFill();
      p.stroke(255, 255, 255, 35);
      p.strokeWeight(1);
      for (let x = 0; x <= COLS; x += 8) {
        p.line(x * cell, 0, x * cell, ROWS * cell);
      }
      for (let y = 0; y <= ROWS; y += 8) {
        p.line(0, y * cell, COLS * cell, y * cell);
      }
    };

    p.mousePressed = () => {
      const mx = p.mouseX;
      const my = p.mouseY;
      if (mx < 0 || my < 0 || mx >= p.width || my >= p.height) return;
      const c = Math.floor(mx / cell);
      const r = Math.floor(my / cell);
      const idx = r * COLS + c;
      if (p.keyIsDown(p.SHIFT)) {
        grid[idx] = S.EMPTY;
      } else {
        if (grid[idx] === S.TREE) grid[idx] = S.BURNING;
      }
      updateStats();
    };
  };

  _p5Inst = new p5(sketch);
}

/** Call when the FireSweep tab becomes visible so the canvas resizes. */
export function onFireSweepTabActivated() {
  window.dispatchEvent(new Event('resize'));
}
