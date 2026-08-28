/**
 * main.js — entry point. Boots the game, wires the debug surface used by the
 * automated playtests, and fails loudly (but gracefully) if WebGL is missing.
 */
import { Game } from './game.js';

function fatal(title, detail) {
  const boot = document.getElementById('boot');
  if (boot) {
    boot.innerHTML = `<div class="boot-inner"><div class="boot-logo">NOVA<span>LANCE</span></div>
      <div class="boot-status" style="color:#ff4d5e;max-width:44ch;line-height:1.6">${title}<br><span style="color:#8ea6c4">${detail || ''}</span></div></div>`;
    boot.setAttribute('data-active', '1');
  }
  console.error('[nova-lance]', title, detail);
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) {
    return false;
  }
}

async function main() {
  if (typeof THREE === 'undefined') {
    fatal('Renderer library failed to load.', 'Check your connection and reload.');
    return;
  }
  if (!hasWebGL()) {
    fatal('WebGL is not available in this browser.', 'Enable hardware acceleration or try a different browser.');
    return;
  }

  const canvas = document.getElementById('scene');
  const game = new Game(canvas);
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled rejection: ' + String(e.reason)));

  try {
    await game.boot((p, label) => game.ui && game.ui.setBootProgress(p, label));
  } catch (err) {
    fatal('Failed to start.', (err && err.message) || String(err));
    throw err;
  }

  const api = game.debugAPI();
  api.errors = errors;
  window.__NOVA = api;
  window.dispatchEvent(new CustomEvent('nova-ready'));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
else main();
