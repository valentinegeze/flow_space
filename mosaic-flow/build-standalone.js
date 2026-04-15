#!/usr/bin/env node
/**
 * Bundles mosaic-flow ES modules into standalone.html (single file, works from file://
 * except network features need CORS). Keeps index.html as the modular dev entry.
 *
 * Usage: node build-standalone.js
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;

const BUNDLE_ORDER = [
  'patches.js',
  'flow.js',
  'connectivity.js',
  'particles.js',
  'lbm.js',
  'fire.js',
  'sharedState.js',
  'dem.js',
  'nlcd-mapper.js',
  'state.js',
  'site-features.js',
  'parcel-analysis.js',
  'phi-panel.js',
  'zoom-panel.js',
  'ui.js',
  'soil-study.js',
  'tabs.js',
  'sketch.js',
];

function stripImports(code) {
  return code.replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?/g, '');
}

function stripExports(code) {
  return code
    .replace(/\bexport\s+const\b/g, 'const')
    .replace(/\bexport\s+async\s+function\b/g, 'async function')
    .replace(/\bexport\s+function\b/g, 'function');
}

function transformUiForBundle(code) {
  return code.replace(
    /\s*const\s*\{\s*loadDemFile\s*\}\s*=\s*await\s+import\s*\(\s*['"]\.\/dem\.js['"]\s*\)\s*;\s*/g,
    '\n'
  );
}

function readAndTransform(file) {
  let code = fs.readFileSync(path.join(DIR, file), 'utf8');
  code = stripImports(code);
  code = stripExports(code);
  if (file === 'ui.js') code = transformUiForBundle(code);
  return `\n/* ─── ${file} ─── */\n${code}`;
}

function buildBundle() {
  return BUNDLE_ORDER.map(readAndTransform).join('\n');
}

function buildStandaloneHtml() {
  const indexPath = path.join(DIR, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');

  const marker = '<!-- Main simulation sketch -->';
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error('index.html: expected marker ' + marker);

  const headPart = html.slice(0, idx + marker.length);

  const tailMatch = html.match(/<script type="module" src="\.\/sketch\.js"><\/script>[\s\S]*/);
  if (!tailMatch) throw new Error('index.html: expected sketch.js module script');

  // The bundled initTabs() from tabs.js handles tab switching + parcel init
  const tabScript = `
  <script>
    initTabs();
  </script>`;

  const bundle = buildBundle();
  const out = `${headPart}
  <script>
${bundle}
  </script>${tabScript}
</body>
</html>`;

  return out;
}

const outPath = path.join(DIR, 'standalone.html');
fs.writeFileSync(outPath, buildStandaloneHtml(), 'utf8');
console.log('Wrote', outPath, `(${Math.round(fs.statSync(outPath).size / 1024)} KB)`);
