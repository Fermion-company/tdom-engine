// Thin client for the TDOM Engine (core build).
//
// The editor sends text deltas; the viewer applies display-list patches; the
// inspector renders the engine's dirty report. All typesetting intelligence
// lives in the resident engine process — this file only draws.
//
// Every page is TWO stacked layers with a strict ranking:
//   - provisional: display-list commands (glyph runs + exact-render chunk
//     images) painted keystroke-synchronously by the resident engine;
//   - canonical: the same page as real LuaLaTeX output (/canonical/n.svg),
//     which ALWAYS wins once a compile of the current source has landed.
// An edit flips the touched pages back to provisional; the next canonical
// compile flips them to exact again. Pages the edit never touched keep
// their canonical pixels throughout. In opaque mode (safety-gate demotion)
// there is no provisional layer at all — the canonical pages are the
// display.

const editor = document.getElementById('editor');
const editorHighlightEl = document.getElementById('editor-highlight');
const pagesEl = document.getElementById('pages');
const statusEl = document.getElementById('status');
const inspectorEl = document.getElementById('inspector');
const layoutViewEl = document.getElementById('layout-view');
const templateSelectEl = document.getElementById('tpl-select');
const layoutSplitterEl = document.getElementById('workspace-preview-splitter');
const layoutEl = document.getElementById('layout');
const workspacePaneEl = document.getElementById('workspace-pane');
const previewPaneEl = document.getElementById('preview-pane');

let splitRatio = 48;

const FONT_FAMILY = {
  regular: `'Times New Roman', Times, serif`,
  italic: `'Times New Roman', Times, serif`,
  bold: `'Times New Roman', Times, serif`,
  bolditalic: `'Times New Roman', Times, serif`,
  mono: `'Courier New', Courier, monospace`,
};

let geometry = { paperwidth: 612, paperheight: 792 };
let backend = 'internal';
const loadedFonts = new Set();

let serverText = '';
let appliedRev = 0;
let composing = false;
let sending = Promise.resolve();
let debounceTimer = null;
let inFlight = false;
const history = [];
const pageDivs = new Map();

// canonical (exact LuaLaTeX) layer state — all comparisons use SOURCE
// revisions (srcRev): async repaints (TikZ chunk swaps …) advance the patch
// rev without changing the source, and must not un-freshen the canonical
let mode = 'structured'; // 'structured' | 'opaque'
let modeReasons = [];
let canonical = null; // {id, rev(srcRev), pageCount, paper, inFlight, error}
let appliedSrcRev = 0;
const pageDirtyRev = new Map(); // page -> srcRev of the last provisional patch
let lastRemoveRev = 0; // srcRev of the last provisional remove-pages patch
const docStateEl = document.getElementById('doc-state');

// ---------------------------------------------------------------- layout

function applyLayoutView(value = layoutViewEl?.value || 'both') {
  document.body.dataset.layoutView = value;
}

function applySplitRatio(value = splitRatio) {
  const workspace = Math.max(35, Math.min(70, Number(value) || splitRatio || 48));
  splitRatio = workspace;
  const { workspacePx, previewPx } = splitColumnWidths(workspace);
  document.documentElement.style.setProperty('--workspace-width', `${workspacePx}px`);
  document.documentElement.style.setProperty('--preview-width', `${previewPx}px`);
  layoutSplitterEl?.setAttribute('aria-valuenow', String(Math.round(workspace)));
}

function splitColumnWidths(workspaceRatio) {
  const layoutWidth = layoutEl?.getBoundingClientRect().width || window.innerWidth || 1;
  const splitterVisible = layoutSplitterEl && getComputedStyle(layoutSplitterEl).display !== 'none';
  const splitterWidth = splitterVisible ? layoutSplitterEl.getBoundingClientRect().width || 8 : 0;
  const available = Math.max(1, layoutWidth - splitterWidth);
  const workspacePx = Math.round((available * workspaceRatio) / 100);
  return {
    workspacePx,
    previewPx: Math.max(1, Math.round(available - workspacePx)),
  };
}

function splitRatioFromPointer(clientX) {
  if (!workspacePaneEl || !previewPaneEl) return splitRatio;
  const workspaceRect = workspacePaneEl.getBoundingClientRect();
  const previewRect = previewPaneEl.getBoundingClientRect();
  const left = workspaceRect.left;
  const right = previewRect.right;
  const total = right - left;
  if (total <= 0) return splitRatio;
  return ((clientX - left) / total) * 100;
}

function beginLayoutResize(ev) {
  if (document.body.dataset.layoutView !== 'both') return;
  ev.preventDefault();
  layoutSplitterEl?.setPointerCapture?.(ev.pointerId);
  document.body.classList.add('is-resizing-layout');
  applySplitRatio(splitRatioFromPointer(ev.clientX));

  function onPointerMove(moveEv) {
    applySplitRatio(splitRatioFromPointer(moveEv.clientX));
  }

  function finish() {
    document.body.classList.remove('is-resizing-layout');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
  }

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}

