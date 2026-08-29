/**
 * build.js — packs the ES-module source into one self-contained HTML file.
 *
 * No bundler dependency: the modules are authored to concatenate cleanly
 * (unique top-level names, single-line imports, no default exports), so the
 * build strips import/export syntax and joins them in dependency order. It
 * verifies that assumption every run and fails loudly on a name collision.
 *
 *   node tools/build.js
 *   -> dist/nova-lance.html   (three.js from cdnjs, everything else inline)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const THREE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js';

/** Dependency order — modules only reference names defined above them. */
const ORDER = [
  'src/core/util.js',
  'src/core/save.js',
  'src/core/audio.js',
  'src/core/input.js',
  'src/render/textures.js',
  'src/render/materials.js',
  'src/render/models.js',
  'src/render/renderer.js',
  'src/render/camera.js',
  'src/render/particles.js',
  'src/render/vfx.js',
  'src/render/world.js',
  'src/systems/ships.js',
  'src/systems/upgrades.js',
  'src/entities/enemies.js',
  'src/entities/projectiles.js',
  'src/entities/player.js',
  'src/entities/pickups.js',
  'src/entities/bosses.js',
  'src/systems/waves.js',
  'src/ui/ui.js',
  'src/game.js',
  'src/main.js',
];

const IMPORT_ONE_LINE = /^\s*import\s+[^;]*?from\s+['"][^'"]+['"];?\s*$/;
const IMPORT_START = /^\s*import\s/;
const IMPORT_END = /from\s+['"][^'"]+['"];?\s*$/;
const EXPORT_RE = /^export\s+(?=(const|let|var|function|class|async))/;
const EXPORT_LIST_RE = /^export\s*\{[^}]*\}\s*;?\s*$/;
const DECL_RE = /^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/;

function processModule(rel) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const out = [];
  const decls = [];
  const lines = src.split('\n');
  let inImport = false;
  for (const line of lines) {
    if (inImport) {                       // consume a wrapped import statement
      if (IMPORT_END.test(line)) inImport = false;
      continue;
    }
    if (IMPORT_ONE_LINE.test(line)) continue;
    if (IMPORT_START.test(line)) { inImport = !IMPORT_END.test(line); continue; }
    if (EXPORT_LIST_RE.test(line)) continue;
    if (/^export\s+default/.test(line)) throw new Error(`${rel}: default exports are not supported`);
    const stripped = line.replace(EXPORT_RE, '');
    const m = DECL_RE.exec(stripped);
    if (m) decls.push(m[1]);              // column-0 declarations are module scope
    out.push(stripped);
  }
  if (inImport) throw new Error(`${rel}: unterminated import statement`);
  return { code: out.join('\n'), decls };
}

/**
 * The Artifact host supplies its own <!doctype>/<head>/<body> skeleton, so the
 * artifact build emits page *content* only: title, style, markup, scripts.
 * The webfont is attached from script rather than a `media/onload` link so no
 * inline event attribute is needed and nothing blocks first paint.
 */
function buildArtifact(chunks, css, html) {
  const bodyStart = html.indexOf('<body>') + '<body>'.length;
  const bodyEnd = html.indexOf('<script src="vendor/three.min.js">');
  const markup = html.slice(bodyStart, bodyEnd).trim();

  const fontLoader = `
(function attachDisplayFont(){
  try {
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600;700&family=Rajdhani:wght@500;600;700&display=swap';
    document.head.appendChild(l);
  } catch (e) { /* the CSS fallback stack covers this */ }
})();`;

  const out = [
    '<title>NOVA LANCE</title>',
    `<style>\n${css}\n</style>`,
    markup,
    `<script src="${THREE_CDN}"></script>`,
    `<script>\n"use strict";\n${fontLoader}\n(function(){\n${chunks.join('\n')}\n})();\n</script>`,
  ].join('\n');

  const outPath = join(ROOT, 'dist', 'nova-lance.artifact.html');
  writeFileSync(outPath, out);
  console.log(`✓ dist/nova-lance.artifact.html  (${(Buffer.byteLength(out) / 1024).toFixed(1)} KB, host-wrapped page content)`);
  return outPath;
}

function build() {
  const seen = new Map();
  const chunks = [];
  for (const rel of ORDER) {
    const { code, decls } = processModule(rel);
    for (const d of decls) {
      if (seen.has(d)) {
        throw new Error(`duplicate top-level name "${d}" in ${rel} (already declared in ${seen.get(d)})`);
      }
      seen.set(d, rel);
    }
    chunks.push(`\n// ===== ${rel} ${'='.repeat(Math.max(0, 60 - rel.length))}\n${code}`);
  }

  const css = readFileSync(join(ROOT, 'src/ui/style.css'), 'utf8');
  let html = readFileSync(join(ROOT, 'index.html'), 'utf8');

  html = html.replace('<link rel="stylesheet" href="src/ui/style.css" />', `<style>\n${css}\n</style>`);
  html = html.replace('<script src="vendor/three.min.js"></script>', `<script src="${THREE_CDN}"></script>`);
  html = html.replace(
    '<script type="module" src="src/main.js"></script>',
    `<script>\n"use strict";\n(function(){\n${chunks.join('\n')}\n})();\n</script>`,
  );

  const banner = `<!--\n  NOVA LANCE — single-file build\n  Generated by tools/build.js from the ES module sources in src/.\n  Every asset (geometry, textures, audio) is produced procedurally at runtime.\n-->\n`;
  html = banner + html;

  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  const outPath = join(ROOT, 'dist', 'nova-lance.html');
  writeFileSync(outPath, html);

  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`✓ dist/nova-lance.html  (${kb} KB, ${ORDER.length} modules, ${seen.size} top-level names)`);

  buildArtifact(chunks, css, readFileSync(join(ROOT, 'index.html'), 'utf8'));
  return outPath;
}

build();
