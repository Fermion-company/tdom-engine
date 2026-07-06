// Side-by-side compare page for the TDOM Engine — the provisional layer's
// referee.
//
//   left  — CANONICAL: the real LuaLaTeX output, byte-identical to what the
//           main preview converges to (/canonical.pdf, auto-refreshed on
//           every canonical SSE event; falls back to /pdf when no compile
//           has landed yet), rendered by pdf.js.
//   right — PROVISIONAL: the live display lists (server /doc), drawn from
//           glyph runs + chunk overlays and kept live over SSE. This is the
//           only place the provisional layer is still visible — the main
//           preview hides it under the canonical render once fresh.
//
// In the two-truth architecture the left column is the authority and the
// right column is the fast approximation; this page shows how close the
// approximation runs. Both columns render at one shared width (--page-w) so
// page N sits pixel-for-pixel over page N.

import * as pdfjsLib from '/pdfjs/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

const FONT_FAMILY = {
  regular: `'Times New Roman', Times, serif`,
  italic: `'Times New Roman', Times, serif`,
  bold: `'Times New Roman', Times, serif`,
  bolditalic: `'Times New Roman', Times, serif`,
  mono: `'Courier New', Courier, monospace`,
};

const realScroll = document.getElementById('cmp-real');
const engineScroll = document.getElementById('cmp-engine');
const statusEl = document.getElementById('cmp-status');
const backendTag = document.getElementById('cmp-engine-backend');
const syncEl = document.getElementById('cmp-sync');
const zoomLevelEl = document.getElementById('cmp-zoom-level');

let geometry = { paperwidth: 612, paperheight: 792 };
let backend = 'internal';
const loadedFonts = new Set();
let zoom = 1;
let realPages = []; // { page, canvas, baseViewport }
let repaintTimer = null;

function status(msg) { statusEl.textContent = msg; }

// ------------------------------------------------------------- shared sizing

function columnInnerWidth() {
  return engineScroll.clientWidth - 40; // matches the 20px side padding
}
function pageWidthPx() {
  const fit = Math.max(160, columnInnerWidth());
  return Math.round(fit * zoom);
}
function applyPageWidth() {
  document.documentElement.style.setProperty('--page-w', pageWidthPx() + 'px');
  zoomLevelEl.textContent = Math.round(zoom * 100) + '%';
}

// ------------------------------------------------------------- engine (right)

function injectFonts(keys) {
  const missing = (keys ?? []).filter((k) => !loadedFonts.has(k));
  if (!missing.length) return;
  const css = missing
    .map((k) => `@font-face{font-family:'${k}';src:url('/font/${encodeURIComponent(k)}');font-display:block;}`)
    .join('\n');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  for (const k of missing) loadedFonts.add(k);
}