function nudgeLayoutSplit(delta) {
  applySplitRatio(splitRatio + delta);
}

// --------------------------------------------------------- editor highlight

function highlightTexSource(source) {
  if (!editorHighlightEl) return;
  const html = escapeHtml(source || '')
    .replace(/(%[^\n]*)/g, '<span class="tok-comment">$1</span>')
    .replace(/(\\(?:[A-Za-z@]+|.))/g, '<span class="tok-command">$1</span>')
    .replace(/(\{[^{}\n]*\})/g, '<span class="tok-brace">$1</span>')
    .replace(/(\$[^$\n]*\$)/g, '<span class="tok-math">$1</span>');
  editorHighlightEl.innerHTML = html + (source.endsWith('\n') ? '\n' : '');
}

// Re-highlighting rebuilds a document-sized innerHTML — on a large file
// that's tens of milliseconds. Skip when the text is unchanged (scroll
// events!) and coalesce keystroke bursts into one paint per frame.
let lastHighlighted = null;
let highlightRaf = 0;

function syncHighlightScroll() {
  // compositor-only: translating the content-sized pre avoids the layout
  // pass a scrollTop write would force on every scroll event
  editorHighlightEl.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
}

function syncEditorHighlight() {
  if (!editor || !editorHighlightEl) return;
  if (editor.value !== lastHighlighted) {
    lastHighlighted = editor.value;
    highlightTexSource(lastHighlighted);
  }
  syncHighlightScroll();
}

function scheduleHighlight() {
  if (highlightRaf) return;
  highlightRaf = requestAnimationFrame(() => {
    highlightRaf = 0;
    syncEditorHighlight();
  });
}

// -------------------------------------------------------- topbar selects

const topbarSelectMenus = new Map();

