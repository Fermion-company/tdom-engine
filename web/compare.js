// Side-by-side compare page for the TDOM Engine.
//
//   left  — the REAL PDF: a full 2-pass lualatex compile of the current
//           source (server /pdf endpoint), rendered by pdf.js.
//   right — the ENGINE pseudo-PDF: the live display lists (server /doc),
//           drawn exactly as the main preview does (SVG glyph runs + chunk
//           image overlays), and kept live over SSE.
//
// The whole point of the project is that these two are the same picture; this
// page lets you see it. Both columns render their pages at one shared width
// (--page-w) so a page on the left sits pixel-for-pixel over the same page on
// the right.

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

function renderEngine(pages) {
  engineScroll.innerHTML = '';
  if (!pages?.length) {
    engineScroll.innerHTML = '<div class="cmp-empty">ページがありません</div>';
    return;
  }
  for (const dl of pages) engineScroll.appendChild(enginePage(dl));
}

async function loadEngine() {
  const doc = await fetch('/doc').then((r) => r.json());
  geometry = doc.geometry;
  backend = doc.backend ?? 'internal';
  backendTag.textContent = `TDOMエンジン (${backend})`;
  injectFonts(doc.fonts);
  applyPageWidth();
  renderEngine(doc.pages);
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

async function renderReal() {
  realScroll.innerHTML = '<div class="cmp-empty">本物のPDFをlualatexでコンパイル中…</div>';
  status('lualatex フルコンパイル中…');
  let buf;
  try {
    const resp = await fetch('/pdf');
    if (!resp.ok) throw new Error(`/pdf → ${resp.status}`);
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
    status(`本物のPDF: ${pdf.numPages} ページを描画しました`);
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
document.getElementById('cmp-recompile').addEventListener('click', renderReal);

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
    if (msg.kind === 'update' || msg.kind === 'patches' || msg.kind === 'reset') {
      loadEngine().then(() => {
        status('右（擬似PDF）を更新しました — 本物のPDFは「再生成」で更新');
      });
    }
  } catch { /* ignore */ }
};

// --------------------------------------------------------------------- boot

(async () => {
  await loadEngine();
  await renderReal();
})();