function escapeXml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// Identical to the main preview's svgFor(): TeX-positioned glyph runs, rules,
// folio. Chunk images are drawn as HTML overlays (see enginePage).
function svgFor(dl) {
  const parts = [
    `<svg viewBox="0 0 ${geometry.paperwidth} ${geometry.paperheight}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`,
  ];
  for (const cmd of dl.commands) {
    if (cmd.op === 'glyphs') {
      let fontAttrs;
      if (cmd.fam) {
        fontAttrs = ` font-family="${escapeXml(cmd.fam)}" style="font-kerning:none;font-variant-ligatures:none;letter-spacing:0"`;
      } else {
        const it = cmd.font === 'italic' || cmd.font === 'bolditalic' ? ` font-style="italic"` : '';
        const b = cmd.font === 'bold' || cmd.font === 'bolditalic' ? ` font-weight="bold"` : '';
        fontAttrs = ` font-family="${FONT_FAMILY[cmd.font] || FONT_FAMILY.regular}"${it}${b}`;
      }
      parts.push(
        `<text x="${cmd.x}" y="${cmd.y}" font-size="${cmd.size}"${fontAttrs} fill="${cmd.color || '#1a1a1a'}" xml:space="preserve">${escapeXml(cmd.text)}</text>`
      );
    } else if (cmd.op === 'rule') {
      parts.push(
        `<rect x="${cmd.x}" y="${cmd.y}" width="${Math.max(cmd.w, 0.1)}" height="${Math.max(cmd.h, 0.1)}" fill="${cmd.color || '#1a1a1a'}"/>`
      );
    } else if (cmd.op === 'folio') {
      parts.push(
        `<text x="${cmd.x}" y="${cmd.y}" font-size="10" font-family="${FONT_FAMILY.regular}" fill="#1a1a1a" text-anchor="middle">${escapeXml(cmd.text)}</text>`
      );
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

function enginePage(dl) {
  const wrap = document.createElement('div');
  wrap.className = 'cmp-page';
  wrap.dataset.page = dl.page;
  const no = document.createElement('span');
  no.className = 'cmp-pageno';
  no.textContent = `page ${dl.page}`;
  wrap.appendChild(no);
  wrap.insertAdjacentHTML('beforeend', svgFor(dl));
  const W = geometry.paperwidth;
  const H = geometry.paperheight;
  for (const cmd of dl.commands) {
    if (cmd.op !== 'chunk') continue;
    const shiftPct = (cmd.sy / cmd.w) * 100; // margin-top % is width-relative
    wrap.insertAdjacentHTML(
      'beforeend',
      `<div class="chunkwin" style="left:${(cmd.x / W) * 100}%;top:${(cmd.y / H) * 100}%;width:${(cmd.w / W) * 100}%;height:${(cmd.h / H) * 100}%">` +
        `<img class="chunk" src="/chunk/${encodeURIComponent(cmd.chunk)}.svg?v=${cmd.cv ?? 0}" style="margin-top:-${shiftPct}%" draggable="false"></div>`
    );
  }
  return wrap;
}

function renderEngine(pages, mode) {
  engineScroll.innerHTML = '';
  if (mode === 'opaque') {
    engineScroll.innerHTML =
      '<div class="cmp-empty">opaqueモード: この文書はstructured層の対象外です<br>' +
      '(safety gateによるexact fallback)。provisional層は存在せず、<br>' +
      'メインプレビューは左と同じLuaLaTeX実出力を表示しています。</div>';
    return;
  }
  if (!pages?.length) {
    engineScroll.innerHTML = '<div class="cmp-empty">ページがありません</div>';
    return;
  }
  for (const dl of pages) engineScroll.appendChild(enginePage(dl));
}

async function loadEngine() {
  const doc = await fetch('/doc').then((r) => r.json());
  geometry = doc.geometry;
  backend = doc.backend ?? 'checkpoint';
  backendTag.textContent = doc.mode === 'opaque' ? 'opaqueモード (exact fallback)' : `provisional層 (${backend})`;
  injectFonts(doc.fonts);
  applyPageWidth();
  renderEngine(doc.pages, doc.mode);
}

// -------------------------------------------------------------- real (left)

async function paintRealPage(entry) {
  const { page, canvas } = entry;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssWidth = pageWidthPx();
  const scale = (cssWidth / entry.baseViewport.width) * dpr;
  const viewport = page.getViewport({ scale });
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
}

let realBusy = false;

/**
 * Paint the left column.
 * force=false: serve the last LANDED canonical compile (/canonical.pdf,
 * instant, never triggers a compile) — used at boot and on canonical SSE
 * events, so the left column always mirrors the main preview's authority.
 * force=true: compile the newest source now (/pdf) — the manual button.
 */
async function renderReal(force = false) {
  if (realBusy) return;
  realBusy = true;
  try {
    await renderRealInner(force);
  } finally {
    realBusy = false;
  }
}

async function renderRealInner(force) {
  if (force) {
    realScroll.innerHTML = '<div class="cmp-empty">本物のPDFをlualatexでコンパイル中…</div>';
    status('lualatex コンパイル中…');
  }
  let buf;
  try {
    let resp = force ? await fetch('/pdf') : await fetch('/canonical.pdf');
    if (!force && resp.status === 404) {
      // no canonical compile has landed yet (fresh boot): compile one
      realScroll.innerHTML = '<div class="cmp-empty">本物のPDFをlualatexでコンパイル中…</div>';
      status('canonical未着 — lualatex コンパイル中…');
      resp = await fetch('/pdf');
    }
    if (!resp.ok) throw new Error(`${resp.url.split('/').pop()} → ${resp.status}`);
    buf = await resp.arrayBuffer();
  } catch (err) {
    realScroll.innerHTML = `<div class="cmp-empty">本物のPDFを取得できませんでした<br>${escapeXml(err.message)}<br><br>lualatex が必要です。</div>`;
    status('本物のPDFの取得に失敗');
    return;
  }
  try {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    realScroll.innerHTML = '';
    realPages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const wrap = document.createElement('div');
      wrap.className = 'cmp-page';
      const no = document.createElement('span');
      no.className = 'cmp-pageno';
      no.textContent = `page ${i}`;
      const canvas = document.createElement('canvas');
      wrap.append(no, canvas);
      realScroll.appendChild(wrap);
      const entry = { page, canvas, baseViewport: page.getViewport({ scale: 1 }) };
      realPages.push(entry);
      await paintRealPage(entry);
    }
    status(`canonical (本物のLuaLaTeX出力): ${pdf.numPages} ページを描画しました`);
  } catch (err) {
    realScroll.innerHTML = `<div class="cmp-empty">pdf.js の描画に失敗しました<br>${escapeXml(err.message)}</div>`;
    status('pdf.js 描画エラー');
  }
}

function repaintRealSoon() {
  clearTimeout(repaintTimer);
  repaintTimer = setTimeout(() => { for (const e of realPages) paintRealPage(e); }, 120);
}

// ------------------------------------------------------------------- zoom

function setZoom(z) {
  zoom = Math.min(3, Math.max(0.4, Math.round(z * 100) / 100));
  applyPageWidth();
  repaintRealSoon();
}
document.getElementById('cmp-zoom-in').addEventListener('click', () => setZoom(zoom * 1.1));
document.getElementById('cmp-zoom-out').addEventListener('click', () => setZoom(zoom / 1.1));
document.getElementById('cmp-zoom-fit').addEventListener('click', () => setZoom(1));
document.getElementById('cmp-recompile').addEventListener('click', () => renderReal(true));

// ---------------------------------------------------------------- sync scroll

let syncing = false;
function mirror(from, to) {
  if (!syncEl.checked || syncing) return;
  syncing = true;
  // Both columns render the same pages at the same width, so a direct
  // scrollTop copy keeps page N aligned with page N (clamped if one side is
  // shorter). Proportional mapping would drift on any height difference.
  to.scrollTop = from.scrollTop;
  requestAnimationFrame(() => { syncing = false; });
}
realScroll.addEventListener('scroll', () => mirror(realScroll, engineScroll));
engineScroll.addEventListener('scroll', () => mirror(engineScroll, realScroll));

window.addEventListener('resize', () => { applyPageWidth(); repaintRealSoon(); });

// ---------------------------------------------------------------------- SSE

const sse = new EventSource('/events');
sse.onmessage = (ev) => {
  try {
    const msg = JSON.parse(ev.data);
    if (msg.kind === 'canonical') {
      // a fresh canonical compile landed: the left column can mirror it
      // instantly (no compile — /canonical.pdf serves the landed bytes)
      if (msg.canonical?.error) {
        status(`TeXエラー — 左は前回のcanonicalを保持: ${msg.canonical.error}`);
      } else {
        renderReal(false);
      }
      return;
    }
    if (msg.kind === 'update' || msg.kind === 'patches' || msg.kind === 'reset') {
      loadEngine().then(() => {
        status('右（provisional層）を更新しました — 左はcanonical着地時に自動更新');
      });
    }
  } catch { /* ignore */ }
};

// --------------------------------------------------------------------- boot

(async () => {
  await loadEngine();
  await renderReal();
})();