function enhanceTopbarSelect(select) {
  if (!select || topbarSelectMenus.has(select)) return;
  select.dataset.topbarEnhanced = 'true';
  select.tabIndex = -1;

  const wrap = document.createElement('div');
  wrap.className = 'topbar-select';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'topbar-select-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.title = select.title || '';
  const menu = document.createElement('div');
  menu.className = 'topbar-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  wrap.appendChild(button);
  wrap.appendChild(menu);
  select.after(wrap);

  const state = { wrap, button, menu };
  topbarSelectMenus.set(select, state);

  function close() {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function render() {
    const selected = select.selectedOptions?.[0] ?? select.options[select.selectedIndex] ?? select.options[0];
    button.textContent = selected?.textContent || select.title || '選択';
    menu.textContent = '';
    for (const option of select.options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'topbar-select-item';
      item.textContent = option.textContent;
      item.dataset.value = option.value;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', option.selected ? 'true' : 'false');
      item.disabled = option.disabled;
      item.addEventListener('click', () => {
        if (option.value === select.value && select.id !== 'tpl-select') {
          close();
          return;
        }
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        render();
        close();
      });
      menu.appendChild(item);
    }
  }

  button.addEventListener('click', (ev) => {
    ev.stopPropagation();
    for (const other of topbarSelectMenus.values()) {
      if (other !== state) {
        other.menu.hidden = true;
        other.button.setAttribute('aria-expanded', 'false');
      }
    }
    const nextHidden = !menu.hidden;
    menu.hidden = nextHidden;
    button.setAttribute('aria-expanded', nextHidden ? 'false' : 'true');
  });
  select.addEventListener('change', render);
  new MutationObserver(render).observe(select, { childList: true, subtree: true, attributes: true });
  render();
}

document.addEventListener('click', () => {
  for (const state of topbarSelectMenus.values()) {
    state.menu.hidden = true;
    state.button.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  for (const state of topbarSelectMenus.values()) {
    state.menu.hidden = true;
    state.button.setAttribute('aria-expanded', 'false');
  }
});

// ----------------------------------------------------------------- fonts

function injectFonts(keys) {
  const missing = (keys ?? []).filter((k) => !loadedFonts.has(k));
  if (!missing.length) return;
  const css = missing
    .map(
      (k) =>
        `@font-face{font-family:'${k}';src:url('/font/${encodeURIComponent(k)}');font-display:block;}`
    )
    .join('\n');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  for (const k of missing) loadedFonts.add(k);
}

// ---------------------------------------------------------------- boot

async function boot() {
  const doc = await fetch('/doc').then((r) => r.json());
  adoptDoc(doc);
  statusEl.textContent = '';
  renderInspector(doc.report, null);
}

function adoptDoc(doc) {
  geometry = doc.geometry;
  backend = doc.backend ?? 'checkpoint';
  injectFonts(doc.fonts);
  serverText = doc.source;
  editor.value = doc.source;
  syncEditorHighlight();
  pagesEl.textContent = '';
  pageDivs.clear();
  pageDirtyRev.clear();
  lastRemoveRev = 0;
  mode = doc.mode ?? 'structured';
  modeReasons = doc.modeReasons ?? [];
  canonical = doc.canonical ?? null;
  for (const dl of doc.pages) renderPage(dl, false);
  appliedRev = doc.report.rev;
  appliedSrcRev = doc.report.srcRev ?? doc.report.rev;
  // a canonical compile older than the document state cannot vouch for any
  // page — show provisional until the fresh one lands (reload after
  // convergence has canonical.rev === srcRev: exact from frame one)
  if (mode === 'structured' && canonical && canonical.rev < appliedSrcRev) {
    for (const n of pageDivs.keys()) pageDirtyRev.set(n, appliedSrcRev);
  }
  syncCanonical();
}

// ---------------------------------------------------------------- pages

function srcOf(target) {
  const src = target?.dataset?.src ?? target?.closest?.('[data-src]')?.dataset?.src;
  if (!src || src.startsWith('_')) return null;
  return src;
}

function renderPage(dl, flash) {
  let div = pageDivs.get(dl.page);
  if (!div) {
    div = document.createElement('div');
    div.className = 'page';
    div.dataset.page = dl.page;
    const no = document.createElement('span');
    no.className = 'pageno';
    no.textContent = `page ${dl.page}`;
    div.appendChild(no);
    const after = [...pageDivs.entries()].filter(([n]) => n > dl.page).sort((a, b) => a[0] - b[0])[0];
    pagesEl.insertBefore(div, after ? after[1] : null);
    pageDivs.set(dl.page, div);
  }
  // rebuild only the PROVISIONAL layers; the canonical overlay (img.canon)
  // survives provisional repaints untouched
  div.querySelector('svg')?.remove();
  div.querySelectorAll('.chunkwin').forEach((e) => e.remove());
  div.dataset.prov = '1';

  // display lists carry glyph runs -> unified SVG plus absolutely-
  // positioned <img> overlays for exact-render block chunks
  div.insertAdjacentHTML('beforeend', svgFor(dl));
  for (const cmd of dl.commands) {
    if (cmd.op !== 'chunk') continue;
    const W = geometry.paperwidth;
    const H = geometry.paperheight;
    const shiftPct = (cmd.sy / cmd.w) * 100; // margin-top % is width-relative
    div.insertAdjacentHTML(
      'beforeend',
      `<div class="chunkwin" data-src="${cmd.src}" style="left:${(cmd.x / W) * 100}%;top:${(cmd.y / H) * 100}%;width:${(cmd.w / W) * 100}%;height:${(cmd.h / H) * 100}%">` +
        `<img class="chunk" src="/chunk/${encodeURIComponent(cmd.chunk)}.svg?v=${cmd.cv ?? 0}" style="margin-top:-${shiftPct}%" draggable="false"></div>`
    );
  }

  if (flash) {
    div.classList.remove('fading');
    div.classList.add('patched');
    requestAnimationFrame(() => div.classList.add('fading'));
    setTimeout(() => div.classList.remove('patched', 'fading'), 1200);
  }
}

/** Unified SVG page: TeX-positioned glyph runs, rules, chunk images, folio. */
function svgFor(dl) {
  const parts = [
    `<svg viewBox="0 0 ${geometry.paperwidth} ${geometry.paperheight}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`,
  ];
  for (const cmd of dl.commands) {
    if (cmd.op === 'glyphs') {
      let fontAttrs;
      if (cmd.fam) {
        // checkpoint backend: real TeX font, TeX positions; disable browser
        // shaping so run-start x + font advances reproduce TeX exactly
        fontAttrs = ` font-family="${escapeXml(cmd.fam)}" style="font-kerning:none;font-variant-ligatures:none;letter-spacing:0"`;
      } else {
        const it = cmd.font === 'italic' || cmd.font === 'bolditalic' ? ` font-style="italic"` : '';
        const b = cmd.font === 'bold' || cmd.font === 'bolditalic' ? ` font-weight="bold"` : '';
        fontAttrs = ` font-family="${FONT_FAMILY[cmd.font] || FONT_FAMILY.regular}"${it}${b}`;
      }
      parts.push(
        `<text x="${cmd.x}" y="${cmd.y}" font-size="${cmd.size}"${fontAttrs} fill="${cmd.color || '#1a1a1a'}" data-src="${cmd.src}" xml:space="preserve">${escapeXml(cmd.text)}</text>`
      );
    } else if (cmd.op === 'rule') {
      parts.push(
        `<rect x="${cmd.x}" y="${cmd.y}" width="${Math.max(cmd.w, 0.1)}" height="${Math.max(cmd.h, 0.1)}" fill="${cmd.color || '#1a1a1a'}" data-src="${cmd.src}"/>`
      );
    } else if (cmd.op === 'chunk') {
      // exact-render chunks are drawn as HTML <img> overlays (see renderPage)
    } else if (cmd.op === 'folio') {
      parts.push(
        `<text x="${cmd.x}" y="${cmd.y}" font-size="10" font-family="${FONT_FAMILY.regular}" fill="#1a1a1a" text-anchor="middle">${escapeXml(cmd.text)}</text>`
      );
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

function removePagesFrom(from) {
  for (const [n, div] of [...pageDivs.entries()]) {
    if (n >= from) {
      div.remove();
      pageDivs.delete(n);
    }
  }
}

function applyReport(report) {
  if (report.rev <= appliedRev) return;
  appliedRev = report.rev;
  appliedSrcRev = report.srcRev ?? appliedSrcRev;
  setMode(report.mode ?? 'structured', report.modeReasons ?? []);
  if (report.canonical) canonical = report.canonical;
  for (const patch of report.patches) {
    if (patch.type === 'replace-page') {
      renderPage(patch.displayList, true);
      // this page now differs from the last canonical compile — provisional
      // wins here until a compile of srcRev >= this one lands
      pageDirtyRev.set(patch.displayList.page, appliedSrcRev);
      updateCanonState(patch.displayList.page);
    } else if (patch.type === 'remove-pages') {
      lastRemoveRev = appliedSrcRev;
      removePagesFrom(patch.from);
    }
  }
  updateBadge();
}

// ------------------------------------------------- canonical (exact) layer

function setMode(newMode, reasons) {
  modeReasons = reasons ?? modeReasons;
  if (newMode === mode) return;
  mode = newMode;
  if (mode === 'opaque') {
    // the provisional layers are dead weight now — every page is canonical
    for (const div of pageDivs.values()) {
      div.querySelector('svg')?.remove();
      div.querySelectorAll('.chunkwin').forEach((e) => e.remove());
      delete div.dataset.prov;
    }
    pageDirtyRev.clear();
  }
}

/** A page shell with no provisional content (canonical-only pages). */
function ensureShell(n) {
  let div = pageDivs.get(n);
  if (div) return div;
  div = document.createElement('div');
  div.className = 'page';
  div.dataset.page = n;
  if (geometry?.paperwidth && geometry?.paperheight) {
    div.style.aspectRatio = `${geometry.paperwidth} / ${geometry.paperheight}`;
  }
  const no = document.createElement('span');
  no.className = 'pageno';
  no.textContent = `page ${n}`;
  div.appendChild(no);
  const after = [...pageDivs.entries()].filter(([k]) => k > n).sort((a, b) => a[0] - b[0])[0];
  pagesEl.insertBefore(div, after ? after[1] : null);
  pageDivs.set(n, div);
  return div;
}

/** Reconcile shells + per-page overlays after a canonical compile lands. */
function syncCanonical() {
  if (canonical && canonical.id) {
    // dirty marks covered by this compile are settled: those pages are
    // exactly what LuaLaTeX printed for the current source
    for (const [n, rev] of [...pageDirtyRev]) {
      if (rev <= canonical.rev) pageDirtyRev.delete(n);
    }
    // canonical-only pages (beyond the provisional count) get shells —
    // unless a newer provisional update legitimately removed pages
    if (canonical.rev >= lastRemoveRev) {
      for (let n = 1; n <= canonical.pageCount; n++) {
        if (!pageDivs.has(n)) ensureShell(n);
      }
    }
    // canonical-only shells beyond the new page count disappear
    for (const [n, div] of [...pageDivs]) {
      if (n > canonical.pageCount && div.dataset.prov !== '1') {
        div.remove();
        pageDivs.delete(n);
      }
    }
  }
  for (const n of pageDivs.keys()) updateCanonState(n);
  updateBadge();
}

/** Decide, for one page, whether the canonical overlay wins right now. */
function updateCanonState(n) {
  const div = pageDivs.get(n);
  if (!div) return;
  const eligible =
    canonical &&
    canonical.id &&
    n <= canonical.pageCount &&
    (pageDirtyRev.get(n) ?? 0) <= canonical.rev;
  if (eligible) {
    let img = div.querySelector('img.canon');
    if (!img) {
      img = document.createElement('img');
      img.className = 'canon';
      img.loading = 'lazy'; // viewport-aware: offscreen pages convert lazily
      img.decoding = 'async';
      img.draggable = false;
      img.addEventListener('error', () => {
        // superseded compile id (or conversion hiccup): fall back to the
        // provisional layer; the next canonical event re-points the src
        delete img.dataset.src;
        img.removeAttribute('src');
        div.classList.remove('is-final');
      });
      div.appendChild(img);
    }
    const src = `/canonical/${n}.svg?c=${canonical.id}`;
    if (img.dataset.src !== src) {
      img.dataset.src = src;
      img.src = src; // in-DOM swap keeps old pixels until the new SVG decodes
    }
    div.classList.add('is-final');
  } else {
    div.classList.remove('is-final');
  }
  // a fully-fresh canonical is the page-count authority: provisional-only
  // pages beyond it are phantoms of the JS pagination and are hidden
  const phantom =
    canonical &&
    canonical.id &&
    canonical.rev >= appliedSrcRev &&
    pageDirtyRev.size === 0 &&
    n > canonical.pageCount;
  div.classList.toggle('phantom', !!phantom);
}

function updateBadge() {
  if (!docStateEl) return;
  const err = canonical?.error;
  const parts = [];
  let cls = 'state-preview';
  let text;
  if (mode === 'opaque') {
    if (canonical?.id && !canonical.inFlight && !err && canonical.rev >= appliedSrcRev) {
      cls = 'state-exact';
      text = '✓ exact — LuaLaTeX直描画';
    } else {
      text = err ? 'TeXエラー（前回の正確な表示を保持）' : 'exact fallback — コンパイル中…';
      if (err) cls = 'state-error';
    }
    parts.push(text);
  } else if (err && canonical.errorRev >= appliedSrcRev) {
    cls = 'state-error';
    parts.push('TeXエラー — 検証コンパイル失敗（プレビュー続行）');
  } else if (canonical?.id && canonical.rev >= appliedSrcRev && pageDirtyRev.size === 0 && !canonical.inFlight) {
    cls = 'state-exact';
    parts.push('✓ exact — LuaLaTeX出力と一致');
  } else {
    parts.push('preview — exactへ収束中…');
  }
  docStateEl.className = cls;
  docStateEl.textContent = parts.join(' ');
  docStateEl.title =
    (modeReasons?.length ? `opaque理由: ${modeReasons.join('; ')}\n` : '') + (err ? `TeX: ${err}` : '');
}

// ---------------------------------------------------------------- editing

function diffText(oldStr, newStr) {
  if (oldStr === newStr) return null;
  let start = 0;
  const maxStart = Math.min(oldStr.length, newStr.length);
  while (start < maxStart && oldStr[start] === newStr[start]) start++;
  let endOld = oldStr.length;
  let endNew = newStr.length;
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
    endOld--;
    endNew--;
  }
  return { start, end: endOld, text: newStr.slice(start, endNew) };
}

function scheduleSync() {
  scheduleHighlight();
  // the resident engine absorbs every keystroke: send immediately — the
  // serialized `sending` chain coalesces bursts into single diffs (in
  // opaque mode the edit is a source-apply + canonical reschedule, cheaper
  // still)
  flushSync();
}

function flushSync() {
  sending = sending.then(async () => {
    const current = editor.value;
    const d = diffText(serverText, current);
    if (!d) return;
    const t0 = performance.now();
    inFlight = true;
    try {
      const res = await fetch('/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d),
      });
      const report = await res.json();
      if (report.error) throw new Error(report.error);
      serverText = current;
      const rtt = performance.now() - t0;
      applyReport(report);
      renderInspector(report, rtt);
      const engineMs =
        report.mode === 'opaque'
          ? `opaque（canonical再コンパイル待ち）/ ${fmtUs(report.stats.totalUs)}`
          : `組版 ${report.stats.typesetMs ?? 0} ms / 全体 ${fmtUs(report.stats.totalUs)}`;
      statusEl.textContent =
        `update #${report.rev} — ${engineMs} / 往復 ${rtt.toFixed(0)} ms` +
        (report.dirtyPages.length
          ? ` / patched pages: ${report.dirtyPages.join(', ')}`
          : report.mode === 'opaque'
            ? ''
            : ' / 表示差分なし');
    } catch (err) {
      statusEl.textContent = `エラー: ${err.message}`;
    } finally {
      inFlight = false;
    }
  });
}

editor.addEventListener('compositionstart', () => (composing = true));
editor.addEventListener('compositionend', () => {
  composing = false;
  scheduleHighlight();
  scheduleSync();
});
editor.addEventListener('input', () => {
  scheduleHighlight();
  if (!composing) scheduleSync();
});
// scroll only moves the overlay — it must never re-render the highlight
editor.addEventListener('scroll', syncHighlightScroll);

// Preview interaction: Alt+click a glyph/rule jumps to the corresponding
// source in the editor — the data-src mapping is an engine feature (every
// display-list command carries its source block id).
pagesEl.addEventListener('click', async (ev) => {
  if (!ev.altKey) return;
  const src = srcOf(ev.target);
  if (!src) return;
  const dom = await fetch('/dom').then((r) => r.json());
  const block = dom.blocks.find((b) => b.id === src);
  if (!block) return;
  const offset = lineColToOffset(editor.value, block.source.start.line, block.source.start.column);
  editor.focus();
  editor.setSelectionRange(offset, offset);
  const lineTop = editor.value.slice(0, offset).split('\n').length - 1;
  editor.scrollTop = Math.max(0, lineTop * 19 - editor.clientHeight / 2);
  statusEl.textContent = `ソース対応: ${src} → main.tex:${block.source.start.line} (${block.type})`;
});

function lineColToOffset(text, line, col) {
  let off = 0;
  let l = 1;
  while (l < line) {
    const nl = text.indexOf('\n', off);
    if (nl < 0) break;
    off = nl + 1;
    l++;
  }
  return off + col - 1;
}

// ---------------------------------------------------------------- zoom

let zoom = Number(localStorage.getItem('tdom-zoom')) || 1;

function setZoom(z) {
  zoom = Math.min(3, Math.max(0.4, Math.round(z * 100) / 100));
  pagesEl.style.setProperty('--zoom', zoom);
  document.getElementById('zoom-level').textContent = Math.round(zoom * 100) + '%';
  localStorage.setItem('tdom-zoom', String(zoom));
}

document.getElementById('zoom-in').addEventListener('click', () => setZoom(zoom * 1.1));
document.getElementById('zoom-out').addEventListener('click', () => setZoom(zoom / 1.1));
document.getElementById('zoom-fit').addEventListener('click', () => setZoom(1));

// PDF-viewer convention: Ctrl/Cmd + wheel (and trackpad pinch, which the
// browser reports as a ctrlKey wheel) zooms the document. The factor is
// proportional to the wheel delta: pinch gestures emit many small deltas,
// so a fixed per-event step feels far too aggressive.
pagesEl.addEventListener(
  'wheel',
  (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    let dy = ev.deltaY;
    if (ev.deltaMode === 1) dy *= 16; // line mode -> approx pixels
    const factor = Math.min(1.25, Math.max(1 / 1.25, Math.exp(-dy * 0.0035)));
    setZoom(zoom * factor);
  },
  { passive: false }
);

setZoom(zoom);

// -------------------------------------------------------- layout controls

layoutViewEl?.addEventListener('change', () => {
  applyLayoutView(layoutViewEl.value);
  applySplitRatio();
});
enhanceTopbarSelect(layoutViewEl);
enhanceTopbarSelect(templateSelectEl);
layoutSplitterEl?.addEventListener('pointerdown', beginLayoutResize);
layoutSplitterEl?.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowLeft') {
    ev.preventDefault();
    nudgeLayoutSplit(-2);
  } else if (ev.key === 'ArrowRight') {
    ev.preventDefault();
    nudgeLayoutSplit(2);
  } else if (ev.key === 'Home') {
    ev.preventDefault();
    applySplitRatio(35);
  } else if (ev.key === 'End') {
    ev.preventDefault();
    applySplitRatio(70);
  }
});
window.addEventListener('resize', () => applySplitRatio());
applyLayoutView();
applySplitRatio();

// -------------------------------------------------------- template + buttons

async function loadTemplateList(selectedId = '') {
  try {
    const list = await fetch('/templates').then((r) => r.json());
    const sel = templateSelectEl;
    if (!sel) return;
    sel.textContent = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'テンプレート';
    sel.appendChild(placeholder);
    for (const t of list) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.custom ? `カスタム: ${t.name}` : t.name;
      opt.title = t.desc;
      sel.appendChild(opt);
    }
    const demo = document.createElement('option');
    demo.value = '__demo';
    demo.textContent = 'デモ文書';
    sel.appendChild(demo);
    sel.value = selectedId && list.some((t) => t.id === selectedId) ? selectedId : '';
  } catch {
    /* templates are optional */
  }
}

templateSelectEl?.addEventListener('change', async (ev) => {
  const id = ev.target.value;
  ev.target.value = '';
  if (!id) return;
  if (!confirm('現在の内容を破棄してテンプレートから新規作成しますか？')) return;
  const body = id === '__demo' ? '{}' : JSON.stringify({ template: id });
  const res = await fetch('/open', { method: 'POST', body });
  const doc = await res.json();
  if (doc.error) {
    statusEl.textContent = `エラー: ${doc.error}`;
    return;
  }
  adoptDoc(doc);
  history.length = 0;
  renderInspector(doc.report, null);
  statusEl.textContent = `テンプレート「${id}」から開始 — ${doc.report.stats.pageCount} pages`;
});

document.getElementById('btn-pdf').addEventListener('click', () => {
  statusEl.textContent = 'PDF生成中（canonical層から配信）…';
  window.open('/pdf', '_blank');
});

document.getElementById('btn-compare')?.addEventListener('click', () => {
  window.open('/compare', '_blank');
});

document.getElementById('btn-reset').addEventListener('click', async () => {
  const doc = await fetch('/open', { method: 'POST', body: '{}' }).then((r) => r.json());
  adoptDoc(doc);
  history.length = 0;
  renderInspector(doc.report, null);
  statusEl.textContent = 'サンプル文書に戻しました';
});

// ---------------------------------------------------------------- inspector

function fmtUs(us) {
  return us < 1000 ? `${us} µs` : `${(us / 1000).toFixed(2)} ms`;
}

function chips(list, cls = '') {
  if (!list || list.length === 0) return `<span class="chip none">—</span>`;
  const MAX = 14;
  const shown = list.slice(0, MAX).map((x) => `<span class="chip ${cls}">${escapeHtml(String(x))}</span>`);
  if (list.length > MAX) shown.push(`<span class="chip none">+${list.length - MAX}</span>`);
  return shown.join('');
}

function renderInspector(report, rtt) {
  const s = report.stats;
  const deps = report.dirtyDependencies.map((d) => `${d.kind}:${d.key} → ${d.affected.join(', ')}`);
  const phases = Object.entries(s)
    .filter(([k, v]) => k.endsWith('Us') && k !== 'totalUs' && typeof v === 'number')
    .map(([k, v]) => [k.slice(0, -2), v]);
  const maxUs = Math.max(...phases.map((p) => p[1]), 1);

  if (report.edit !== 'open') {
    history.unshift({ rev: report.rev, edit: report.edit, pages: report.dirtyPages, us: s.totalUs });
    if (history.length > 8) history.pop();
  }

  const isOpaque = (report.mode ?? mode) === 'opaque';
  const cacheRows = `
        <span class="k">ブロック総数</span><span class="v">${s.blocksTotal}</span>
        <span class="k">fork再開組版</span><span class="v">${s.blocksTypeset}</span>
        <span class="k">ブロック再利用</span><span class="v good">${s.blocksTotal - s.blocksTypeset}</span>
        <span class="k">組版時間 (実TeX)</span><span class="v good">${s.typesetMs} ms</span>
        <span class="k">常駐チェックポイント</span><span class="v">${s.checkpoints}</span>
        <span class="k">フル再構築</span><span class="v">${s.rebooted ? 'あり（プリアンブル変更）' : 'なし'}</span>
        <span class="k">ページ再利用</span><span class="v good">${s.pagesReused} / ${s.pageCount}</span>
        <span class="k">ページ再構築</span><span class="v">${s.pagesRebuilt}</span>`;

  const c = report.canonical ?? canonical ?? {};
  const verify = s.verify;
  const canonState = c.error
    ? `<span class="v" style="color:var(--warn)">TeXエラー</span>`
    : c.inFlight
      ? `<span class="v" style="color:var(--accent-2)">コンパイル中…</span>`
      : c.rev >= (report.srcRev ?? 0)
        ? `<span class="v good">✓ 現行ソースと一致</span>`
        : `<span class="v">srcRev ${c.rev} 待ち</span>`;
  const canonicalCard = `
    <div class="card">
      <h3>Canonical — LuaLaTeX exact render（最終表示の権威）</h3>
      <div class="kv">
        <span class="k">状態</span>${canonState}
        <span class="k">コンパイル済み / 現在</span><span class="v">srcRev ${c.rev ?? 0} / ${report.srcRev ?? 0}</span>
        <span class="k">実ページ数</span><span class="v">${c.pageCount ?? 0}</span>
        <span class="k">パス数 / 時間</span><span class="v">${c.passes ?? 0} / ${c.ms ?? 0} ms</span>
        ${
          verify
            ? `<span class="k">一致検証</span><span class="v ${verify.mismatches?.length ? '' : 'good'}">${
                verify.mismatches?.length
                  ? escapeHtml(verify.mismatches[0])
                  : `✓ ${verify.pagesChecked}ページ一致`
              }</span>`
            : ''
        }
      </div>
      ${c.error ? `<div class="diag">${escapeHtml(c.error)}</div>` : ''}
    </div>`;

  const opaqueCard = isOpaque
    ? `<div class="card">
        <h3>Opaque mode — exact fallback</h3>
        <div class="diag">structured層は停止中。表示はLuaLaTeX実出力のみ（編集は継続可能）。</div>
        ${(report.modeReasons ?? modeReasons ?? []).map((r) => `<div class="diag">${escapeHtml(r)}</div>`).join('')}
      </div>`
    : '';

  inspectorEl.innerHTML = `
    <div class="card">
      <div class="bigtime">${fmtUs(s.totalUs)} <span class="unit">${isOpaque ? 'opaque (canonicalのみ)' : 'checkpoint engine (常駐TeX)'}${rtt != null ? ` / 往復 ${rtt.toFixed(0)} ms` : ''}</span></div>
      <div class="editlabel">edit: ${escapeHtml(report.edit)} (rev ${report.rev} / src ${report.srcRev ?? '-'})</div>
    </div>

    ${opaqueCard}
    ${canonicalCard}

    <div class="card">
      <h3>Dirty 伝播チェーン</h3>
      <div class="chainrow"><span class="lbl">Source</span><span class="chips">${chips(report.dirtySourceNodes)}</span></div>
      <div class="chainrow"><span class="lbl">Blocks</span><span class="chips">${chips(report.dirtySemanticNodes)}</span></div>
      <div class="chainrow"><span class="lbl">Deps</span><span class="chips">${chips(deps, 'dep')}</span></div>
      <div class="chainrow"><span class="lbl">Pages</span><span class="chips">${chips(report.dirtyPages.map((p) => 'page ' + p), 'page')}</span></div>
      <div class="chainrow"><span class="lbl">Patches</span><span class="chips">${chips(report.patches.map((p) => (p.type === 'replace-page' ? `replace p${p.page}` : `${p.type} ${p.from ?? ''}`)), 'page')}</span></div>
    </div>

    <div class="card">
      <h3>キャッシュ / 再利用</h3>
      <div class="kv">${cacheRows}</div>
    </div>

    <div class="card">
      <h3>フェーズ別時間</h3>
      <div class="bars">
        ${phases
          .map(
            ([n, us]) => `
          <div class="bar">
            <span class="n">${n}</span>
            <span class="track"><span class="fill" style="width:${Math.max(2, (us / maxUs) * 100)}%"></span></span>
            <span class="t">${fmtUs(us)}</span>
          </div>`
          )
          .join('')}
      </div>
    </div>

    ${
      (s.macrosChanged?.length || s.labelsChanged?.length)
        ? `<div class="card"><h3>依存グラフ差分</h3>
           <div class="chainrow"><span class="lbl">macros</span><span class="chips">${chips((s.macrosChanged ?? []).map((m) => '\\' + m), 'dep')}</span></div>
           <div class="chainrow"><span class="lbl">labels</span><span class="chips">${chips(s.labelsChanged ?? [], 'dep')}</span></div></div>`
        : ''
    }

    ${
      s.diagnostics?.length
        ? `<div class="card"><h3>診断</h3>${s.diagnostics
            .slice(0, 6)
            .map((d) => `<div class="diag">${escapeHtml(d)}</div>`)
            .join('')}</div>`
        : ''
    }

    ${
      history.length
        ? `<div class="card"><h3>履歴</h3><div class="hist">${history
            .map(
              (h) =>
                `<div><b>#${h.rev}</b><span>${escapeHtml(shortEdit(h.edit))}</span><span>p[${h.pages.join(',')}]</span><span class="t">${fmtUs(h.us)}</span></div>`
            )
            .join('')}</div></div>`
        : ''
    }
  `;
}

function shortEdit(edit) {
  return edit.replace('main.tex:', '');
}

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}
function escapeHtml(s) {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
}

// ---------------------------------------------------------------- SSE

const sse = new EventSource('/events');
sse.onmessage = (ev) => {
  try {
    const msg = JSON.parse(ev.data);
    if (msg.kind === 'canonical') {
      // a real-lualatex compile landed: converge every covered page to it
      canonical = msg.canonical;
      if (msg.mode) setMode(msg.mode, modeReasons);
      syncCanonical();
      return;
    }
    if (msg.kind === 'patches') {
      // async arrivals (TikZ exact renders, background chain discoveries):
      // the SOURCE is unchanged, so canonical stays authoritative — no
      // dirty marks, but re-evaluate each repainted page's overlay state
      if (msg.rev > appliedRev) {
        appliedRev = msg.rev;
        for (const patch of msg.patches) {
          if (patch.type === 'replace-page') {
            renderPage(patch.displayList, true);
            updateCanonState(patch.displayList.page);
          } else if (patch.type === 'remove-pages') {
            removePagesFrom(patch.from);
          }
        }
      }
      return;
    }
    if (msg.kind === 'update' && msg.report.rev > appliedRev) {
      applyReport(msg.report);
      renderInspector(msg.report, null);
      fetch('/doc')
        .then((r) => r.json())
        .then((doc) => {
          if (doc.report.rev === appliedRev && editor.value !== doc.source && document.activeElement !== editor) {
            serverText = doc.source;
            editor.value = doc.source;
            syncEditorHighlight();
          }
        });
    } else if (msg.kind === 'reset') {
      if (document.activeElement !== editor) boot();
    }
  } catch {
    /* ignore malformed events */
  }
};

// collapsible inspector (preference persists)
function setInspector(hidden) {
  document.body.classList.toggle('no-inspector', hidden);
  localStorage.setItem('tdom-inspector', hidden ? 'hidden' : 'shown');
}
document.getElementById('insp-toggle').addEventListener('click', () => setInspector(true));
document.getElementById('insp-reopen').addEventListener('click', () => setInspector(false));
setInspector(localStorage.getItem('tdom-inspector') === 'hidden');

boot();
loadTemplateList();
